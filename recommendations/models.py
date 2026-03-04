"""Recommendation data types: seed tracks and raw recommendations."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class Seed:
    """A seed track for recommendations (artist + title)."""
    artist: str
    title: str


@dataclass
class RawRecommendation:
    """A recommended track (artist + title). May contain rich metadata."""
    artist: str
    title: str
    album: Optional[str] = None
    album_artist: Optional[str] = None
    duration_sec: Optional[int] = None
    cover_url: Optional[str] = None
    isrc: Optional[str] = None
    year: Optional[int] = None
    track_number: Optional[int] = None
