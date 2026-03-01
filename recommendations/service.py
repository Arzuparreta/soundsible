"""Orchestrates recommendation providers and ODST bridge."""

from typing import Any, Dict, List, Optional

from .providers.base import Seed, RawRecommendation
from .bridge import resolve_to_youtube


class RecommendationsService:
    """Builds recommendations from Last.fm and resolves to YouTube via ODST."""

    def __init__(self, lastfm_provider: Any, downloader: Any):
        self._lastfm = lastfm_provider
        self._downloader = downloader

    def get_recommendations(
        self,
        seeds: List[Seed],
        limit: int = 20,
        library_tracks: Optional[List[Dict[str, Any]]] = None,
        resolve: bool = True,
    ) -> tuple[List[Dict[str, Any]], Optional[str]]:
        """
        Returns (list of items for frontend, optional reason if empty).
        Each item: id, title, duration, thumbnail, webpage_url, channel, artist.
        """
        if not seeds:
            return [], "no_seeds"
        raw: List[RawRecommendation] = []
        if getattr(self._lastfm, "is_available", False):
            try:
                raw = self._lastfm.get_recommendations(seeds, limit=limit)
            except Exception:
                pass
        if not raw:
            if not getattr(self._lastfm, "is_available", False):
                return [], "providers_unavailable"
            return [], "no_recommendations"
        
        # If not resolving, just return the raw recommendations formatted as dicts
        if not resolve:
            raw_dicts = []
            for r in raw:
                r_dict = {
                    "artist": r.artist,
                    "title": r.title,
                    "album": r.album,
                    "album_artist": r.album_artist,
                    "duration_sec": r.duration_sec,
                    "isrc": r.isrc,
                    "year": r.year,
                    "track_number": r.track_number,
                    "id": "",  # To be resolved later; cover from /api/discover/cover (YouTube)
                }
                raw_dicts.append(r_dict)
            return raw_dicts, None
        # Resolve to YouTube via ODST bridge
        try:
            resolved = resolve_to_youtube(raw, self._downloader, library_tracks=library_tracks)
        except Exception:
            return [], "bridge_failed"
        if not resolved:
            return [], "no_matches"
        return resolved, None
