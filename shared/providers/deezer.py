"""The one client for Deezer's public API.

Deezer is metadata only — it is how the catalog and discovery views browse, and
it never supplies audio. Two independent clients had grown for it, in
`routes/catalog.py` and `routes/discovery.py`, with different timeouts,
different User-Agents, and only one of them caching. A cache-missing artist page
fired five uncached calls, and every call opened a new TCP+TLS connection
because nothing in `shared/api/` used a session — the same cost
`shared/preview_cache.py` documents as ~330 ms versus ~90 ms pooled.

This module is that client: one pooled session, one bounded cache with
single-flight, one timeout policy.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter

from shared.api.memo import Memo

logger = logging.getLogger(__name__)

HOST = "https://api.deezer.com"
USER_AGENT = "Soundsible/1.0"

#: Deezer is a browse surface: catalogues move slowly and a stale artist page
#: costs nothing, while a re-fetch costs a round trip on every navigation.
DEFAULT_TTL_SEC = 600
#: Distinct paths kept. Keys are path+params, so this bounds what an instance
#: accumulates across every artist and album anyone ever opens.
MAX_ENTRIES = 512
DEFAULT_TIMEOUT_SEC = 8

_session_lock = threading.Lock()
_session: Optional[requests.Session] = None
#: Deezer requests fan out (profile, top tracks, releases, related in parallel),
#: so the pool has to hold more than one.
_POOL_MAXSIZE = 16

_memo: Memo[dict] = Memo(ttl_sec=DEFAULT_TTL_SEC, maxsize=MAX_ENTRIES)


def session() -> requests.Session:
    """The shared session every Deezer call goes through."""
    global _session
    if _session is not None:
        return _session
    with _session_lock:
        if _session is None:
            built = requests.Session()
            adapter = HTTPAdapter(pool_connections=4, pool_maxsize=_POOL_MAXSIZE)
            built.mount("https://", adapter)
            built.headers["User-Agent"] = USER_AGENT
            _session = built
    return _session


def _cache_key(path: str, params: dict[str, Any]) -> str:
    ordered = tuple(sorted((str(k), str(v)) for k, v in params.items()))
    return f"{path}?{ordered}"


def get(
    path: str,
    params: dict[str, Any] | None = None,
    *,
    timeout: float = DEFAULT_TIMEOUT_SEC,
    ttl_sec: Optional[float] = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    """GET a Deezer path, returning its JSON object (`{}` when it isn't one).

    Cached and single-flighted by default: N concurrent requests for the same
    artist collapse onto one upstream call instead of N.

    Raises whatever `requests` raises; callers decide what a failed browse means
    for their view.
    """
    params = params or {}
    key = _cache_key(path, params)

    def fetch() -> dict[str, Any]:
        response = session().get(f"{HOST}/{path}", params=params, timeout=timeout)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    if not use_cache:
        return fetch()

    if ttl_sec is not None and ttl_sec != DEFAULT_TTL_SEC:
        cached = _memo.get(key)
        if cached is not None:
            return cached
        value = fetch()
        _memo.put(key, value, ttl_sec=ttl_sec)
        return value

    return _memo.resolve(key, fetch)


def rows(path: str, params: dict[str, Any] | None = None, **kwargs: Any) -> list[dict[str, Any]]:
    """The `data` list from a Deezer response, or an empty list."""
    data = get(path, params, **kwargs)
    listed = data.get("data")
    return [row for row in listed if isinstance(row, dict)] if isinstance(listed, list) else []


def clear_cache() -> None:
    """Drop every cached response. Tests and manual refreshes."""
    _memo.clear()
