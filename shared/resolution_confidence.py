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

#: Words that make a recording a different thing from the track that was asked
#: for. `_norm` strips bracketed text before comparing, so "(Live at Wembley)"
#: and "(Karaoke Version)" vanish and the take ties the studio recording on
#: title alone. With a running time close enough — a live cut usually is — that
#: was worth 0.90 and a silent save of the wrong version.
#:
#: The comparison runs both ways. A marker the request never asked for means the
#: candidate is the wrong recording; a marker the request *did* ask for and the
#: candidate lacks means the same thing from the other side, so someone looking
#: for a remix is not handed the original.
_VERSION_MARKERS = (
    "live",
    "cover",
    "karaoke",
    "instrumental",
    "remix",
    "acoustic",
    "unplugged",
    "sped up",
    "slowed",
    "nightcore",
    "8d",
    "reverb",
    "tribute",
    "medley",
    "mashup",
    "parody",
    "backing track",
)
#: Enough to put an unrequested version below the recording it was competing
#: with, and below the bar for saving without asking.
_VERSION_PENALTY = 0.20

#: Where a recording was uploaded from, which `_norm` also erases: "official"
#: and "lyrics" are filler words, stripped before titles are compared. Two
#: candidates carrying the same recording therefore score identically whether
#: one is the artist's own upload and the other is a third party's repackaging
#: of it — and small accidents decide, like the six-second running time of an
#: official video losing to a lyrics reupload's five.
#:
#: This is a preference between sources, not evidence about which track it is,
#: so both adjustments are small enough that title, artist and duration still
#: decide what the recording actually is.
_OFFICIAL_TITLE_MARKERS = ("official",)
_OFFICIAL_CHANNEL_MARKERS = ("vevo", "- topic", "official")
_REPACKAGE_MARKERS = (
    "lyrics",
    "lyric video",
    "letra",
    "letras",
    "sub espanol",
    "sub español",
    "subtitulado",
    "traducida",
    "traduccion",
    "traducción",
)
_OFFICIAL_BONUS = 0.15
_REPACKAGE_PENALTY = 0.15

_MARKER_RES = {
    marker: re.compile(rf"(?<!\w){re.escape(marker)}(?!\w)", re.IGNORECASE)
    for marker in _VERSION_MARKERS
}
_REPACKAGE_RES = tuple(
    re.compile(rf"(?<!\w){re.escape(marker)}(?!\w)", re.IGNORECASE)
    for marker in _REPACKAGE_MARKERS
)


def is_official_source(candidate: dict) -> bool:
    """True when a candidate looks like the artist's own upload.

    Used to break ties between candidates we are equally confident about. Beyond
    sounding right, these are the uploads that are still there next year: a
    third-party reupload is what disappears and leaves a saved track dead.
    """
    title = candidate.get("title") or ""
    channel = (candidate.get("channel") or candidate.get("uploader") or "").casefold()
    if any(marker in channel for marker in _OFFICIAL_CHANNEL_MARKERS):
        return True
    return any(
        re.search(rf"(?<!\w){re.escape(marker)}(?!\w)", title, re.IGNORECASE)
        for marker in _OFFICIAL_TITLE_MARKERS
    )


def _source_adjustment(candidate_title: str, candidate_channel: str) -> float:
    """Prefer the artist's own upload over somebody else's repost of it.

    An "official lyric video" earns both marks and nets out at zero, which is
    right: it is the canonical upload and it is a lyrics video.
    """
    title = candidate_title or ""
    channel = candidate_channel or ""
    adjustment = 0.0
    lowered_channel = channel.casefold()
    official = any(
        re.search(rf"(?<!\w){re.escape(marker)}(?!\w)", title, re.IGNORECASE)
        for marker in _OFFICIAL_TITLE_MARKERS
    ) or any(marker in lowered_channel for marker in _OFFICIAL_CHANNEL_MARKERS)
    if official:
        adjustment += _OFFICIAL_BONUS
    if any(pattern.search(title) for pattern in _REPACKAGE_RES):
        adjustment -= _REPACKAGE_PENALTY
    return adjustment


def _version_mismatch(sought_title: str, candidate_title: str) -> bool:
    """True when request and candidate disagree about which version this is."""
    if not candidate_title:
        return False
    sought = sought_title or ""
    return any(
        bool(pattern.search(candidate_title)) != bool(pattern.search(sought))
        for pattern in _MARKER_RES.values()
    )


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

    # — Unrequested version (flat penalty) —
    # Applied after the three components because it is not a similarity signal:
    # a live take can match title, artist and running time perfectly and still
    # be the wrong recording to save.
    wrong_version = _version_mismatch(title, candidate.get("title") or "")
    if wrong_version:
        score -= _VERSION_PENALTY

    # — Source preference —
    score += _source_adjustment(
        candidate.get("title") or "",
        candidate.get("channel") or candidate.get("uploader") or "",
    )

    score = max(0.0, min(1.0, score))

    # Build reason code
    has_title = title_score >= 0.25
    has_artist = artist_score >= 0.15
    has_duration = duration_score >= 0.08
    if wrong_version:
        reason = "other_version"
    elif has_title and has_artist and has_duration:
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

    # Near-equal score first, then the artist's own upload, then the exact score.
    #
    # Ordering on the score alone let accidents pick the winner: an official
    # video six seconds off the album running time lost to a lyrics reupload
    # five seconds off, because the duration bands happen to break at five. Once
    # two candidates are equally credible as *this track*, which upload to keep
    # is a separate question with a settled answer — and one that a score nudged
    # until it wins by 0.01 would keep re-answering at random.
    #
    # "Equally credible" has to mean close, not merely the same band: `medium`
    # spans 0.40 to 0.74, wide enough that the wrong song from the right channel
    # would outrank the right song from somebody else's.
    scored.sort(key=lambda x: (round(x[0], 1), is_official_source(x[2]), x[0]), reverse=True)

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
