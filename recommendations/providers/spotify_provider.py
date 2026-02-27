"""Spotify recommendation provider using Spotify Web API recommendations endpoint."""

from typing import List, Optional, Any

from .base import RecommendationProvider, Seed, RawRecommendation


class SpotifyRecommendationProvider(RecommendationProvider):
    """Uses Spotify recommendations API. Requires an authenticated spotipy client."""

    def __init__(self, spotify_client: Optional[Any] = None):
        self._client = spotify_client

    @property
    def is_available(self) -> bool:
        return self._client is not None

    def get_recommendations(self, seeds: List[Seed], limit: int) -> List[RawRecommendation]:
        if not self._client or not seeds:
            return []
        # Spotify allows max 5 seeds (mix of tracks/artists/genres)
        seed_list = seeds[:5]
        seed_track_ids: List[str] = []
        for s in seed_list:
            tid = self._find_track_id(s.artist, s.title)
            if tid and tid not in seed_track_ids:
                seed_track_ids.append(tid)
        if not seed_track_ids:
            return []
        try:
            recs = self._client.recommendations(seed_tracks=seed_track_ids, limit=min(limit, 100))
        except Exception:
            return []
        out: List[RawRecommendation] = []
        for t in recs.get("tracks") or []:
            name = t.get("name") or ""
            artists = t.get("artists") or []
            artist = artists[0]["name"] if artists else ""
            if name and artist:
                out.append(RawRecommendation(artist=artist, title=name))
        return out[:limit]

    def _find_track_id(self, artist: str, title: str) -> Optional[str]:
        """Search Spotify for track by artist and title; return first track id or None."""
        if not artist and not title:
            return None
        q = f"artist:{artist} track:{title}"
        try:
            result = self._client.search(q=q, type="track", limit=1)
            items = (result.get("tracks") or {}).get("items") or []
            if items:
                return items[0].get("id")
        except Exception:
            pass
        return None
