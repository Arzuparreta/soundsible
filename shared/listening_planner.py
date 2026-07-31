"""Deterministic queue planning shared by every generated music experience.

Candidate discovery stays provider-specific. This module owns the product-level
ordering contract: one ranked, diversified sequence for Autoplay, Radio, or
Auto Mode.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import hashlib
import math
import random
import re
from typing import Any

LISTENING_INTENTS = {"autoplay", "radio", "auto_mode"}
AUTO_PROFILES = {"familiar", "balanced", "explore"}
PLANNER_POOLS = ("local", "related", "discovery")

_AUTO_SEQUENCES = {
    "familiar": ("local", "local", "local", "local", "related", "related", "related", "discovery"),
    "balanced": ("local", "local", "related", "related", "related", "discovery", "discovery", "discovery"),
    "explore": ("local", "related", "related", "related", "discovery", "discovery", "discovery", "discovery"),
}
_INTENT_SEQUENCES = {
    "autoplay": ("related", "related", "related", "related", "related", "related", "related", "discovery"),
    "radio": ("related", "related", "related", "related", "related", "related", "discovery", "local"),
}
_AUTO_TEMPERATURE = {
    "familiar": 0.12,
    "balanced": 0.32,
    "explore": 0.55,
}
_ARTIST_SUFFIX = re.compile(
    r"(?:\s*[-–—]\s*)?(?:topic|official(?:\s+music)?|vevo)$",
    re.IGNORECASE,
)


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _candidate_identity(row: Mapping[str, Any]) -> str:
    external = row.get("external_ids") if isinstance(row.get("external_ids"), Mapping) else {}
    return (
        _clean(row.get("recommendation_identity"))
        or _clean(external.get("youtube_id"))
        or _clean(row.get("youtube_id"))
        or _clean(row.get("track_id"))
        or _clean(row.get("id"))
    )


def _candidate_keys(row: Mapping[str, Any]) -> set[str]:
    external = row.get("external_ids") if isinstance(row.get("external_ids"), Mapping) else {}
    return {
        value
        for value in (
            _candidate_identity(row),
            _clean(row.get("id")),
            _clean(row.get("track_id")),
            _clean(row.get("youtube_id")),
            _clean(external.get("youtube_id")),
        )
        if value
    }


def _score(row: Mapping[str, Any]) -> float:
    try:
        return float(row.get("score") or 0)
    except (TypeError, ValueError):
        return 0.0


def _artist_key(value: Any) -> str:
    artist = _ARTIST_SUFFIX.sub("", _clean(value)).strip(" -–—")
    return re.sub(r"\s+", " ", artist).casefold()


def _artist_keys(value: Any) -> set[str]:
    raw = _clean(value)
    parts = re.split(
        r"\s+(?:and|x|with|feat\.?|featuring)\s+|[,&/+]",
        raw,
        flags=re.IGNORECASE,
    )
    keys = {_artist_key(part) for part in parts if _artist_key(part)}
    return keys or ({_artist_key(raw)} if _artist_key(raw) else set())


def _ranked(
    rows: Iterable[Mapping[str, Any]],
    *,
    entropy: str | None = None,
    temperature: float = 0.0,
    pool: str = "",
) -> list[dict[str, Any]]:
    prepared = [dict(row) for row in rows if isinstance(row, Mapping) and _candidate_identity(row)]
    if entropy:
        rng = random.Random(
            int.from_bytes(
                hashlib.sha256(f"{entropy}:{pool}".encode("utf-8", "ignore")).digest()[:8],
                "big",
            )
        )
        scored: list[tuple[float, int, dict[str, Any]]] = []
        for index, row in enumerate(prepared):
            # Gumbel-top-k produces a stable weighted sample. The score remains
            # the dominant term; profile temperature only changes how readily
            # similarly good candidates exchange places between sessions.
            uniform = min(1 - 1e-9, max(1e-9, rng.random()))
            gumbel = -math.log(-math.log(uniform))
            weighted = math.log(max(0.0001, _score(row))) + temperature * gumbel
            scored.append((weighted, -index, row))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [row for _, _, row in scored]
    return [
        row
        for _, row in sorted(
            enumerate(prepared),
            key=lambda pair: (-_score(pair[1]), pair[0]),
        )
    ]


def plan_generated_queue(
    pools: Mapping[str, Iterable[Mapping[str, Any]]],
    *,
    intent: str,
    profile: str = "balanced",
    limit: int = 8,
    exclude: Iterable[str] = (),
    entropy: str | None = None,
    context_artists: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """Return the final generated order for one listening intent.

    The function is deliberately pure so route code can gather candidates from
    any provider while queue policy remains testable and identical everywhere.
    """
    if intent not in LISTENING_INTENTS:
        raise ValueError(f"unsupported intent: {intent}")
    if profile not in AUTO_PROFILES:
        raise ValueError(f"unsupported profile: {profile}")
    limit = max(1, min(24, int(limit)))
    sequence = (
        auto_source_sequence(profile, entropy=entropy)
        if intent == "auto_mode"
        else _INTENT_SEQUENCES[intent]
    )
    seen = {_clean(value) for value in exclude if _clean(value)}
    raw_pools = {
        pool: [
            dict(row)
            for row in (pools.get(pool) or ())
            if isinstance(row, Mapping) and not (_candidate_keys(row) & seen)
        ]
        for pool in PLANNER_POOLS
    }
    if intent == "auto_mode" and entropy:
        desired_local = sequence.count("local")
        eligible_local = raw_pools["local"]
        # A shallow compatible library pool must not make its sole song
        # mandatory in every fresh session. Exact route ratios only make sense
        # when there is enough depth to vary which local songs fill them.
        if 0 < len(eligible_local) <= desired_local:
            admission = math.sqrt(desired_local / len(sequence))
            rng = random.Random(
                int.from_bytes(
                    hashlib.sha256(f"{entropy}:local-admission".encode()).digest()[:8],
                    "big",
                )
            )
            raw_pools["local"] = [row for row in eligible_local if rng.random() < admission]
    temperature = _AUTO_TEMPERATURE[profile] if intent == "auto_mode" and entropy else 0.0
    queues = {
        pool: _ranked(
            raw_pools[pool],
            entropy=entropy if intent == "auto_mode" else None,
            temperature=temperature,
            pool=pool,
        )
        for pool in PLANNER_POOLS
    }
    artist_counts: dict[str, int] = {}
    selected: list[dict[str, Any]] = []
    cursor = 0
    misses = 0
    artist_cap = (
        3
        if intent == "radio"
        else 1
        if intent == "auto_mode" and profile in {"balanced", "explore"}
        else 2
    )
    if intent == "auto_mode":
        for value in context_artists:
            for artist in _artist_keys(value):
                artist_counts[artist] = artist_cap

    while len(selected) < limit and misses < len(sequence) * 3:
        preferred = sequence[cursor % len(sequence)]
        cursor += 1
        order = (preferred, *(pool for pool in PLANNER_POOLS if pool != preferred))
        picked: tuple[str, dict[str, Any]] | None = None
        for pool in order:
            while queues[pool]:
                candidate = queues[pool].pop(0)
                keys = _candidate_keys(candidate)
                artists = _artist_keys(candidate.get("artist") or candidate.get("channel"))
                if keys & seen or any(artist_counts.get(artist, 0) >= artist_cap for artist in artists):
                    continue
                picked = pool, candidate
                seen.update(keys)
                for artist in artists:
                    artist_counts[artist] = artist_counts.get(artist, 0) + 1
                break
            if picked:
                break
        if not picked:
            misses += 1
            continue
        misses = 0
        pool, candidate = picked
        candidate["source_pool"] = pool
        candidate["recommendation_source"] = intent
        selected.append(candidate)

    return selected


def auto_source_sequence(profile: str, *, entropy: str | None = None) -> tuple[str, ...]:
    """Public route-ordering view of Auto's source contract."""
    if profile not in AUTO_PROFILES:
        raise ValueError(f"unsupported profile: {profile}")
    sequence = _AUTO_SEQUENCES[profile]
    if not entropy:
        return sequence
    offset = int.from_bytes(
        hashlib.sha256(f"{entropy}:source-order".encode()).digest()[:4],
        "big",
    ) % len(sequence)
    return (*sequence[offset:], *sequence[:offset])
