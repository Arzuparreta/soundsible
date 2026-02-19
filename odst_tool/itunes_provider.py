"""
iTunes candidate provider.
Returns normalized candidate dicts for metadata scoring.
"""

from __future__ import annotations

from typing import Any, Dict, List
import requests

_session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=2)
_session.mount("https://", adapter)
_session.mount("http://", adapter)


def search_candidates(artist: str, title: str, limit: int = 6) -> List[Dict[str, Any]]:
    artist = (artist or "").strip()
    title = (title or "").strip()
    if not title:
        return []

    query = f"{artist} {title}".strip()
    params = {"term": query, "media": "music", "entity": "song", "limit": max(1, limit)}
    try:
        response = _session.get("https://itunes.apple.com/search", params=params, timeout=7)
    except Exception:
        return []
    if response.status_code != 200:
        return []

    out: List[Dict[str, Any]] = []
    for item in response.json().get("results", []):
        out.append(
            {
                "title": item.get("trackName") or "",
                "artist": item.get("artistName") or "",
                "album": item.get("collectionName") or "",
                "duration_sec": int((item.get("trackTimeMillis") or 0) / 1000),
                "isrc": ((item.get("externalIds") or {}).get("isrc") if isinstance(item.get("externalIds"), dict) else None),
                "album_artist": item.get("collectionArtistName") or item.get("artistName") or "",
                "cover_url": (item.get("artworkUrl100") or "").replace("100x100bb", "600x600bb"),
                "catalog_source": "itunes",
                "catalog_id": str(item.get("trackId") or ""),
            }
        )
    return out

