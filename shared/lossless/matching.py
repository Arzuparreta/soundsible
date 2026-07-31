from __future__ import annotations

import re
import unicodedata

from shared.music_identity import canonical_music_identity
from shared.models import Track

from .models import LosslessCandidate

VERSION_MARKERS = {
    "acoustic",
    "demo",
    "instrumental",
    "live",
    "mix",
    "remaster",
    "remastered",
    "remix",
    "session",
}


def normalize_text(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value or "").casefold())
    ascii_text = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    ascii_text = re.sub(r"\b(feat|featuring|ft)\.?\b", " ", ascii_text)
    return " ".join(re.findall(r"[a-z0-9]+", ascii_text))


def _markers(value: str) -> set[str]:
    return set(normalize_text(value).split()).intersection(VERSION_MARKERS)


def metadata_match(track: Track, candidate: LosslessCandidate) -> bool:
    track_identity = canonical_music_identity(track.artist, track.title, channel=track.artist)
    candidate_identity = canonical_music_identity(
        candidate.artist, candidate.title, channel=candidate.artist
    )
    if normalize_text(track_identity.title) != normalize_text(candidate_identity.title):
        return False
    if normalize_text(track_identity.artist) != normalize_text(candidate_identity.artist):
        return False
    if track_identity.version_tokens != candidate_identity.version_tokens:
        return False
    if track.duration and candidate.duration and abs(int(track.duration) - int(candidate.duration)) > 3:
        return False
    return True
