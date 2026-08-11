"""MusicBrainz recording identity shared across catalog and audio boundaries."""

from __future__ import annotations

import uuid
from typing import Any


MUSICBRAINZ_UFID_OWNER = "http://musicbrainz.org"
MUSICBRAINZ_VORBIS_RECORDING_TAG = "musicbrainz_trackid"
MUSICBRAINZ_MP4_RECORDING_TAG = "----:com.apple.iTunes:MusicBrainz Track Id"


def normalize_recording_mbid(value: Any) -> str | None:
    """Return one canonical Recording MBID, rejecting loose UUID spellings.

    MusicBrainz identifiers are canonical 36-character UUIDs. Accepting braces,
    compact hex, or arbitrary client text would make invalid identifiers look
    authoritative once they reach an audio tag.
    """
    if isinstance(value, bytes):
        try:
            value = value.decode("ascii")
        except UnicodeDecodeError:
            return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if len(text) != 36:
        return None
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError):
        return None
    canonical = str(parsed)
    return canonical if text.casefold() == canonical else None


def first_recording_mbid(value: Any) -> str | None:
    """Find the first valid Recording MBID in a tag's scalar/list value."""
    if isinstance(value, (list, tuple)):
        for item in value:
            found = first_recording_mbid(item)
            if found:
                return found
        return None
    return normalize_recording_mbid(value)
