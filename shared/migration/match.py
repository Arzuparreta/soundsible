from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, List, Optional

from shared.migration.models import SourceTrack
from shared.models import Track

# Phase 1 contract: auto-apply only when match confidence is very high.
AUTO_ACCEPT_THRESHOLD = 0.95
# Rows in [CONFIRM_THRESHOLD, AUTO_ACCEPT_THRESHOLD) should be shown for explicit confirmation.
CONFIRM_THRESHOLD = 0.90

_FEAT_PATTERN = re.compile(
    r"\s*[\(\[](feat\.?|ft\.?|featuring)\s+[^)\]]+[\)\]]",
    re.IGNORECASE,
)


def normalize_tokens(text: str) -> str:
    t = (text or "").strip().lower()
    t = _FEAT_PATTERN.sub("", t)
    t = re.sub(r"\s+", " ", t)
    return t


def _ratio(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def track_match_score(src: SourceTrack, lib: Track) -> float:
    nt = normalize_tokens(src.title)
    na = normalize_tokens(src.artist)
    nal = normalize_tokens(src.album)
    lt = normalize_tokens(lib.title)
    la = normalize_tokens(lib.artist)
    lal = normalize_tokens(lib.album)
    return 0.52 * _ratio(nt, lt) + 0.33 * _ratio(na, la) + 0.15 * _ratio(nal, lal)


@dataclass
class MatchResult:
    source_index: int
    source: SourceTrack
    confidence: float
    matched_track_id: Optional[str]
    auto_accept: bool
    needs_confirmation: bool

    def to_dict(self) -> dict:
        return {
            "source_index": self.source_index,
            "source_title": self.source.title,
            "source_artist": self.source.artist,
            "source_album": self.source.album,
            "confidence": round(self.confidence, 4),
            "matched_track_id": self.matched_track_id,
            "auto_accept": self.auto_accept,
            "needs_confirmation": self.needs_confirmation,
        }


def match_sources_to_library(
    sources: List[SourceTrack],
    library_tracks: Iterable[Track],
    *,
    exclude_podcasts: bool = True,
    min_score: float = CONFIRM_THRESHOLD,
) -> List[MatchResult]:
    """Greedy best match per source row (library tracks may match multiple sources — Phase 1 baseline)."""
    pool = [t for t in library_tracks if not (exclude_podcasts and getattr(t, "media_kind", None) == "podcast_episode")]
    out: List[MatchResult] = []
    for i, src in enumerate(sources):
        best_track: Optional[Track] = None
        best_score = 0.0
        for t in pool:
            sc = track_match_score(src, t)
            if sc > best_score:
                best_score = sc
                best_track = t

        matched_id = best_track.id if best_track and best_score >= min_score else None
        eff_conf = best_score if matched_id else 0.0
        out.append(
            MatchResult(
                source_index=i,
                source=src,
                confidence=eff_conf,
                matched_track_id=matched_id,
                auto_accept=bool(matched_id and eff_conf >= AUTO_ACCEPT_THRESHOLD),
                needs_confirmation=bool(matched_id and CONFIRM_THRESHOLD <= eff_conf < AUTO_ACCEPT_THRESHOLD),
            )
        )
    return out


def migration_stats(results: List[MatchResult]) -> dict:
    total = len(results)
    matched = sum(1 for r in results if r.matched_track_id)
    auto = sum(1 for r in results if r.auto_accept)
    pending = sum(1 for r in results if r.needs_confirmation)
    unmatched = total - matched
    ratio = (matched / total) if total else 1.0
    return {
        "total": total,
        "matched": matched,
        "auto_accept": auto,
        "needs_confirmation": pending,
        "unmatched": unmatched,
        "matched_ratio": round(ratio, 5),
    }
