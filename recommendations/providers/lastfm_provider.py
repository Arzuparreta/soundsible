"""Last.fm recommendation provider using track.getSimilar API."""

import urllib.parse
from typing import List, Optional

import requests

from .base import RecommendationProvider, Seed, RawRecommendation

LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/"


class LastFmRecommendationProvider(RecommendationProvider):
    """Uses Last.fm track.getSimilar. Requires LASTFM_API_KEY."""

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = (api_key or "").strip()

    @property
    def is_available(self) -> bool:
        return bool(self._api_key)

    def get_recommendations(self, seeds: List[Seed], limit: int) -> List[RawRecommendation]:
        if not self._api_key or not seeds:
            return []
        seen: set = set()
        out: List[RawRecommendation] = []
        per_seed = max(5, (limit // len(seeds)) + 1)
        for s in seeds:
            if len(out) >= limit:
                break
            try:
                params = {
                    "method": "track.getSimilar",
                    "artist": s.artist,
                    "track": s.title,
                    "api_key": self._api_key,
                    "format": "json",
                    "limit": per_seed,
                }
                r = requests.get(LASTFM_API_BASE, params=params, timeout=10)
                r.raise_for_status()
                data = r.json()
            except Exception:
                continue
            tracks = (data.get("similartracks") or {}).get("track") or []
            if isinstance(tracks, dict):
                tracks = [tracks]
            for t in tracks:
                if len(out) >= limit:
                    break
                name = (t.get("name") or "").strip()
                artist_obj = t.get("artist")
                if isinstance(artist_obj, dict):
                    artist = (artist_obj.get("name") or "").strip()
                else:
                    artist = ""
                if not name and not artist:
                    continue
                key = (artist.lower(), name.lower())
                if key in seen:
                    continue
                seen.add(key)
                out.append(RawRecommendation(artist=artist or "Unknown", title=name or "Unknown"))
        return out[:limit]
