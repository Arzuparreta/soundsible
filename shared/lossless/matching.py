from __future__ import annotations

import re
import unicodedata

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
    if normalize_text(track.title) != normalize_text(candidate.title):
        return False
    if normalize_text(track.artist) != normalize_text(candidate.artist):
        return False
    if _markers(track.title) != _markers(candidate.title):
        return False
    if track.duration and candidate.duration and abs(int(track.duration) - int(candidate.duration)) > 3:
        return False
    return True
