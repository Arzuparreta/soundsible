"""Discover recommendations engine: external graph (Spotify, Last.fm) + ODST bridge."""

from .service import RecommendationsService
from .providers.base import Seed, RawRecommendation

__all__ = ["RecommendationsService", "Seed", "RawRecommendation"]
