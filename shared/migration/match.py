from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, Optional

from shared.migration.models import SourceTrack
from shared.models import Track

AUTO_ACCEPT_THRESHOLD = 0.95
CONFIRM_THRESHOLD = 0.90
_FEAT_PATTERN = re.compile(r"\s*[\(\[](feat\.?|ft\.?|featuring)\s+[^)\]]+[\)\]]", re.IGNORECASE)
_NON_WORD = re.compile(r"[^a-z0-9]+")


def normalize_tokens(text: str) -> str:
    value = unicodedata.normalize("NFKD", str(text or ""))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = _FEAT_PATTERN.sub("", value).casefold()
    return " ".join(_NON_WORD.sub(" ", value).split())


def _ratio(left: str, right: str) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left, right).ratio()


def _duration_score(source: int, local: int) -> float:
    if not source or not local:
        return 1.0
    delta = abs(source - local)
    if delta <= 2:
        return 1.0
    if delta <= 5:
        return 0.85
    if delta <= 12:
        return 0.45
    return 0.0


def track_match_score(source: SourceTrack, local: Track) -> float:
    title = normalize_tokens(source.title)
    artist = normalize_tokens(source.artist)
    album = normalize_tokens(source.album)
    local_title = normalize_tokens(local.title)
    local_artist = normalize_tokens(local.artist or local.album_artist)
    local_album = normalize_tokens(local.album)
    score = (
        0.53 * _ratio(title, local_title)
        + 0.30 * _ratio(artist, local_artist)
        + 0.10 * _ratio(album, local_album)
        + 0.07 * _duration_score(source.duration, int(local.duration or 0))
    )
    if source.isrc and getattr(local, "isrc", None) and source.isrc.casefold() == local.isrc.casefold():
        return 1.0
    return min(1.0, score)


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


class LibraryMatcher:
    """Exact indexes first; fuzzy scoring only on bounded candidate buckets."""

    def __init__(self, tracks: Iterable[Track], *, exclude_podcasts: bool = True):
        self.tracks = [
            track
            for track in tracks
            if not (exclude_podcasts and getattr(track, "media_kind", None) == "podcast_episode")
        ]
        self.by_isrc: dict[str, list[Track]] = defaultdict(list)
        self.by_title_artist: dict[tuple[str, str], list[Track]] = defaultdict(list)
        self.by_title: dict[str, list[Track]] = defaultdict(list)
        self.by_artist: dict[str, list[Track]] = defaultdict(list)
        self.by_token: dict[str, list[Track]] = defaultdict(list)
        for track in self.tracks:
            title = normalize_tokens(track.title)
            artist = normalize_tokens(track.artist or track.album_artist)
            isrc = str(getattr(track, "isrc", None) or "").casefold()
            if isrc:
                self.by_isrc[isrc].append(track)
            self.by_title_artist[(title, artist)].append(track)
            self.by_title[title].append(track)
            self.by_artist[artist].append(track)
            for token in set(title.split()[:4] + artist.split()[:3]):
                if len(token) >= 3:
                    self.by_token[token].append(track)

    def candidates(self, source: SourceTrack) -> list[Track]:
        if source.isrc and source.isrc.casefold() in self.by_isrc:
            return self.by_isrc[source.isrc.casefold()]
        title = normalize_tokens(source.title)
        artist = normalize_tokens(source.artist)
        exact = self.by_title_artist.get((title, artist))
        if exact:
            return exact
        pool: dict[str, Track] = {}
        for track in self.by_title.get(title, []):
            pool[track.id] = track
        for track in self.by_artist.get(artist, []):
            pool[track.id] = track
        for token in set(title.split()[:3] + artist.split()[:2]):
            if len(token) >= 3:
                for track in self.by_token.get(token, [])[:80]:
                    pool[track.id] = track
        return list(pool.values())[:120]

    def match(self, source: SourceTrack, source_index: int = 0, min_score: float = CONFIRM_THRESHOLD) -> MatchResult:
        best: Track | None = None
        best_score = 0.0
        for track in self.candidates(source):
            score = track_match_score(source, track)
            if score > best_score:
                best = track
                best_score = score
        matched_id = best.id if best and best_score >= min_score else None
        confidence = best_score if matched_id else 0.0
        return MatchResult(
            source_index=source_index,
            source=source,
            confidence=confidence,
            matched_track_id=matched_id,
            auto_accept=bool(matched_id and confidence >= AUTO_ACCEPT_THRESHOLD),
            needs_confirmation=bool(matched_id and confidence < AUTO_ACCEPT_THRESHOLD),
        )


def match_sources_to_library(
    sources: list[SourceTrack],
    library_tracks: Iterable[Track],
    *,
    exclude_podcasts: bool = True,
    min_score: float = CONFIRM_THRESHOLD,
) -> list[MatchResult]:
    matcher = LibraryMatcher(library_tracks, exclude_podcasts=exclude_podcasts)
    return [matcher.match(source, index, min_score) for index, source in enumerate(sources)]


def migration_stats(results: list[MatchResult]) -> dict:
    total = len(results)
    matched = sum(1 for result in results if result.matched_track_id)
    auto = sum(1 for result in results if result.auto_accept)
    pending = sum(1 for result in results if result.needs_confirmation)
    unmatched = total - matched
    return {
        "total": total,
        "matched": matched,
        "auto_accept": auto,
        "needs_confirmation": pending,
        "unmatched": unmatched,
        "matched_ratio": round(matched / total, 5) if total else 1.0,
    }
