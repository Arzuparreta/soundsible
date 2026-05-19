"""
Resolution confidence scoring for YouTube ↔ Deezer track matching.

Returns a float 0–1 confidence score for a candidate YouTube result given
a known artist, title, and optional duration from a Deezer source.

Thresholds:
  HIGH   >= 0.75  — direct save, no review needed
  MEDIUM  0.40–0.74 — show alternatives sheet before saving
  LOW    < 0.40  — surface alternatives; warn user match is uncertain
"""

from __future__ import annotations

import re
import unicodedata

_PAREN_RE = re.compile(r"\s*[\(\[].*?[\)\]]")
_PUNCT_RE = re.compile(r"[^\w\s]")
_WS_RE = re.compile(r"\s+")

_FILLER_WORDS = frozenset(
    ["official", "video", "audio", "lyrics", "hd", "hq", "4k", "music", "ft", "feat"]
)

CONFIDENCE_HIGH = 0.75
CONFIDENCE_MEDIUM = 0.40


def _norm(text: str) -> str:
    """Lowercase, strip parens/brackets, punctuation, filler words, collapse whitespace."""
    if not text:
        return ""
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    t = t.lower()
    t = _PAREN_RE.sub("", t)
    t = _PUNCT_RE.sub(" ", t)
    t = _WS_RE.sub(" ", t).strip()
    words = [w for w in t.split() if w not in _FILLER_WORDS]
    return " ".join(words)


def _token_overlap(a: str, b: str) -> float:
    """Jaccard overlap on word tokens."""
    ta = set(a.split())
    tb = set(b.split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def score_candidate(
    artist: str,
    title: str,
    duration_s: int | float | None,
    candidate: dict,
) -> tuple[float, str]:
    """
    Score a YouTube search result candidate.

    Returns (score 0–1, reason_code).
    reason_code is one of: title_artist_duration, title_artist, title_only, weak, no_match
    """
    norm_title = _norm(title)
    norm_artist = _norm(artist)
    cand_title = _norm(candidate.get("title") or "")
    cand_channel = _norm(candidate.get("channel") or candidate.get("uploader") or "")
    cand_duration = candidate.get("duration") or 0

    score = 0.0

    # — Title similarity (up to 0.45) —
    if norm_title and cand_title:
        if norm_title == cand_title:
            title_score = 0.45
        elif norm_title in cand_title or cand_title in norm_title:
            title_score = 0.35
        else:
            overlap = _token_overlap(norm_title, cand_title)
            title_score = overlap * 0.35
        score += title_score
    else:
        title_score = 0.0

    # — Artist/channel similarity (up to 0.30) —
    if norm_artist and cand_channel:
        if norm_artist == cand_channel:
            artist_score = 0.30
        elif norm_artist in cand_channel or cand_channel in norm_artist:
            artist_score = 0.22
        else:
            overlap = _token_overlap(norm_artist, cand_channel)
            artist_score = overlap * 0.22
        score += artist_score
    else:
        artist_score = 0.0

    # — Duration delta (up to 0.25, penalty if very wrong) —
    duration_score = 0.0
    if duration_s and cand_duration:
        delta = abs(float(duration_s) - float(cand_duration))
        if delta <= 2:
            duration_score = 0.25
        elif delta <= 5:
            duration_score = 0.18
        elif delta <= 15:
            duration_score = 0.08
        elif delta > 30:
            duration_score = -0.10
        score += duration_score

    score = max(0.0, min(1.0, score))

    # Build reason code
    has_title = title_score >= 0.25
    has_artist = artist_score >= 0.15
    has_duration = duration_score >= 0.08
    if has_title and has_artist and has_duration:
        reason = "title_artist_duration"
    elif has_title and has_artist:
        reason = "title_artist"
    elif has_title:
        reason = "title_only"
    elif score >= CONFIDENCE_MEDIUM:
        reason = "weak"
    else:
        reason = "no_match"

    return score, reason


def classify_confidence(score: float) -> str:
    if score >= CONFIDENCE_HIGH:
        return "high"
    if score >= CONFIDENCE_MEDIUM:
        return "medium"
    return "low"


def best_candidate(
    artist: str,
    title: str,
    duration_s: int | float | None,
    candidates: list[dict],
    top_n: int = 5,
) -> tuple[dict | None, float, str, list[dict]]:
    """
    Pick the best YouTube candidate and return scored alternatives.

    Returns (best_candidate, confidence_score, confidence_reason, ranked_candidates).
    ranked_candidates includes score/confidence on each item, capped at top_n.
    """
    if not candidates:
        return None, 0.0, "no_match", []

    scored: list[tuple[float, str, dict]] = []
    for c in candidates:
        s, reason = score_candidate(artist, title, duration_s, c)
        scored.append((s, reason, c))
    scored.sort(key=lambda x: x[0], reverse=True)

    best_score, best_reason, best = scored[0]

    ranked = []
    for s, r, c in scored[:top_n]:
        ranked.append({
            **c,
            "confidence": round(s, 3),
            "confidence_reason": r,
            "confidence_level": classify_confidence(s),
        })

    return best, round(best_score, 3), best_reason, ranked
