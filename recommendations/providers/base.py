"""Abstract recommendation provider interface."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List


@dataclass
class Seed:
    """A seed track for recommendations (artist + title)."""
    artist: str
    title: str


@dataclass
class RawRecommendation:
    """A recommended track from a provider (artist + title, no YouTube ID yet)."""
    artist: str
    title: str


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
