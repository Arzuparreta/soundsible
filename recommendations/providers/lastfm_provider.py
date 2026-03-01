"""Last.fm recommendation provider using track.getSimilar API."""

import urllib.parse
from typing import List, Optional, Any

import requests

from .base import RecommendationProvider, Seed, RawRecommendation

LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/"


class LastFmRecommendationProvider(RecommendationProvider):
    """Uses Last.fm track.getSimilar. Requires LASTFM_API_KEY."""

    def __init__(self, api_key: Optional[str] = None, cache: Optional[Any] = None):
        self._api_key = (api_key or "").strip()
        self._cache = cache

    @property
    def is_available(self) -> bool:
        return bool(self._api_key)

    def _fetch_similar(self, s: Seed, limit: int, per_seed: int) -> List[RawRecommendation]:
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
            return []

        tracks = (data.get("similartracks") or {}).get("track") or []
        if isinstance(tracks, dict):
            tracks = [tracks]

        fetched: List[RawRecommendation] = []
        for t in tracks:
            if len(fetched) >= limit:
                break
            name = (t.get("name") or "").strip()
            artist_obj = t.get("artist")
            if isinstance(artist_obj, dict):
                artist = (artist_obj.get("name") or "").strip()
            else:
                artist = ""
            if not name and not artist:
                continue

            dur = t.get("duration")
            try:
                duration_sec = int(dur) if dur else None
            except ValueError:
                duration_sec = None

            raw = RawRecommendation(
                title=name,
                artist=artist,
                duration_sec=duration_sec,
            )
            fetched.append(raw)

        return fetched

    def get_recommendations(self, seeds: List[Seed], limit: int) -> List[RawRecommendation]:
        if not self._api_key or not seeds:
            return []
        seen: set = set()
        out: List[RawRecommendation] = []
        per_seed = max(5, (limit // len(seeds)) + 1)
        
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = {executor.submit(self._fetch_similar, s, limit, per_seed): s for s in seeds}
            for future in concurrent.futures.as_completed(futures):
                try:
                    fetched_tracks = future.result()
                    for r in fetched_tracks:
                        if len(out) >= limit:
                            break
                        key = (r.artist.lower(), r.title.lower())
                        if key in seen:
                            continue
                        seen.add(key)
                        out.append(r)
                except Exception:
                    continue
        return out
