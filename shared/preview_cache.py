"""
Disk cache + background prefetch for preview audio streams.

Previews (tracks played before they are downloaded into the library) are
acquired from the YouTube CDN by `/api/preview/stream/<video_id>`. Two pieces
live here to make that path fast and deterministic:

- Single-flight acquisition: every caller for one video id joins one complete
  upstream download. Playback starts from the committed local file, so a media
  element can seek and request as many ranges as it wants without turning one
  song into repeated CDN requests.
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
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional, Union

import requests

from shared.runtime import get_cache_dir
from shared.stream_resolution import ResolvedStream, resolved_stream

logger = logging.getLogger(__name__)

DEFAULT_CACHE_LIMIT_MB = 2048
AUDIO_SUFFIX = ".audio"
META_SUFFIX = ".meta.json"
PART_SUFFIX = ".part"
# Abandoned .part files (crash, dropped client) older than this are swept.
STALE_PART_SEC = 3600

_writers_lock = threading.Lock()
_active_writers: set[str] = set()


class PreviewUpstreamRejected(Exception):
    """The CDN refused a signed preview URL and it must be re-resolved."""

    def __init__(self, status_code: int):
        super().__init__(f"preview upstream returned HTTP {status_code}")
        self.status_code = status_code


class _FillState:
    """One in-flight whole-file acquisition shared by all callers for an id."""

    def __init__(self):
        self.done = threading.Event()
        self.error: BaseException | None = None


_fills_lock = threading.Lock()
_fills: dict[str, _FillState] = {}
# The CDN sees one whole-file transfer from this station at a time. Per-id
# single-flight prevents duplicates of the same song; this lock also prevents
# an active deck from overlapping a speculative fill for a different song.
_upstream_download_lock = threading.Lock()

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
    """Drop the pooled session so the next fetch rides a clean jar.

    googlevideo's abuse system flags sessions, not just URLs: a 403/410
    plants a marker back into the session's cookie jar, so every later
    request on that same pooled session identifies itself as flagged no
    matter how fresh the signed URL is. Re-resolving the URL alone can never
    win that fight — only a new session does.
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


def get_cached(video_id: str) -> Optional[tuple[Path, str]]:
    """Return (path, content_type) for a fully cached preview, or None.

    Touches the file so LRU eviction treats it as recently used.
    """
    path = _audio_path(video_id)
    if not path.is_file():
        return None
    content_type = "audio/mpeg"
    try:
        meta = json.loads(_meta_path(video_id).read_text())
        if isinstance(meta.get("content_type"), str):
            content_type = meta["content_type"]
    except Exception:
        pass
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
        self._bytes += len(chunk)

    def commit(self) -> bool:
        if self._done:
            return False
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
            _meta_path(self.video_id).write_text(
                json.dumps({"content_type": self.content_type, "size": self._bytes})
            )
            os.replace(self._part, _audio_path(self.video_id))
            enforce_cache_limit()
            return True
        except OSError as e:
            logger.warning("[PreviewCache] Commit failed for %s: %s", self.video_id, e)
            self._part.unlink(missing_ok=True)
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
_resolve_queue: "queue.Queue[tuple[str, Resolver]]" = queue.Queue(maxsize=_QUEUE_MAX)
_download_queue: "queue.Queue[tuple[str, Resolver]]" = queue.Queue(maxsize=_QUEUE_MAX)
_pending_lock = threading.Lock()
_pending: set[tuple[str, bool]] = set()
_worker_started = threading.Event()


@dataclass(frozen=True)
class PreparationStatus:
    state: str
    reason: str | None = None
    retry_after: int = 0

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"state": self.state}
        if self.reason:
            result["reason"] = self.reason
        if self.retry_after > 0:
            result["retry_after"] = self.retry_after
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


def _download_once(
    video_id: str,
    stream: Union[ResolvedStream, str],
) -> Optional[tuple[Path, str]]:
    """Download one complete preview; the caller owns the per-id fill slot."""
    cached = get_cached(video_id)
    if cached:
        return cached
    resolved = _coerce_resolution(stream)
    if resolved is None:
        return None
    with _upstream_download_lock:
        # A different fill may have completed while this one waited for the
        # station-wide slot. Re-check both durable state and refusal state before
        # touching the network.
        cached = get_cached(video_id)
        if cached:
            return cached
        if upstream_backoff_remaining():
            return None
        # bytes=0- matters: googlevideo throttles DASH URLs fetched without a
        # Range header to roughly realtime; an open-ended range runs at full speed.
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
            content_type = resp.headers.get("Content-Type") or "audio/mpeg"
            writer = open_writer(video_id, content_type, expected)
            if writer is None:
                return get_cached(video_id)
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        writer.write(chunk)
                if not writer.commit():
                    return None
            except BaseException:
                writer.abandon()
                raise
    return get_cached(video_id)


def ensure_cached(
    video_id: str,
    stream: Union[ResolvedStream, str],
    *,
    wait_timeout: float = 95,
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
            state = _FillState()
            _fills[video_id] = state

    if not owner:
        if not state.done.wait(wait_timeout):
            raise TimeoutError(f"preview cache fill timed out for {video_id}")
        if state.error is not None:
            raise state.error
        return get_cached(video_id)

    try:
        return _download_once(video_id, stream)
    except BaseException as exc:
        state.error = exc
        raise
    finally:
        state.done.set()
        with _fills_lock:
            if _fills.get(video_id) is state:
                _fills.pop(video_id, None)


def _download_to_cache(video_id: str, stream: Union[ResolvedStream, str]) -> None:
    """Compatibility wrapper used by the background download lane."""
    ensure_cached(video_id, stream)


def _worker_loop(jobs: "queue.Queue[tuple[str, Resolver]]", *, download: bool) -> None:
    while True:
        video_id, resolver = jobs.get()
        try:
            stream = _coerce_resolution(resolver(video_id))
            if download:
                if cache_limit_bytes() <= 0:
                    _record_preparation_failure(video_id, "cache_disabled")
                elif stream is None:
                    retry = upstream_backoff_remaining()
                    _record_preparation_failure(
                        video_id,
                        "upstream_backoff" if retry else "resolution_failed",
                        retry,
                    )
                else:
                    _download_to_cache(video_id, stream)
                    if _audio_path(video_id).is_file():
                        _clear_preparation_failure(video_id)
                    else:
                        retry = upstream_backoff_remaining()
                        _record_preparation_failure(
                            video_id,
                            "upstream_backoff" if retry else "download_failed",
                            retry,
                        )
        except PreviewUpstreamRejected as e:
            _record_preparation_failure(
                video_id,
                "upstream_rejected",
                upstream_backoff_remaining() or _UPSTREAM_BACKOFF_SEC,
            )
            logger.info("[PreviewCache] Prefetch rejected for %s: %s", video_id, e)
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
            jobs.put_nowait((video_id, resolver))
            queued.append(video_id)
        except queue.Full:
            with _pending_lock:
                _pending.discard(pending_key)
            if download:
                _record_preparation_failure(video_id, "queue_full", 2)
            break
    return queued
