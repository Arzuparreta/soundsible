"""Pieces every discovery module needs.

`_get_api` is the service locator the blueprints use to reach back into
`shared.api` without importing it at module load, which would be circular.
The iTunes endpoints and headers sit here because both the podcast directory
and the recommendation routes read them.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

from shared.download_pump import get_downloader, queue_manager_dl, start_downloader_pump
from shared.download_queue import parse_intake_item
from shared.realtime import emit_to_user
from shared.user_context import current_user_id
from shared.user_cores import favourite_library_ids, get_library

logger = logging.getLogger(__name__)

_ITUNES_SEARCH = "https://itunes.apple.com/search"
_ITUNES_LOOKUP = "https://itunes.apple.com/lookup"
_APPLE_PODCAST_TOP = "https://rss.marketingtools.apple.com/api/v2/{country}/podcasts/top/{limit}/podcasts.json"

_HTTP_HEADERS_RSS = {
    "User-Agent": "SoundsibleDiscovery/1.0",
    "Accept": "application/json,text/plain,*/*",
}
_HTTP_HEADERS_ITUNES = {"User-Agent": "SoundsibleDiscovery/1.0"}

_LOOKUP_CHUNK = 40
_ITUNES_TOP_FALLBACK_TERMS = ("podcast", "news", "comedy", "technology", "sports")

_MZSTATIC_SIZE = re.compile(r"/\d+x\d+bb(\.\w+)?$")


def _apple_artwork(item: dict) -> str:
    """The largest artwork an Apple row offers. The top charts only carry
    `artworkUrl100`; Apple's image service renders the same picture at any size
    named in the path, so that thumbnail is asked for at 600x600 instead."""
    for key in ("artworkUrl600", "artworkUrl512", "artworkUrl100"):
        url = item.get(key)
        if isinstance(url, str) and url.strip():
            url = url.strip()
            if key == "artworkUrl100" and (urlsplit(url).hostname or "").endswith(".mzstatic.com"):
                url = _MZSTATIC_SIZE.sub(lambda m: "/600x600bb" + (m.group(1) or ""), url)
            return url
    return ""


# ── Feed cache state (shared between discovery_feed and invalidation) ──
_DEEZER_TRACK_CACHE_TTL_SEC = 180
_MAX_PERSONALIZED_SEEDS = 5
_DISCOVERY_FEED_CACHE: dict[str, tuple[float, float, dict]] = {}
_DISCOVERY_FEED_TTL_SEC = 180
_DISCOVERY_FEED_STALE_SEC = 3600
_DISCOVERY_FEED_INFLIGHT: set[str] = set()
_DISCOVERY_FEED_DIRTY: set[str] = set()
_DISCOVERY_FEED_LOCK = threading.Lock()
_DISCOVERY_FEED_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="soundsible-discovery")


def _invalidate_personalized_cache_for_user(user_id: str | None) -> list[tuple[str, int]]:
    feed_prefix = f"discovery-feed-v4:{user_id or '-'}:"
    now = time.time()
    entries: list[tuple[str, int]] = []
    seen: set[str] = set()
    with _DISCOVERY_FEED_LOCK:
        matching_cache = [key for key in _DISCOVERY_FEED_CACHE if key.startswith(feed_prefix)]
        matching_inflight = [key for key in _DISCOVERY_FEED_INFLIGHT if key.startswith(feed_prefix)]
        for key in matching_cache:
            _, stale_until, body = _DISCOVERY_FEED_CACHE[key]
            _DISCOVERY_FEED_CACHE[key] = (0, max(stale_until, now + _DISCOVERY_FEED_STALE_SEC), body)
        for key in matching_inflight:
            _DISCOVERY_FEED_DIRTY.add(key)
        for key in (*matching_cache, *matching_inflight):
            if key in seen:
                continue
            seen.add(key)
            try:
                limit = int(key.rsplit(":", 1)[1])
            except (IndexError, ValueError):
                limit = 10
            entries.append((key, limit))
    return entries


def _invalidate_personalized_cache() -> None:
    from shared.user_context import current_user_id

    _invalidate_personalized_cache_for_user(current_user_id())


def _podcast_row_from_itunes_search(r: dict) -> dict | None:
    if not isinstance(r, dict):
        return None
    feed = (r.get("feedUrl") or "").strip()
    if not feed:
        return None
    cid = r.get("collectionId")
    cid_str = str(cid) if cid is not None else ""
    if not cid_str:
        return None
    return {
        "itunes_collection_id": cid_str,
        "title": (r.get("collectionName") or "").strip() or "Podcast",
        "author": (r.get("artistName") or "").strip(),
        "feed_url": feed,
        "image_url": _apple_artwork(r),
    }


def _get_api():
    return {
        "get_library": get_library,
        "user_id": current_user_id(),
        "get_downloader": get_downloader,
        "queue_manager_dl": queue_manager_dl,
        "start_downloader_pump": start_downloader_pump,
        "parse_intake_item": parse_intake_item,
        "favourite_library_ids": favourite_library_ids,
        "emit_to_user": emit_to_user,
    }
