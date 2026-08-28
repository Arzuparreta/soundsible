"""
Disk cache + background prefetch for preview audio streams.

Previews (tracks played before they are downloaded into the library) are
acquired from the YouTube CDN by `/api/preview/stream/<video_id>`. Two pieces
live here to make that path fast and deterministic:

- Single-flight acquisition: every caller for one video id joins one open-ended
  upstream download. Ordinary songs start from the committed local file. A
  longer transfer may start from the same growing local spool only after its
  prefix, buffer and transfer rate are proven viable; browser ranges never
  become additional CDN requests.
- Prefetch worker: a single background thread that resolves stream URLs
  (and optionally downloads the whole file into the cache) for tracks the
  user is *about* to play — next in queue, top search results — so a click
  never pays the yt-dlp resolution latency.

The cache is size-capped LRU by mtime (committed files are touched on read).
``SOUNDSIBLE_PREVIEW_CACHE_MB`` overrides the cap; ``0`` disables disk
caching entirely (prefetch then only warms the stream-URL cache).
"""

from __future__ import annotations

import json
import logging
import math
import os
import queue
import re
import subprocess
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional, Union
from urllib.parse import parse_qs, urlparse

import requests

from shared.runtime import get_cache_dir
from shared.stream_resolution import ResolvedStream, resolved_stream

logger = logging.getLogger(__name__)

DEFAULT_CACHE_LIMIT_MB = 2048
AUDIO_SUFFIX = ".audio"
META_SUFFIX = ".meta.json"
PART_SUFFIX = ".part"
FLAT_MP4_LAYOUT = "flat_mp4_v1"
SOURCE_LAYOUT = "source_v1"
# Abandoned .part files (crash, dropped client) older than this are swept.
STALE_PART_SEC = 3600

_writers_lock = threading.Lock()
_active_writers: set[str] = set()
_normalizers_lock = threading.Lock()
_normalizers: dict[str, threading.Lock] = {}


class PreviewUpstreamRejected(Exception):
    """The CDN refused a signed preview URL and it must be re-resolved."""

    def __init__(self, status_code: int):
        super().__init__(f"preview upstream returned HTTP {status_code}")
        self.status_code = status_code


class PreviewFillCancelled(Exception):
    """An unobserved speculative/current fill yielded the one upstream lane."""


_PROGRESSIVE_FAST_COMPLETE_SEC = 5.0
_PROGRESSIVE_MIN_BUFFER_SEC = 6.0
_PROGRESSIVE_RATE_MARGIN = 1.25


class _FillState:
    """One upstream transfer and the growing local spool shared by its readers."""

    def __init__(self, video_id: str = ""):
        self.video_id = video_id
        self.done = threading.Event()
        self.condition = threading.Condition()
        self.error: BaseException | None = None
        self.cancel = threading.Event()
        self.started_at = time.monotonic()
        self.rate_samples: list[tuple[float, int]] = [(self.started_at, 0)]
        self.downloaded_bytes = 0
        self.total_bytes: int | None = None
        self.duration_seconds: float | None = None
        self.content_type = "audio/mpeg"
        self.stream: ResolvedStream | None = None
        self.streamable = False
        self.prefix_checked = False
        self.next_prefix_check_at = 0.0
        self.progressive_requested = False
        self.readers = 0
        self.keep_warm = False

    def update(self, downloaded: int) -> None:
        with self.condition:
            self.downloaded_bytes = downloaded
            now = time.monotonic()
            self.rate_samples.append((now, downloaded))
            self.rate_samples = self.rate_samples[-32:]
            self.condition.notify_all()

    def start_transfer(self) -> None:
        with self.condition:
            self.started_at = time.monotonic()
            self.rate_samples = [(self.started_at, self.downloaded_bytes)]

    def sustained_rate(self, window_seconds: float = 5.0) -> float:
        """Bytes/sec actually sustained over the recent transfer window."""
        now = time.monotonic()
        with self.condition:
            samples = list(self.rate_samples)
            if len(samples) < 2:
                return 0.0
            cutoff = now - window_seconds
            before = [sample for sample in samples if sample[0] <= cutoff]
            started_at, started_bytes = before[-1] if before else samples[0]
            elapsed = now - started_at
            if elapsed <= 0:
                return 0.0
            return max(0.0, (self.downloaded_bytes - started_bytes) / elapsed)

    def finish(self, error: BaseException | None = None) -> None:
        with self.condition:
            self.error = error
            self.done.set()
            self.condition.notify_all()

    def facts(self) -> dict[str, object]:
        rate = self.sustained_rate()
        total = self.total_bytes
        duration = self.duration_seconds
        progress = min(1.0, self.downloaded_bytes / total) if total else None
        buffered = None
        if total and duration and duration > 0:
            buffered = min(duration, self.downloaded_bytes * duration / total)
        eta = None
        if total and rate > 0:
            eta = max(0.0, (total - self.downloaded_bytes) / rate)
        result: dict[str, object] = {"downloaded_bytes": self.downloaded_bytes}
        if total is not None:
            result["total_bytes"] = total
        if progress is not None:
            result["progress"] = round(progress, 4)
        if buffered is not None:
            result["buffered_seconds"] = round(buffered, 1)
        if eta is not None:
            result["eta_seconds"] = round(eta, 1)
        return result


_fills_lock = threading.Lock()
_fills: dict[str, _FillState] = {}
# The CDN sees one whole-file transfer from this station at a time. Per-id
# single-flight prevents duplicates of the same song; this lock also prevents
# an active deck from overlapping a speculative fill for a different song.
# A priority gate, not parallel chunks: priority 0 is listener playback,
# priority 1 is speculative prefetch. Exactly one owner may touch upstream.
_upstream_gate = threading.Condition()
_upstream_waiters: list[tuple[int, int, _FillState]] = []
_upstream_ticket = 0
_upstream_owned = False
_active_upstream_lock = threading.Lock()
_active_upstream_fill: _FillState | None = None


@contextmanager
def _upstream_slot(state: _FillState):
    """Acquire the station's sole upstream lane by priority, then FIFO."""
    global _upstream_ticket, _upstream_owned
    priority = 0 if state.progressive_requested else 1
    with _upstream_gate:
        _upstream_ticket += 1
        token = (priority, _upstream_ticket, state)
        _upstream_waiters.append(token)
        while _upstream_owned or min(_upstream_waiters, key=lambda item: item[:2]) is not token:
            _upstream_gate.wait()
        _upstream_waiters.remove(token)
        _upstream_owned = True
    try:
        yield
    finally:
        with _upstream_gate:
            _upstream_owned = False
            _upstream_gate.notify_all()

# ── Upstream connection reuse ────────────────────────────────────────────────
# A browser plays audio by asking for ranges, not by asking for the file: one
# click can mean a dozen requests, and each one used to open its own TCP+TLS
# connection to googlevideo. Measured on a relayed station, that handshake costs
# ~330 ms every time; reused, the same range answers in ~90 ms. Pooling here is
# the difference between a track that starts and one that stalls its way in.
#
# The pool is keyed by (proxy, host) inside urllib3, so relay and direct egress
# never share a connection — which matters, because a signed URL only works from
# the address that resolved it.
_session_lock = threading.Lock()
_session: Optional[requests.Session] = None
#: Enough for several listeners plus prefetch without evicting live playback.
_POOL_MAXSIZE = 32

# A rejection of a freshly resolved URL is not a stale-signature problem.  It
# is a station-wide upstream refusal, and immediately asking for the same bytes
# through every queued preview only turns one outage into a request storm.
_UPSTREAM_BACKOFF_SEC = 30
_upstream_backoff_lock = threading.Lock()
_upstream_blocked_until = 0.0


def upstream_session() -> requests.Session:
    """The shared session every preview fetch goes through."""
    global _session
    if _session is not None:
        return _session
    with _session_lock:
        if _session is None:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(
                pool_connections=8,
                pool_maxsize=_POOL_MAXSIZE,
                # Retries are decided by the caller: a 403 here means the signed
                # URL died and needs re-resolving, not another attempt.
                max_retries=0,
            )
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            _session = session
    return _session


def retire_upstream_session() -> None:
    """Drop pooled connection and cookie state before the independent retry.

    This is isolation, not a diagnosis: a 403/410 does not by itself prove bot
    detection, a poisoned cookie, or any other external cause.
    """
    global _session
    with _session_lock:
        stale = _session
        _session = None
    if stale is not None:
        cookie_names = sorted(stale.cookies.keys())
        stale.close()
        logger.warning(
            "[PreviewCache] Retired upstream session after rejection (cookies: %s)",
            ", ".join(cookie_names) or "none",
        )


def upstream_backoff_remaining(*, now: Optional[float] = None) -> int:
    """Whole seconds before another googlevideo request is allowed."""
    current = time.monotonic() if now is None else now
    with _upstream_backoff_lock:
        remaining = _upstream_blocked_until - current
    return max(0, math.ceil(remaining))


def open_upstream_backoff(video_id: str, status_code: int) -> int:
    """Stop all preview lanes briefly after a freshly resolved URL is refused."""
    global _upstream_blocked_until
    now = time.monotonic()
    with _upstream_backoff_lock:
        _upstream_blocked_until = max(_upstream_blocked_until, now + _UPSTREAM_BACKOFF_SEC)
    remaining = upstream_backoff_remaining(now=now)
    logger.warning(
        "[PreviewCache] Fresh upstream URL rejected for %s (HTTP %s); pausing preview fetches for %ss",
        video_id,
        status_code,
        remaining,
    )
    return remaining


def clear_upstream_backoff() -> None:
    """A successful upstream response proves the station may fetch again."""
    global _upstream_blocked_until
    with _upstream_backoff_lock:
        _upstream_blocked_until = 0.0


def cache_limit_bytes() -> int:
    raw = os.getenv("SOUNDSIBLE_PREVIEW_CACHE_MB", "")
    try:
        mb = int(raw) if raw else DEFAULT_CACHE_LIMIT_MB
    except ValueError:
        mb = DEFAULT_CACHE_LIMIT_MB
    return max(0, mb) * 1024 * 1024


def preview_cache_dir() -> Path:
    return get_cache_dir() / "previews"


def _audio_path(video_id: str) -> Path:
    return preview_cache_dir() / f"{video_id}{AUDIO_SUFFIX}"


def _meta_path(video_id: str) -> Path:
    return preview_cache_dir() / f"{video_id}{META_SUFFIX}"


def _part_path(video_id: str) -> Path:
    return preview_cache_dir() / f"{video_id}{PART_SUFFIX}"


def _read_meta(video_id: str) -> dict:
    try:
        value = json.loads(_meta_path(video_id).read_text())
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _write_meta(video_id: str, value: dict) -> None:
    """Publish cache metadata atomically beside the already-atomic audio file."""
    path = _meta_path(video_id)
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        temporary.write_text(json.dumps(value, sort_keys=True))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def cached_metadata(video_id: str) -> dict:
    """Return observational metadata for a committed preview."""
    return _read_meta(video_id)


def _is_mp4(content_type: str) -> bool:
    return content_type.partition(";")[0].strip().lower() in {"audio/mp4", "video/mp4"}


def _normalizer_for(video_id: str) -> threading.Lock:
    with _normalizers_lock:
        return _normalizers.setdefault(video_id, threading.Lock())


def _remux_flat_mp4(source: Path, video_id: str) -> Optional[Path]:
    """Copy MP4 packets into one fast-start file without re-encoding audio."""
    from shared.ffmpeg_runtime import ffmpeg_executable

    output = source.with_name(
        f".{video_id}.{os.getpid()}.{threading.get_ident()}.flat-mp4.tmp"
    )
    output.unlink(missing_ok=True)
    try:
        result = subprocess.run(
            [
                ffmpeg_executable(),
                "-y", "-v", "error",
                "-i", str(source),
                "-map", "0:a:0",
                "-c", "copy",
                "-movflags", "+faststart",
                "-f", "mp4",
                str(output),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
        if result.returncode != 0 or not output.is_file() or output.stat().st_size == 0:
            output.unlink(missing_ok=True)
            return None
        if not _preview_is_decodable(output):
            output.unlink(missing_ok=True)
            return None
        return output
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("[PreviewCache] Could not normalize %s: %s", video_id, exc)
        output.unlink(missing_ok=True)
        return None


def _normalize_legacy_mp4(video_id: str, path: Path, content_type: str) -> dict:
    """Normalize one old cache entry once; concurrent readers share the result."""
    lock = _normalizer_for(video_id)
    with lock:
        meta = _read_meta(video_id)
        if meta.get("layout") in {FLAT_MP4_LAYOUT, SOURCE_LAYOUT}:
            return meta
        if not path.is_file():
            return meta
        replacement = _remux_flat_mp4(path, video_id)
        layout = SOURCE_LAYOUT
        if replacement is not None:
            os.replace(replacement, path)
            layout = FLAT_MP4_LAYOUT
        meta.update({
            "content_type": content_type,
            "size": path.stat().st_size,
            "layout": layout,
        })
        _write_meta(video_id, meta)
        return meta


def get_cached(video_id: str) -> Optional[tuple[Path, str]]:
    """Return (path, content_type) for a fully cached preview, or None.

    Touches the file so LRU eviction treats it as recently used.
    """
    path = _audio_path(video_id)
    if not path.is_file():
        return None
    content_type = "audio/mpeg"
    meta = _read_meta(video_id)
    if isinstance(meta.get("content_type"), str):
        content_type = meta["content_type"]
    if _is_mp4(content_type) and meta.get("layout") not in {FLAT_MP4_LAYOUT, SOURCE_LAYOUT}:
        try:
            _normalize_legacy_mp4(video_id, path, content_type)
        except OSError as exc:
            # Cache layout is an optimisation. Serving the already validated
            # source file is safer than turning an atomic remux failure into an
            # unavailable track.
            logger.warning("[PreviewCache] Legacy normalization failed for %s: %s", video_id, exc)
    try:
        os.utime(path, None)
    except OSError:
        pass
    return path, content_type


class CacheWriter:
    """Sink for one preview's bytes; commit only when the file is complete.

    Exactly one writer may exist per video_id (enforced by `open_writer`).
    """

    def __init__(self, video_id: str, content_type: str, expected_size: Optional[int]):
        self.video_id = video_id
        self.content_type = content_type
        self.expected_size = expected_size
        self._part = _part_path(video_id)
        self._fh = open(self._part, "wb")
        self._bytes = 0
        self._done = False

    def write(self, chunk: bytes) -> None:
        if self._done:
            return
        self._fh.write(chunk)
        # A progressive reader opens this same spool. Flush before publishing
        # the byte count so a woken reader can observe every announced byte.
        self._fh.flush()
        self._bytes += len(chunk)

    def commit(
        self,
        validator: Optional[Callable[[Path], bool]] = None,
        *,
        normalize: bool = True,
    ) -> bool:
        if self._done:
            return False
        normalized_output: Optional[Path] = None
        try:
            self._fh.close()
            if self.expected_size is not None and self._bytes != self.expected_size:
                logger.debug(
                    "[PreviewCache] %s incomplete (%d of %s bytes); discarding",
                    self.video_id, self._bytes, self.expected_size,
                )
                self._part.unlink(missing_ok=True)
                return False
            if self._bytes == 0:
                self._part.unlink(missing_ok=True)
                return False
            if validator is not None and not validator(self._part):
                logger.warning(
                    "[PreviewCache] %s is complete but not decodable; discarding",
                    self.video_id,
                )
                self._part.unlink(missing_ok=True)
                return False
            committed = self._part
            layout = SOURCE_LAYOUT
            if normalize and _is_mp4(self.content_type):
                normalized = _remux_flat_mp4(self._part, self.video_id)
                if normalized is not None:
                    normalized_output = normalized
                    committed = normalized
                    layout = FLAT_MP4_LAYOUT
            target = _audio_path(self.video_id)
            _write_meta(self.video_id, {
                "content_type": self.content_type,
                "size": committed.stat().st_size,
                "layout": layout,
            })
            os.replace(committed, target)
            if committed != self._part:
                self._part.unlink(missing_ok=True)
            enforce_cache_limit()
            return True
        except OSError as e:
            logger.warning("[PreviewCache] Commit failed for %s: %s", self.video_id, e)
            self._part.unlink(missing_ok=True)
            if normalized_output is not None:
                normalized_output.unlink(missing_ok=True)
            return False
        finally:
            self._done = True
            _release_writer(self.video_id)

    def abandon(self) -> None:
        if self._done:
            return
        self._done = True
        try:
            self._fh.close()
            self._part.unlink(missing_ok=True)
        except OSError:
            pass
        finally:
            _release_writer(self.video_id)


def _release_writer(video_id: str) -> None:
    with _writers_lock:
        _active_writers.discard(video_id)


def open_writer(video_id: str, content_type: str, expected_size: Optional[int]) -> Optional[CacheWriter]:
    """Claim the (single) cache writer for a video id, or None.

    None when caching is disabled, the file would exceed a sane share of the
    cache, another writer is active, or the file is already cached.
    """
    limit = cache_limit_bytes()
    if limit <= 0:
        return None
    if expected_size is not None and expected_size > limit // 4:
        return None
    if _audio_path(video_id).is_file():
        return None
    with _writers_lock:
        if video_id in _active_writers:
            return None
        _active_writers.add(video_id)
    try:
        preview_cache_dir().mkdir(parents=True, exist_ok=True)
        return CacheWriter(video_id, content_type, expected_size)
    except OSError as e:
        logger.warning("[PreviewCache] Cannot open writer for %s: %s", video_id, e)
        _release_writer(video_id)
        return None


def enforce_cache_limit() -> None:
    """Evict oldest committed files until the cache fits, sweep stale .part files."""
    limit = cache_limit_bytes()
    root = preview_cache_dir()
    if not root.is_dir():
        return
    now = time.time()
    entries: list[tuple[float, int, Path]] = []
    total = 0
    try:
        for path in root.iterdir():
            if path.name.endswith(PART_SUFFIX):
                try:
                    st = path.stat()
                except OSError:
                    continue
                in_flight = False
                with _writers_lock:
                    in_flight = path.name[: -len(PART_SUFFIX)] in _active_writers
                if not in_flight and now - st.st_mtime > STALE_PART_SEC:
                    path.unlink(missing_ok=True)
                continue
            if not path.name.endswith(AUDIO_SUFFIX):
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, path))
            total += st.st_size
    except OSError:
        return
    if total <= limit:
        return
    for _, size, path in sorted(entries):
        video_id = path.name[: -len(AUDIO_SUFFIX)]
        path.unlink(missing_ok=True)
        _meta_path(video_id).unlink(missing_ok=True)
        total -= size
        logger.debug("[PreviewCache] Evicted %s (%d bytes)", video_id, size)
        if total <= limit:
            break


# ── Prefetch worker ──────────────────────────────────────────────────────────
# Separate bounded lanes keep URL warming from waiting behind a full download.
# Active playback never enters either queue; it resolves synchronously and
# joins the same single-flight transfer if prefetch already owns the track.

_QUEUE_MAX = 32
ResolutionValue = Union[ResolvedStream, str, None]
Resolver = Callable[[str], ResolutionValue]
RefreshResolver = Callable[[str], ResolutionValue]
PrefetchJob = tuple[str, Resolver, Optional[RefreshResolver]]
_resolve_queue: "queue.Queue[PrefetchJob]" = queue.Queue(maxsize=_QUEUE_MAX)
_download_queue: "queue.Queue[PrefetchJob]" = queue.Queue(maxsize=_QUEUE_MAX)
_pending_lock = threading.Lock()
_pending: set[tuple[str, bool]] = set()
_worker_started = threading.Event()


@dataclass(frozen=True)
class PreparationStatus:
    state: str
    reason: str | None = None
    retry_after: int = 0
    progress_facts: dict[str, object] | None = None

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"state": self.state}
        if self.reason:
            result["reason"] = self.reason
        if self.retry_after > 0:
            result["retry_after"] = self.retry_after
        if self.progress_facts:
            result.update(self.progress_facts)
        return result


_preparation_lock = threading.Lock()
# Failures are short-lived routing facts, not a permanent blacklist. A fresh
# prefetch after the retry window gets a clean attempt.
_preparation_failures: dict[str, tuple[float, str, int]] = {}
_PREPARATION_FAILURE_TTL_SEC = 300
_PREPARATION_FAILURE_MAX = 128


def _record_preparation_failure(video_id: str, reason: str, retry_after: int = 0) -> None:
    now = time.monotonic()
    with _preparation_lock:
        _preparation_failures[video_id] = (now, reason, max(0, retry_after))
        if len(_preparation_failures) > _PREPARATION_FAILURE_MAX:
            oldest = min(_preparation_failures, key=lambda item: _preparation_failures[item][0])
            _preparation_failures.pop(oldest, None)


def _clear_preparation_failure(video_id: str) -> None:
    with _preparation_lock:
        _preparation_failures.pop(video_id, None)


def preparation_status(video_id: str) -> PreparationStatus:
    """Return the truthful disk-readiness state for one preview.

    ``queued`` was previously the only observable answer and clients treated it
    as if bytes were ready. This deliberately distinguishes work accepted from
    a complete, range-seekable file.
    """
    if _audio_path(video_id).is_file():
        return PreparationStatus("ready")
    with _pending_lock:
        pending = (video_id, True) in _pending
    if not pending:
        with _fills_lock:
            pending = video_id in _fills
    if pending:
        with _fills_lock:
            fill = _fills.get(video_id)
        if fill is not None:
            return PreparationStatus(
                "streamable" if fill.streamable else "pending",
                progress_facts=fill.facts(),
            )
        return PreparationStatus("pending")
    now = time.monotonic()
    with _preparation_lock:
        failed = _preparation_failures.get(video_id)
        if failed and now - failed[0] > _PREPARATION_FAILURE_TTL_SEC:
            _preparation_failures.pop(video_id, None)
            failed = None
    if failed:
        recorded_at, reason, original_retry = failed
        retry_after = max(0, math.ceil(original_retry - (now - recorded_at)))
        return PreparationStatus("unavailable", reason, retry_after)
    return PreparationStatus("cold")


def _coerce_resolution(value: ResolutionValue) -> Optional[ResolvedStream]:
    if isinstance(value, ResolvedStream):
        return value
    if isinstance(value, str) and value:
        proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
        return resolved_stream(
            value,
            egress="relay" if proxy else "direct",
            proxy_url=proxy or None,
        )
    return None


def _preview_is_decodable(path: Path) -> bool:
    """Prove that a completed preview contains audio the bundled decoder reads."""
    from shared.ffmpeg_runtime import ffmpeg_executable

    try:
        result = subprocess.run(
            [
                ffmpeg_executable(),
                "-v", "error",
                "-i", str(path),
                "-map", "0:a:0",
                "-t", "1",
                "-f", "null",
                "-",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("[PreviewCache] Could not validate %s: %s", path.name, exc)
        return False
    return result.returncode == 0


def _resolved_media_facts(stream: ResolvedStream) -> tuple[int | None, float | None, str | None]:
    """Read non-secret media facts embedded in a signed CDN URL."""
    try:
        values = parse_qs(urlparse(stream.url).query)
        raw_size = values.get("clen", [None])[0]
        raw_duration = values.get("dur", [None])[0]
        raw_mime = values.get("mime", [None])[0]
        size = int(raw_size) if raw_size and str(raw_size).isdigit() else None
        duration = float(raw_duration) if raw_duration is not None else None
        return size, duration if duration and duration > 0 else None, raw_mime
    except (TypeError, ValueError):
        return None, None, None


def _emit_fill_event(event: str, state: _FillState, **extra: object) -> None:
    """Local telemetry for acquisition lifecycle; signed URLs never enter it."""
    try:
        from shared.telemetry import emit

        emit(event, {
            "track_id": state.video_id,
            **state.facts(),
            **extra,
        })
    except Exception:
        logger.debug("[PreviewCache] Could not emit %s", event, exc_info=True)


def _maybe_mark_streamable(state: _FillState, part: Path) -> None:
    now = time.monotonic()
    if state.streamable or state.prefix_checked or now < state.next_prefix_check_at:
        return
    elapsed = now - state.started_at
    if elapsed < _PROGRESSIVE_FAST_COMPLETE_SEC:
        return
    total = state.total_bytes
    duration = state.duration_seconds
    if not total or not duration or duration <= 0:
        return
    media_rate = total / duration
    buffered = state.downloaded_bytes / media_rate
    transfer_rate = state.sustained_rate()
    if buffered < _PROGRESSIVE_MIN_BUFFER_SEC or transfer_rate < media_rate * _PROGRESSIVE_RATE_MARGIN:
        return
    state.prefix_checked = True
    if not _preview_is_decodable(part):
        logger.info("[PreviewCache] Prefix for %s is not yet decodable", state.video_id)
        state.prefix_checked = False
        state.next_prefix_check_at = time.monotonic() + 1.0
        return
    with state.condition:
        state.streamable = True
        state.condition.notify_all()
    _emit_fill_event("preview_fill_streamable", state)


def _download_once(
    video_id: str,
    stream: Union[ResolvedStream, str],
    state: _FillState | None = None,
) -> Optional[tuple[Path, str]]:
    """Download one complete preview; the caller owns the per-id fill slot."""
    global _active_upstream_fill
    cached = get_cached(video_id)
    if cached:
        return cached
    resolved = _coerce_resolution(stream)
    if resolved is None:
        return None
    state = state or _FillState(video_id)
    state.stream = resolved
    url_size, url_duration, url_mime = _resolved_media_facts(resolved)
    state.total_bytes = url_size
    state.duration_seconds = url_duration
    if url_mime:
        state.content_type = url_mime
    with _upstream_slot(state):
        # A different fill may have completed while this one waited for the
        # station-wide slot. Re-check both durable state and refusal state before
        # touching the network.
        cached = get_cached(video_id)
        if cached:
            return cached
        if upstream_backoff_remaining():
            return None
        if state.cancel.is_set():
            return None
        with _active_upstream_lock:
            _active_upstream_fill = state
        state.start_transfer()
        _emit_fill_event("preview_fill_started", state, egress=resolved.egress)
        try:
            # googlevideo throttles DASH without Range to roughly realtime.
            # This remains the transfer's sole upstream request.
            with upstream_session().get(
                resolved.url,
                stream=True,
                timeout=(5, 90),
                proxies=resolved.requests_proxies(),
                headers={"Range": "bytes=0-"},
            ) as resp:
                if resp.status_code in (403, 410):
                    retire_upstream_session()
                    raise PreviewUpstreamRejected(resp.status_code)
                resp.raise_for_status()
                raw_len = resp.headers.get("Content-Length")
                expected = int(raw_len) if raw_len and raw_len.isdigit() else None
                # Content-Range is authoritative for an open-ended range.
                content_range = resp.headers.get("Content-Range") or ""
                match = re.fullmatch(r"bytes\s+0-\d+/(\d+)", content_range.strip())
                if match:
                    expected = int(match.group(1))
                content_type = resp.headers.get("Content-Type") or "audio/mpeg"
                state.total_bytes = expected or state.total_bytes
                state.content_type = content_type
                with state.condition:
                    state.condition.notify_all()
                writer = open_writer(video_id, content_type, expected)
                if writer is None:
                    return get_cached(video_id)
                try:
                    for chunk in resp.iter_content(chunk_size=65536):
                        if state.cancel.is_set():
                            raise PreviewFillCancelled()
                        if chunk:
                            writer.write(chunk)
                            state.update(writer._bytes)
                            if state.progressive_requested:
                                _maybe_mark_streamable(state, writer._part)
                    if not writer.commit(
                        _preview_is_decodable,
                        normalize=not state.progressive_requested,
                    ):
                        return None
                    state.update(expected or writer._bytes)
                    _emit_fill_event("preview_fill_completed", state)
                except PreviewFillCancelled:
                    writer.abandon()
                    _emit_fill_event("preview_fill_cancelled", state)
                    raise
                except BaseException:
                    writer.abandon()
                    raise
        finally:
            with _active_upstream_lock:
                if _active_upstream_fill is state:
                    _active_upstream_fill = None
    return get_cached(video_id)


def acquire_cached(
    video_id: str,
    resolver: Resolver,
    *,
    refresh_resolver: Optional[RefreshResolver] = None,
    keep_warm: bool = False,
) -> tuple[Optional[tuple[Path, str]], Optional[ResolvedStream]]:
    """Resolve and cache one preview, refreshing one CDN-rejected URL.

    Active playback and speculative prefetch must use this exact contract. A
    URL is only an acquisition hint; the committed, decoder-checked file is the
    evidence that a candidate is playable.
    """
    stream = _coerce_resolution(resolver(video_id))
    if stream is None:
        return None, None
    for attempt in range(2):
        try:
            cached = ensure_cached(video_id, stream, keep_warm=keep_warm)
        except PreviewUpstreamRejected as exc:
            if attempt == 0 and refresh_resolver is not None:
                stream = _coerce_resolution(refresh_resolver(video_id))
                if stream is None:
                    return None, None
                continue
            open_upstream_backoff(video_id, exc.status_code)
            raise
        if cached:
            clear_upstream_backoff()
        return cached, stream
    return None, stream


def ensure_cached(
    video_id: str,
    stream: Union[ResolvedStream, str],
    *,
    wait_timeout: float = 95,
    keep_warm: bool = False,
) -> Optional[tuple[Path, str]]:
    """Return a complete local preview, joining an existing fill when needed.

    Browser range requests, the incoming DJ deck and background prefetch can
    arrive together. They must never become separate googlevideo transfers:
    the first caller owns the download and every other caller waits for that
    exact result.
    """
    cached = get_cached(video_id)
    if cached or cache_limit_bytes() <= 0:
        return cached

    with _fills_lock:
        state = _fills.get(video_id)
        owner = state is None
        if state is None:
            state = _FillState(video_id)
            _fills[video_id] = state
        if keep_warm:
            state.keep_warm = True

    if not owner:
        if not state.done.wait(wait_timeout):
            raise TimeoutError(f"preview cache fill timed out for {video_id}")
        if state.error is not None:
            raise state.error
        return get_cached(video_id)

    try:
        return _download_once(video_id, stream, state)
    except PreviewFillCancelled:
        state.finish()
        raise
    except BaseException as exc:
        state.finish(exc)
        _emit_fill_event("preview_fill_failed", state, error=type(exc).__name__)
        raise
    finally:
        if not state.done.is_set():
            state.finish()
        with _fills_lock:
            if _fills.get(video_id) is state:
                _fills.pop(video_id, None)


class ProgressiveHandle:
    """A browser's interest in one growing local preview spool."""

    def __init__(self, state: _FillState):
        self.state = state
        self._closed = False

    @property
    def content_type(self) -> str:
        return self.state.content_type

    @property
    def total_bytes(self) -> int | None:
        return self.state.total_bytes

    @property
    def egress(self) -> str:
        return self.state.stream.egress if self.state.stream else "direct"

    @property
    def done(self) -> bool:
        return self.state.done.is_set()

    def wait_for_fast_complete(self, timeout: float = _PROGRESSIVE_FAST_COMPLETE_SEC) -> None:
        """Give ordinary songs their existing whole-file fast path first."""
        deadline = time.monotonic() + timeout
        with self.state.condition:
            while not self.state.done.is_set() and not self.state.streamable:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.state.condition.wait(remaining)

    def iter_bytes(self, start: int = 0, end: int | None = None):
        """Yield only local bytes, waiting when the requested offset is future."""
        position = max(0, start)
        try:
            while end is None or position <= end:
                with self.state.condition:
                    while (
                        self.state.downloaded_bytes <= position
                        and not self.state.done.is_set()
                        and self.state.error is None
                    ):
                        self.state.condition.wait(1.0)
                    available = self.state.downloaded_bytes
                    done = self.state.done.is_set()
                    error = self.state.error
                    playable = self.state.streamable or done
                if error is not None:
                    return
                if not playable:
                    # Do not expose an unproved prefix. A sustainable source
                    # flips streamable; a fast source reaches done first.
                    with self.state.condition:
                        self.state.condition.wait(0.25)
                    continue
                if available <= position:
                    if done:
                        return
                    continue
                count = min(65536, available - position)
                if end is not None:
                    count = min(count, end - position + 1)
                path = _part_path(self.state.video_id)
                if not path.is_file():
                    path = _audio_path(self.state.video_id)
                try:
                    with open(path, "rb") as source:
                        source.seek(position)
                        chunk = source.read(count)
                except OSError:
                    if done:
                        return
                    time.sleep(0.01)
                    continue
                if not chunk:
                    if done:
                        return
                    time.sleep(0.01)
                    continue
                position += len(chunk)
                yield chunk
        finally:
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with self.state.condition:
            self.state.readers = max(0, self.state.readers - 1)
            abandoned = self.state.readers == 0 and not self.state.keep_warm
        if abandoned and not self.state.done.is_set():
            self.state.cancel.set()


def start_progressive(
    video_id: str,
    stream: Union[ResolvedStream, str],
    *,
    refresh_resolver: Optional[RefreshResolver] = None,
) -> ProgressiveHandle:
    """Start/join a high-priority fill without doing network I/O in the route."""
    resolved = _coerce_resolution(stream)
    if resolved is None:
        raise ValueError("preview stream did not resolve")
    with _fills_lock:
        state = _fills.get(video_id)
        owner = state is None
        if state is None:
            state = _FillState(video_id)
            _fills[video_id] = state
        state.progressive_requested = True
        state.readers += 1

    # If speculative work owns the sole lane but nobody is consuming it, the
    # listener's click cancels that fill. The next loop iteration releases the
    # lock; no second upstream request overlaps it.
    with _active_upstream_lock:
        active = _active_upstream_fill
        if active is not None and active is not state and active.readers == 0:
            active.cancel.set()

    if owner:
        def run() -> None:
            current = resolved
            try:
                for attempt in range(2):
                    try:
                        cached = _download_once(video_id, current, state)
                    except PreviewUpstreamRejected as exc:
                        if attempt == 0 and refresh_resolver is not None:
                            # This ephemeral playback thread must not pin a DB
                            # connection after fallback URL resolution.
                            from shared import request_scope

                            with request_scope.request_scope():
                                refreshed = _coerce_resolution(refresh_resolver(video_id))
                            if refreshed is not None:
                                current = refreshed
                                state.stream = refreshed
                                continue
                        open_upstream_backoff(video_id, exc.status_code)
                        raise
                    if cached:
                        clear_upstream_backoff()
                    break
            except PreviewFillCancelled:
                state.finish()
            except BaseException as exc:
                state.finish(exc)
                _record_preparation_failure(video_id, "download_failed")
                _emit_fill_event("preview_fill_failed", state, error=type(exc).__name__)
            finally:
                if not state.done.is_set():
                    state.finish()
                with _fills_lock:
                    if _fills.get(video_id) is state:
                        _fills.pop(video_id, None)

        threading.Thread(
            target=run,
            name=f"preview-playback-{video_id}",
            daemon=True,
        ).start()
    return ProgressiveHandle(state)


def cancel_progressive(video_id: str) -> bool:
    """Cancel a listener-started fill; committed cache files are untouched."""
    with _fills_lock:
        state = _fills.get(video_id)
    if state is None or not state.progressive_requested or state.done.is_set():
        return False
    state.keep_warm = False
    state.cancel.set()
    return True


def _download_to_cache(video_id: str, stream: Union[ResolvedStream, str]) -> None:
    """Compatibility wrapper used by the background download lane."""
    ensure_cached(video_id, stream)


def _worker_loop(jobs: "queue.Queue[PrefetchJob]", *, download: bool) -> None:
    while True:
        video_id, resolver, refresh_resolver = jobs.get()
        try:
            if download:
                if cache_limit_bytes() <= 0:
                    _record_preparation_failure(video_id, "cache_disabled")
                else:
                    cached, stream = acquire_cached(
                        video_id,
                        resolver,
                        refresh_resolver=refresh_resolver,
                        keep_warm=True,
                    )
                    if cached:
                        _clear_preparation_failure(video_id)
                    else:
                        retry = upstream_backoff_remaining()
                        _record_preparation_failure(
                            video_id,
                            "upstream_backoff" if retry else (
                                "resolution_failed" if stream is None else "download_failed"
                            ),
                            retry,
                        )
            else:
                resolver(video_id)
        except PreviewUpstreamRejected as e:
            _record_preparation_failure(
                video_id,
                "upstream_rejected",
                upstream_backoff_remaining() or _UPSTREAM_BACKOFF_SEC,
            )
            logger.info("[PreviewCache] Prefetch rejected for %s: %s", video_id, e)
        except PreviewFillCancelled:
            # Preemption is scheduling, not evidence that the candidate is bad.
            _clear_preparation_failure(video_id)
            logger.info("[PreviewCache] Prefetch yielded to playback for %s", video_id)
        except Exception as e:
            if download:
                _record_preparation_failure(video_id, "download_failed")
            logger.info("[PreviewCache] Prefetch failed for %s: %s", video_id, e)
        finally:
            with _pending_lock:
                _pending.discard((video_id, download))
            jobs.task_done()


# URL resolution is latency, so two may overlap. Full-file fills are bandwidth:
# serialising them keeps the current song, its incoming deck, and speculative
# cache work from all pulling complete files from googlevideo at once.
_RESOLVE_LANE_WORKERS = 2
_DOWNLOAD_LANE_WORKERS = 1


def _ensure_worker() -> None:
    if _worker_started.is_set():
        return
    with _pending_lock:
        if _worker_started.is_set():
            return
        for index in range(_RESOLVE_LANE_WORKERS):
            threading.Thread(
                target=_worker_loop,
                args=(_resolve_queue,),
                kwargs={"download": False},
                name=f"preview-resolve-{index}",
                daemon=True,
            ).start()
        for index in range(_DOWNLOAD_LANE_WORKERS):
            threading.Thread(
                target=_worker_loop,
                args=(_download_queue,),
                kwargs={"download": True},
                name=f"preview-download-{index}",
                daemon=True,
            ).start()
        _worker_started.set()


def request_prefetch(
    video_ids: Iterable[str],
    *,
    download: bool,
    resolver: Resolver,
    refresh_resolver: Optional[RefreshResolver] = None,
) -> list[str]:
    """Queue background prefetch jobs; returns the ids actually queued.

    Ids already queued/in-flight or (for downloads) already cached are
    skipped. Never blocks: when the queue is full the rest are dropped —
    prefetch is best-effort by design.
    """
    _ensure_worker()
    queued: list[str] = []
    jobs = _download_queue if download else _resolve_queue
    for video_id in video_ids:
        if download and get_cached(video_id):
            continue
        pending_key = (video_id, download)
        with _pending_lock:
            if pending_key in _pending:
                continue
            _pending.add(pending_key)
        if download:
            _clear_preparation_failure(video_id)
        try:
            jobs.put_nowait((video_id, resolver, refresh_resolver))
            queued.append(video_id)
        except queue.Full:
            with _pending_lock:
                _pending.discard(pending_key)
            if download:
                _record_preparation_failure(video_id, "queue_full", 2)
            break
    return queued
