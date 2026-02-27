"""Orchestrates recommendation providers and ODST bridge."""

from typing import Any, Dict, List, Optional

from .providers.base import Seed, RawRecommendation
from .bridge import resolve_to_youtube


class RecommendationsService:
    """Builds recommendations from multiple providers and resolves to YouTube via ODST."""

    def __init__(
        self,
        spotify_provider: Any,
        lastfm_provider: Any,
        downloader: Any,
    ):
        self._spotify = spotify_provider
        self._lastfm = lastfm_provider
        self._downloader = downloader

    def get_recommendations(
        self,
        seeds: List[Seed],
        limit: int = 20,
        library_tracks: Optional[List[Dict[str, Any]]] = None,
    ) -> tuple[List[Dict[str, Any]], Optional[str]]:
        """
        Returns (list of items for frontend, optional reason if empty).
        Each item: id, title, duration, thumbnail, webpage_url, channel, artist.
        reason is set when no results (e.g. "spotify_unavailable") for frontend to show message.
        """
        if not seeds:
            return [], "no_seeds"
        raw: List[RawRecommendation] = []
        # Spotify first
        if self._spotify.is_available:
            try:
                raw = self._spotify.get_recommendations(seeds, limit=limit)
            except Exception:
                pass
        # Merge with Last.fm if available
        if self._lastfm.is_available and len(raw) < limit:
            try:
                lfm = self._lastfm.get_recommendations(seeds, limit=limit)
                seen = {(r.artist.lower(), r.title.lower()) for r in raw}
                for r in lfm:
                    if len(raw) >= limit:
                        break
                    key = (r.artist.lower(), r.title.lower())
                    if key not in seen:
                        seen.add(key)
                        raw.append(r)
            except Exception:
                pass
        if not raw:
            if not self._spotify.is_available and not self._lastfm.is_available:
                return [], "providers_unavailable"
            return [], "no_recommendations"
        # Resolve to YouTube via ODST bridge
        try:
            resolved = resolve_to_youtube(raw, self._downloader, library_tracks=library_tracks)
        except Exception:
            return [], "bridge_failed"
        if not resolved:
            return [], "no_matches"
        return resolved, None
