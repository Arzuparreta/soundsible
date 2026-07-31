"""Pieces every discovery module needs.

`_get_api` is the service locator the blueprints use to reach back into
`shared.api` without importing it at module load, which would be circular.
The iTunes endpoints and headers sit here because both the podcast directory
and the recommendation routes read them.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

_ITUNES_SEARCH = "https://itunes.apple.com/search"
_ITUNES_LOOKUP = "https://itunes.apple.com/lookup"
_APPLE_PODCAST_TOP = "https://rss.itunes.apple.com/api/v1/{country}/podcasts/top-podcasts/all/{limit}/{explicit}.json"

_HTTP_HEADERS_RSS = {
    "User-Agent": "SoundsibleDiscovery/1.0",
    "Accept": "application/json,text/plain,*/*",
}
_HTTP_HEADERS_ITUNES = {"User-Agent": "SoundsibleDiscovery/1.0"}

_LOOKUP_CHUNK = 40
_ITUNES_TOP_FALLBACK_TERMS = ("podcast", "news", "comedy", "technology", "sports")

# ── Feed cache state (shared between discovery_feed and invalidation) ──
_DEEZER_TRACK_CACHE_TTL_SEC = 180
_MAX_PERSONALIZED_SEEDS = 5
_DISCOVERY_FEED_CACHE: dict[str, tuple[float, float, dict]] = {}
_DISCOVERY_FEED_TTL_SEC = 180
_DISCOVERY_FEED_STALE_SEC = 3600
_DISCOVERY_FEED_INFLIGHT: set[str] = set()
_DISCOVERY_FEED_LOCK = threading.Lock()
_DISCOVERY_FEED_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="soundsible-discovery")

# ── Auto Mode / Planner constants ──
_PLAN_RESOLVE_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="soundsible-plan-resolve")
_CANONICAL_RESOLVE_BUDGET_SEC = 2.5
_AUTO_CONTEXT_MAX = 5
_AUTO_GRAPH_ANCHORS = 4
_AUTO_GRAPH_FETCH_MISSES = 2
_AUTO_RAW_LIMIT = 100
_AUTO_SHORTLIST_LIMIT = 48
_AUTO_ROUTER_LIMIT = 24


def _invalidate_personalized_cache() -> None:
    from shared.user_context import current_user_id

    feed_prefix = f"discovery-feed-v4:{current_user_id() or '-'}:"
    now = time.time()
    with _DISCOVERY_FEED_LOCK:
        for key in [key for key in _DISCOVERY_FEED_CACHE if key.startswith(feed_prefix)]:
            _, stale_until, body = _DISCOVERY_FEED_CACHE[key]
            _DISCOVERY_FEED_CACHE[key] = (0, max(stale_until, now + _DISCOVERY_FEED_STALE_SEC), body)


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
        "image_url": (r.get("artworkUrl600") or r.get("artworkUrl100") or "").strip(),
    }


def _get_api():
    import shared.api as api_mod
    from shared.user_context import current_user_id

    return {
        "get_core": api_mod.get_core,
        "user_id": current_user_id(),
        "get_downloader": api_mod.get_downloader,
        "queue_manager_dl": api_mod.queue_manager_dl,
        "start_downloader_pump": api_mod.start_downloader_pump,
        "parse_intake_item": api_mod.parse_intake_item,
        "_mod": api_mod,
    }
