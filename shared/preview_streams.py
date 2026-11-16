"""Resolving a YouTube video id to its signed audio-stream URL, once.

Resolution is a multi-second yt-dlp extraction. Playback, catalog resolution
and the DJ's prefetch all ask for it, so the single-flight memo and the
durable cache live here rather than in one of their route modules. The caller
passes its `get_downloader`, which is how the routes' test doubles reach it.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Callable

from shared.memo import Memo
from shared.stream_resolution import ResolvedStream

logger = logging.getLogger(__name__)

# Preview stream URLs, single-flighted: resolution is a multi-second yt-dlp
# extraction, and repeated taps on the same row (or a prefetch racing the click
# it was meant to make instant) all collapse onto one call. Unresolvable ids
# get a short negative TTL so a dead video is not re-extracted on every retry
# but is also not written off for the full five minutes.
STREAM_CACHE_TTL_SEC = 300  # 5 minutes
STREAM_NEGATIVE_TTL_SEC = 20
_stream_urls: Memo[ResolvedStream | str] = Memo(
    ttl_sec=STREAM_CACHE_TTL_SEC,
    negative_ttl_sec=STREAM_NEGATIVE_TTL_SEC,
    maxsize=512,
)


def _current_egress() -> str:
    proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
    return "relay:" + hashlib.sha256(proxy.encode()).hexdigest() if proxy else "direct"


def _stream_memo_key(video_id):
    return video_id if _current_egress() == 'direct' else video_id + ':' + _current_egress()


def _durable_stream_cache_get(video_id: str) -> ResolvedStream | None:
    """A stream URL this station already resolved, still inside its own expiry.

    The signed URL lives about six hours; the in-process memo lives five minutes
    and dies with the process. Without this step a station pays the extraction
    again after every restart, and on a relayed station that extraction is the
    most expensive thing it does.
    """
    try:
        from shared.database import instance_db

        row = instance_db().get_cached_stream_url(video_id, _current_egress())
    except Exception as exc:  # pragma: no cover — cache must never break playback
        logger.debug("API: [Preview] durable stream cache read failed for %s: %s", video_id, exc)
        return None
    if not row:
        return None
    proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
    return ResolvedStream(
        url=row["url"],
        egress="relay" if row["egress"].startswith("relay:") else "direct",
        resolved_at=float(row["resolved_at"]),
        expires_at=float(row["expires_at"]),
        proxy_url=proxy or None if row["egress"].startswith("relay:") else None,
    )


def _durable_stream_cache_put(video_id: str, stream: ResolvedStream) -> None:
    if stream.expires_at is None:
        # No expiry in the URL means no idea how long it is good for; the
        # in-process memo's short TTL is the safe ceiling for that case.
        return
    try:
        from shared.database import instance_db

        instance_db().set_cached_stream_url(
            video_id,
            stream.url,
            ("relay:" + hashlib.sha256((stream.proxy_url or '').encode()).hexdigest()
             if stream.egress == 'relay' else 'direct'),
            stream.resolved_at,
            stream.expires_at,
        )
    except Exception as exc:  # pragma: no cover — cache must never break playback
        logger.debug("API: [Preview] durable stream cache write failed for %s: %s", video_id, exc)


def invalidate(video_id: str) -> None:
    """Forget a URL the CDN rejected, in both cache layers."""
    _stream_urls.invalidate(_stream_memo_key(video_id))
    try:
        from shared.database import instance_db

        instance_db().invalidate_cached_stream_url(video_id)
    except Exception as exc:  # pragma: no cover
        logger.debug("API: [Preview] durable stream cache invalidate failed for %s: %s", video_id, exc)


def resolve(
    get_downloader: Callable[..., Any], video_id: str, *, skip_fast_path: bool = False
) -> ResolvedStream | None:
    """Resolve a preview stream URL, at most once per video id at a time.

    Three layers, cheapest first: the in-process memo, the durable SQLite cache
    (good for the URL's full six hours, across restarts and every listener on
    the station), then the yt-dlp extraction. Concurrent callers for the same id
    — repeated taps, a range request landing while the first fetch is still
    resolving, a prefetch racing a click — share one extraction rather than each
    paying for their own.

    `skip_fast_path` is for a retry right after the CDN rejected a URL the
    fast path just produced — see `Downloader.get_resolved_stream`. The caller is
    expected to have already invalidated the rejected URL from both cache
    layers, so `durable` below will not just hand the same dead URL back.
    """

    def resolve() -> ResolvedStream | str:
        durable = _durable_stream_cache_get(video_id)
        if durable is not None:
            return durable
        dl = get_downloader(open_browser=False)
        stream = dl.downloader.get_resolved_stream(video_id, skip_fast_path=skip_fast_path) or ""
        if isinstance(stream, ResolvedStream):
            _durable_stream_cache_put(video_id, stream)
        return stream

    try:
        value = _stream_urls.resolve(_stream_memo_key(video_id), resolve)
        return value if isinstance(value, ResolvedStream) else None
    except TimeoutError:
        logger.warning("API: [Preview] Timed out waiting on in-flight resolution for %s", video_id)
        return None


def resolved_url(get_downloader: Callable[..., Any], video_id: str) -> str:
    """`resolve`, as the bare URL (``""`` when the id does not resolve)."""
    stream = resolve(get_downloader, video_id)
    return stream.url if stream else ""


def is_warm(video_id: str) -> bool:
    """Whether a resolved URL for `video_id` is in the in-process memo."""
    return isinstance(_stream_urls.get(_stream_memo_key(video_id)), ResolvedStream)
