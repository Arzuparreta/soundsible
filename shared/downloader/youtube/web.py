"""The small plain-HTTP calls to youtube.com that need no yt-dlp."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any, Dict, Optional

import requests

from .ids import is_valid_video_id, watch_url
from .ytdlp import yt_proxy

logger = logging.getLogger(__name__)

_OEMBED_URL = "https://www.youtube.com/oembed"
_meta_session_lock = threading.Lock()
_meta_session: Optional[requests.Session] = None

# Resolving a stream normally makes yt-dlp download the video's watch page —
# about 1 MB of HTML — for no reason other than to pick a session identifier out
# of it. The identifier is not per-video, so fetching it once and reusing it lets
# every later resolution skip that megabyte: measured 1338 KB -> 451 KB per
# resolution, which on a relayed station is the difference that shows.
#
# Without one YouTube answers "Sign in to confirm you're not a bot", so a stale
# or missing value must fall back to the full path rather than fail.
_VISITOR_DATA_URL = "https://www.youtube.com/sw.js_data"
_VISITOR_DATA_TTL_SEC = 3600
_visitor_data_lock = threading.Lock()
_visitor_data_cache: Dict[str, Any] = {"value": None, "fetched_at": 0.0}


def _youtube_meta_session() -> requests.Session:
    """Pooled session for the small YouTube metadata calls (oembed, sw.js_data).

    These are a fan-out to one host, and on a relayed station every fresh
    connection is a ~330 ms handshake before the first byte. Pooling turns a
    row of them into one handshake plus cheap follow-ups.
    """
    global _meta_session
    if _meta_session is not None:
        return _meta_session
    with _meta_session_lock:
        if _meta_session is None:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(
                pool_connections=4, pool_maxsize=16, max_retries=0
            )
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            _meta_session = session
    return _meta_session


def _youtube_proxies() -> Optional[Dict[str, str]]:
    """Relay settings for a plain YouTube request, when one is configured."""
    proxy = yt_proxy()
    return {"http": proxy, "https": proxy} if proxy else None


def oembed_creator(video_id: str) -> Optional[str]:
    """The channel behind a video, from YouTube's public oembed endpoint.

    One small JSON response instead of a full extraction: eight of these run in
    ~120 ms against ~5.2 s for eight `extract_info` calls. It carries no
    duration, which is why anything that scores candidates asks a search that
    returns one rather than leaning on enrichment.
    """
    if not is_valid_video_id(video_id):
        return None
    try:
        response = _youtube_meta_session().get(
            _OEMBED_URL,
            params={"url": watch_url(video_id), "format": "json"},
            timeout=10,
            proxies=_youtube_proxies(),
        )
        if not response.ok:
            return None
        author = (response.json() or {}).get("author_name")
        return author.strip() if isinstance(author, str) and author.strip() else None
    except Exception as exc:
        logger.debug("[Search] oembed lookup failed for %s: %s", video_id, exc)
        return None


def _parse_visitor_data(payload: str) -> Optional[str]:
    """Pull the visitor identifier out of the sw.js_data envelope."""
    body = payload.lstrip()
    if body.startswith(")]}'"):
        body = body.split("\n", 1)[-1]
    try:
        def walk(node: Any) -> Optional[str]:
            if isinstance(node, str) and len(node) > 20 and node[:2] in ("Cg", "Ch", "Cs"):
                return node
            if isinstance(node, list):
                for child in node:
                    found = walk(child)
                    if found:
                        return found
            return None

        found = walk(json.loads(body))
        if found:
            return found
    except Exception:
        pass
    match = re.search(r'"(C[a-zA-Z0-9_%-]{20,140})"', payload)
    return match.group(1) if match else None


def visitor_data() -> Optional[str]:
    """A cached visitor identifier, refreshed hourly, or None if unavailable."""
    now = time.time()
    cached = _visitor_data_cache.get("value")
    if cached and now - float(_visitor_data_cache.get("fetched_at") or 0) < _VISITOR_DATA_TTL_SEC:
        return cached
    with _visitor_data_lock:
        cached = _visitor_data_cache.get("value")
        if cached and now - float(_visitor_data_cache.get("fetched_at") or 0) < _VISITOR_DATA_TTL_SEC:
            return cached
        try:
            response = requests.get(
                _VISITOR_DATA_URL,
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=15,
                proxies=_youtube_proxies(),
            )
            response.raise_for_status()
            value = _parse_visitor_data(response.text)
        except Exception as exc:
            logger.debug("[Preview] visitor_data fetch failed: %s", exc)
            value = None
        if value:
            _visitor_data_cache["value"] = value
            _visitor_data_cache["fetched_at"] = now
        return value


def reset_visitor_data() -> None:
    """Drop the cached identifier so the next resolution fetches a fresh one."""
    with _visitor_data_lock:
        _visitor_data_cache["value"] = None
        _visitor_data_cache["fetched_at"] = 0.0
