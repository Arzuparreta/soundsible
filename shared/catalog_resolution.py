"""Finding the YouTube upload for a catalog row (artist + title).

Catalog search, the DJ, library imports and playlist migration all need it, so
it lives outside any one of their route modules.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from shared import preview_cache, preview_streams
from shared.database import DatabaseManager, instance_db
from shared.memo import Memo
from shared.resolution_confidence import best_candidate, rerank_cached_resolution
from shared.text_utils import normalize_text
from shared.url_utils import validate_youtube_video_id

logger = logging.getLogger(__name__)

# Deezer/MusicBrainz rows carry no video id, so playing or saving one costs a
# yt-dlp search. Two callers routinely want the same row at the same moment: the
# speculative prefetch for the top results, and the click that follows. This
# collapses them onto one search. The durable cache is SQLite
# (`get_cached_resolution`); the short TTL here only covers the in-flight window
# and the seconds right after it.
_RESOLVE_MEMO_TTL_SEC = 30
_resolutions: Memo[tuple[dict[str, Any], list[dict[str, Any]]]] = Memo(
    ttl_sec=_RESOLVE_MEMO_TTL_SEC,
    maxsize=128,
)


def resolve_candidates(
    get_downloader: Callable[..., Any], artist: str, title: str, duration_s: int | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Map a catalog row (artist + title) to the best YouTube match.

    Cheap on a repeat: SQLite remembers every resolution forever, and concurrent
    callers for the same row share one yt-dlp search rather than each running
    their own.
    """
    db = instance_db()
    cached = cached_resolution(db, artist, title, duration_s)
    if cached and cached.get("id"):
        return cached, cached.get("candidates") or [cached]

    key = f"{normalize_text(artist)}|{normalize_text(title)}|{duration_s or ''}"
    return _resolutions.resolve(key, lambda: _search_candidates(get_downloader, artist, title, duration_s))


def cached_resolution(db: DatabaseManager, artist: str, title: str, duration_s: int | None) -> dict[str, Any] | None:
    """The stored resolution for a song, re-ranked for this caller's running time.

    See `rerank_cached_resolution`. A row resolved without a running time is
    corrected for everyone, so callers that know none stop getting the answer
    that ignored one. A row resolved for a running time keeps it: another time
    is another cut of the same title — a radio edit, a stale client — and gets
    its own answer without overwriting the one stored.
    """
    cached = db.get_cached_resolution(artist, title)
    if not cached:
        return None
    reranked = rerank_cached_resolution(artist, title, duration_s, cached)
    if not reranked:
        return cached
    if cached.get("requested_duration"):
        return {**cached, **reranked}
    db.set_cached_resolution(artist, title, {**reranked, "requested_duration": duration_s})
    return db.get_cached_resolution(artist, title) or cached


def _search_candidates(
    get_downloader: Callable[..., Any], artist: str, title: str, duration_s: int | None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    db = instance_db()
    dl = get_downloader(open_browser=False)
    raw_results = dl.downloader.search_match_candidates(artist, title, max_results=8)
    if not raw_results:
        db.set_cached_resolution(artist, title, {"id": "", "failure_state": "not_found", "confidence": 0.0})
        return {}, []

    best, score, reason, ranked = best_candidate(artist, title, duration_s, raw_results)
    db.set_cached_resolution(
        artist,
        title,
        {
            "id": best.get("id", ""),
            "duration": best.get("duration"),
            "thumbnail": best.get("thumbnail") or f"https://img.youtube.com/vi/{best.get('id', '')}/mqdefault.jpg",
            "webpage_url": best.get("webpage_url") or f"https://www.youtube.com/watch?v={best.get('id', '')}",
            "channel": best.get("channel") or best.get("uploader") or "",
            "confidence": score,
            "confidence_reason": reason,
            "candidates": ranked,
            "requested_duration": duration_s,
        },
    )

    # Kick off stream-URL resolution for the winner in the background. The click
    # that follows this resolve almost always plays exactly this id, and the
    # playback route single-flights on the same key — so its request either
    # finds the URL already warm or joins the extraction already running,
    # instead of starting a second one. Deliberately *not* awaited: blocking the
    # resolve response on it only moves the same wait earlier in the sequence.
    best_id = best.get("id")
    if best_id and validate_youtube_video_id(str(best_id)):
        _warm_preview_stream_url(get_downloader, str(best_id))

    return {**best, "confidence": score, "confidence_reason": reason}, ranked


def _warm_preview_stream_url(get_downloader: Callable[..., Any], video_id: str) -> None:
    """Queue background resolution of `video_id`'s googlevideo URL."""
    try:
        preview_cache.request_prefetch(
            [video_id],
            download=False,
            resolver=lambda vid: preview_streams.resolve(get_downloader, vid),
        )
    except Exception as exc:  # pragma: no cover — best-effort warm-up
        logger.debug("Catalog resolve: could not queue stream-URL warm for %s: %s", video_id, exc)
