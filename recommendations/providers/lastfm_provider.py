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
        if self._cache:
            cached = self._cache.get_lastfm_similar(s.artist, s.title)
            if cached is not None:
                out = []
                for d in cached:
                    out.append(RawRecommendation(
                        title=d.get("title", ""),
                        artist=d.get("artist", ""),
                        album=d.get("album"),
                        album_artist=d.get("album_artist"),
                        duration_sec=d.get("duration_sec"),
                        cover_url=d.get("cover_url"),
                        isrc=d.get("isrc"),
                        year=d.get("year"),
                        track_number=d.get("track_number")
                    ))
                return out

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

            images = t.get("image") or []
            cover_url = None
            if isinstance(images, list):
                for img in reversed(images):
                    if img.get("#text"):
                        cover_url = img.get("#text")
                        break
                        
            dur = t.get("duration")
            try:
                duration_sec = int(dur) if dur else None
            except ValueError:
                duration_sec = None

            raw = RawRecommendation(
                title=name,
                artist=artist,
                duration_sec=duration_sec,
                cover_url=cover_url
            )
            fetched.append(raw)

        if self._cache:
            # Save raw recommendations as dicts for Json serialization
            self._cache.set_lastfm_similar(s.artist, s.title, [f.__dict__ for f in fetched])
            
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
