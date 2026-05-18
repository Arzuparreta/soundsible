from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SourceTrack:
    """One row from an external export (Spotify, Apple Music CSV, etc.)."""

    title: str
    artist: str
    album: str = ""
