"""Abstract recommendation provider interface."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Seed:
    """A seed track for recommendations (artist + title)."""
    artist: str
    title: str


@dataclass
class RawRecommendation:
    """A recommended track from a provider (artist + title). May contain rich metadata."""
    artist: str
    title: str
    album: Optional[str] = None
    album_artist: Optional[str] = None
    duration_sec: Optional[int] = None
    cover_url: Optional[str] = None
    isrc: Optional[str] = None
    year: Optional[int] = None
    track_number: Optional[int] = None


class RecommendationProvider(ABC):
    """Interface for recommendation providers (Spotify, Last.fm, etc.)."""

    @abstractmethod
    def get_recommendations(self, seeds: List[Seed], limit: int) -> List[RawRecommendation]:
        """Return list of recommended tracks (artist, title). May return fewer than limit."""
        pass

    @property
    @abstractmethod
    def is_available(self) -> bool:
        """Whether the provider is configured and usable."""
        pass
