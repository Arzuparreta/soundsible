"""Metadata scoring engine with multi-provider weighted consensus."""

from __future__ import annotations

import hashlib
import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple


AUTO_THRESHOLD = 0.90
REVIEW_THRESHOLD = 0.72
PROVIDER_WEIGHTS = {
    "musicbrainz": 1.0,
    "itunes": 0.82,
}


def _clean_text(value: str) -> str:
    text = (value or "").strip().lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.split())


def _similarity(a: str, b: str) -> float:
    aa = _clean_text(a)
    bb = _clean_text(b)
    if not aa or not bb:
        return 0.0
    token_a = set(aa.split())
    token_b = set(bb.split())
    overlap = len(token_a & token_b) / max(1, len(token_a))
    seq = SequenceMatcher(None, aa, bb).ratio()
    return (overlap * 0.6) + (seq * 0.4)


def metadata_query_fingerprint(title: str, artist: str, duration_sec: int) -> str:
    payload = f"{_clean_text(title)}|{_clean_text(artist)}|{int(duration_sec or 0)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]


def _duration_score(a: int, b: int) -> float:
    if not a or not b:
        return 0.5
    diff = abs(int(a) - int(b))
    if diff <= 2:
        return 1.0
    if diff <= 6:
        return 0.85
    if diff <= 12:
        return 0.7
    if diff <= 20:
        return 0.5
    return 0.2


def _candidate_score(base: Dict[str, Any], candidate: Dict[str, Any]) -> float:
    title_score = _similarity(base.get("title", ""), candidate.get("title", ""))
    artist_score = _similarity(base.get("artist", ""), candidate.get("artist", ""))
    duration_score = _duration_score(base.get("duration_sec", 0), candidate.get("duration_sec", 0))
    album_score = _similarity(base.get("album", ""), candidate.get("album", "")) if base.get("album") else 0.5
    score = (title_score * 0.4) + (artist_score * 0.35) + (duration_score * 0.2) + (album_score * 0.05)
    isrc_base = (base.get("isrc") or "").strip().upper()
    isrc_candidate = (candidate.get("isrc") or "").strip().upper()
    if isrc_base and isrc_candidate and isrc_base == isrc_candidate:
        score += 0.2
    return min(1.0, score)


def _pick_best(base: Dict[str, Any], candidates: List[Dict[str, Any]]) -> Tuple[Optional[Dict[str, Any]], float]:
    best = None
    best_score = 0.0
    for candidate in candidates or []:
        score = _candidate_score(base, candidate)
        if score > best_score:
            best = candidate
            best_score = score
    return best, best_score


def _provider_weight(provider_name: str) -> float:
    return PROVIDER_WEIGHTS.get((provider_name or "").strip().lower(), 0.75)


def _provider_authority(provider_name: str) -> str:
    p = (provider_name or "").strip().lower()
    if p == "musicbrainz":
        return "hybrid_consensus"
    if p == "itunes":
        return "catalog_consensus"
    return "catalog_consensus"


def _agreement_bonus(best_by_provider: Dict[str, Dict[str, Any]]) -> float:
    providers = list(best_by_provider.keys())
    if len(providers) < 2:
        return 0.0
    best_bonus = 0.0
    for i, p1 in enumerate(providers):
        for p2 in providers[i + 1 :]:
            c1 = best_by_provider[p1]
            c2 = best_by_provider[p2]
            t = _similarity(c1.get("title", ""), c2.get("title", ""))
            a = _similarity(c1.get("artist", ""), c2.get("artist", ""))
            d = _duration_score(c1.get("duration_sec", 0), c2.get("duration_sec", 0))
            b = (t * 0.45) + (a * 0.4) + (d * 0.15)
            if b > best_bonus:
                best_bonus = b
    # Agreement acts as supporting evidence, never dominant.
    return min(0.18, max(0.0, (best_bonus - 0.6) * 0.45))


def decide_consensus(
    base: Dict[str, Any],
    spotify_candidates: Optional[List[Dict[str, Any]]] = None,
    musicbrainz_candidates: Optional[List[Dict[str, Any]]] = None,
    itunes_candidates: Optional[List[Dict[str, Any]]] = None,
    spotify_web_candidates: Optional[List[Dict[str, Any]]] = None,
    provider_candidates: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> Dict[str, Any]:
    # Backward compatibility with previous call shape + new provider map shape.
    candidate_map: Dict[str, List[Dict[str, Any]]] = {}
    if provider_candidates:
        candidate_map.update(provider_candidates)
    if musicbrainz_candidates is not None:
        candidate_map["musicbrainz"] = musicbrainz_candidates
    if itunes_candidates is not None:
        candidate_map["itunes"] = itunes_candidates
    if spotify_web_candidates is not None:
        candidate_map["spotify_web"] = spotify_web_candidates
    if spotify_candidates is not None:
        # historical name `spotify_candidates` can represent any spotify source
        if "spotify_web" not in candidate_map:
            candidate_map["spotify_web"] = spotify_candidates
        else:
            candidate_map["spotify_api"] = spotify_candidates

    best_by_provider: Dict[str, Dict[str, Any]] = {}
    scored_by_provider: Dict[str, float] = {}
    for provider_name, candidates in candidate_map.items():
        best, score = _pick_best(base, candidates or [])
        if not best:
            continue
        best_by_provider[provider_name] = best
        scored_by_provider[provider_name] = score

    if not best_by_provider:
        return {
            "metadata_state": "fallback_youtube",
            "metadata_confidence": 0.0,
            "metadata_source_authority": "youtube_fallback",
            "canonical": None,
            "review_candidates": {},
        }

    weighted_scores: Dict[str, float] = {}
    for provider_name, raw_score in scored_by_provider.items():
        weighted_scores[provider_name] = raw_score * _provider_weight(provider_name)

    best_provider = max(weighted_scores.keys(), key=lambda p: weighted_scores[p])
    best_candidate = best_by_provider[best_provider]
    top_weighted = weighted_scores[best_provider]
    bonus = _agreement_bonus(best_by_provider)

    # Strong deterministic boost for exact ISRC match.
    if base.get("isrc") and best_candidate.get("isrc"):
        if str(base["isrc"]).strip().upper() == str(best_candidate["isrc"]).strip().upper():
            top_weighted = min(1.0, top_weighted + 0.2)

    final_score = min(1.0, top_weighted + bonus)
    provider_count = len(best_by_provider)
    can_auto = final_score >= AUTO_THRESHOLD and (provider_count >= 2 or top_weighted >= 0.97)

    if can_auto:
        return {
            "metadata_state": "auto_resolved",
            "metadata_confidence": round(final_score, 3),
            "metadata_source_authority": _provider_authority(best_provider),
            "canonical": best_candidate,
            "review_candidates": best_by_provider,
        }

    if final_score >= REVIEW_THRESHOLD:
        return {
            "metadata_state": "pending_review",
            "metadata_confidence": round(final_score, 3),
            "metadata_source_authority": "pending_review",
            "canonical": None,
            "review_candidates": best_by_provider,
        }

    return {
        "metadata_state": "fallback_youtube",
        "metadata_confidence": round(final_score, 3),
        "metadata_source_authority": "youtube_fallback",
        "canonical": None,
        "review_candidates": best_by_provider,
    }
