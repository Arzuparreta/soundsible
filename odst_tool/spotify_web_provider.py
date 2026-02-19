"""
Spotify web candidate provider without user API credentials.
Uses public web token + catalog search endpoints.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional
import requests

_session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=2)
_session.mount("https://", adapter)
_session.mount("http://", adapter)

_cached_token: Optional[str] = None
_token_expiry_ts: float = 0.0


def _get_public_token() -> Optional[str]:
    global _cached_token, _token_expiry_ts
    now = time.time()
    if _cached_token and now < _token_expiry_ts:
        return _cached_token
    try:
        # Public endpoint used by Spotify web app.
        resp = _session.get(
            "https://open.spotify.com/get_access_token",
            params={"reason": "transport", "productType": "web_player"},
            timeout=6,
        )
        if resp.status_code != 200:
            return None
        payload = resp.json()
        token = payload.get("accessToken")
        ttl_ms = int(payload.get("accessTokenExpirationTimestampMs") or 0)
        if not token:
            return None
        _cached_token = token
        if ttl_ms:
            _token_expiry_ts = max(now + 30.0, (ttl_ms / 1000.0) - 15.0)
        else:
            _token_expiry_ts = now + 300.0
        return _cached_token
    except Exception:
        return None


def search_candidates(artist: str, title: str, limit: int = 6) -> List[Dict[str, Any]]:
    token = _get_public_token()
    if not token:
        return []
    artist = (artist or "").strip()
    title = (title or "").strip()
    if not title:
        return []
    query = f'track:{title} artist:{artist}'.strip()
    headers = {"Authorization": f"Bearer {token}"}
    params = {"q": query, "type": "track", "limit": max(1, limit)}

    try:
        resp = _session.get("https://api.spotify.com/v1/search", headers=headers, params=params, timeout=7)
    except Exception:
        return []
    if resp.status_code != 200:
        return []

    out: List[Dict[str, Any]] = []
    for item in ((resp.json() or {}).get("tracks") or {}).get("items", []):
        out.append(
            {
                "title": item.get("name") or "",
                "artist": ((item.get("artists") or [{}])[0].get("name") or ""),
                "album": ((item.get("album") or {}).get("name") or ""),
                "duration_sec": int((item.get("duration_ms") or 0) / 1000),
                "isrc": ((item.get("external_ids") or {}).get("isrc") if isinstance(item.get("external_ids"), dict) else None),
                "album_artist": (((item.get("album") or {}).get("artists") or [{}])[0].get("name") or ""),
                "cover_url": (((item.get("album") or {}).get("images") or [{}])[0].get("url")),
                "catalog_source": "spotify_web",
                "catalog_id": item.get("id"),
                "spotify_id": item.get("id"),
            }
        )
    return out

