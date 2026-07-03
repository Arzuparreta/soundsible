"""
Disk cache + background prefetch for preview audio streams.

Previews (tracks played before they are downloaded into the library) are
proxied from the YouTube CDN by `/api/preview/stream/<video_id>`. Two pieces
live here to make that path fast:

- Tee-through cache: while the proxy streams bytes to a client, the same
  bytes are written to ``<cache>/previews/<video_id>.part``. Once the full
  file is received it is committed and the next request is served straight
  from disk (instant start, cheap seeks).
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
import os
import queue
import threading
import time
from pathlib import Path
from typing import Callable, Iterable, Optional

import requests

from shared.runtime import get_cache_dir

logger = logging.getLogger(__name__)

DEFAULT_CACHE_LIMIT_MB = 2048
AUDIO_SUFFIX = ".audio"
META_SUFFIX = ".meta.json"
PART_SUFFIX = ".part"
# Abandoned .part files (crash, dropped client) older than this are swept.
STALE_PART_SEC = 3600

_writers_lock = threading.Lock()
_active_writers: set[str] = set()


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
# One daemon thread; jobs are (video_id, download, resolver). Resolution warms
# the caller's stream-URL cache; download also lands the audio in this cache.

_QUEUE_MAX = 32
_prefetch_queue: "queue.Queue[tuple[str, bool, Callable[[str], str]]]" = queue.Queue(maxsize=_QUEUE_MAX)
_pending_lock = threading.Lock()
_pending: set[str] = set()
_worker_started = threading.Event()


def _proxies() -> Optional[dict[str, str]]:
    # Same routing as the stream proxy: googlevideo URLs are IP-bound to the
    # resolver's IP, so downloads must go through the same proxy if one is set.
    yt_proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "")
    return {"http": yt_proxy, "https": yt_proxy} if yt_proxy else None


def _download_to_cache(video_id: str, stream_url: str) -> None:
    if get_cached(video_id):
        return
    # bytes=0- matters: googlevideo throttles DASH URLs fetched without a
    # Range header to roughly realtime; an open-ended range runs at full speed.
    with requests.get(
        stream_url,
        stream=True,
        timeout=(5, 90),
        proxies=_proxies(),
        headers={"Range": "bytes=0-"},
    ) as resp:
        resp.raise_for_status()
        raw_len = resp.headers.get("Content-Length")
        expected = int(raw_len) if raw_len and raw_len.isdigit() else None
        content_type = resp.headers.get("Content-Type") or "audio/mpeg"
        writer = open_writer(video_id, content_type, expected)
        if writer is None:
            return
        try:
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    writer.write(chunk)
            writer.commit()
        except BaseException:
            writer.abandon()
            raise


def _worker_loop() -> None:
    while True:
        video_id, download, resolver = _prefetch_queue.get()
        try:
            stream_url = resolver(video_id)
            if stream_url and download and cache_limit_bytes() > 0:
                _download_to_cache(video_id, stream_url)
        except Exception as e:
            logger.info("[PreviewCache] Prefetch failed for %s: %s", video_id, e)
        finally:
            with _pending_lock:
                _pending.discard(video_id)
            _prefetch_queue.task_done()


def _ensure_worker() -> None:
    if _worker_started.is_set():
        return
    with _pending_lock:
        if _worker_started.is_set():
            return
        threading.Thread(target=_worker_loop, name="preview-prefetch", daemon=True).start()
        _worker_started.set()


def request_prefetch(
    video_ids: Iterable[str],
    *,
    download: bool,
    resolver: Callable[[str], str],
) -> list[str]:
    """Queue background prefetch jobs; returns the ids actually queued.

    Ids already queued/in-flight or (for downloads) already cached are
    skipped. Never blocks: when the queue is full the rest are dropped —
    prefetch is best-effort by design.
    """
    _ensure_worker()
    queued: list[str] = []
    for video_id in video_ids:
        if download and get_cached(video_id):
            continue
        with _pending_lock:
            if video_id in _pending:
                continue
            _pending.add(video_id)
        try:
            _prefetch_queue.put_nowait((video_id, download, resolver))
            queued.append(video_id)
        except queue.Full:
            with _pending_lock:
                _pending.discard(video_id)
            break
    return queued
