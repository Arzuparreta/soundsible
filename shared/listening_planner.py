"""Deterministic queue planning shared by every generated music experience.

Candidate discovery stays provider-specific. This module owns the product-level
ordering contract: one ranked, diversified sequence for Autoplay, Radio, or
Auto Mode.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
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


def _ranked(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    prepared = [dict(row) for row in rows if isinstance(row, Mapping) and _candidate_identity(row)]
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
    sequence = _AUTO_SEQUENCES[profile] if intent == "auto_mode" else _INTENT_SEQUENCES[intent]
    queues = {pool: _ranked(pools.get(pool) or ()) for pool in PLANNER_POOLS}
    seen = {_clean(value) for value in exclude if _clean(value)}
    artist_counts: dict[str, int] = {}
    selected: list[dict[str, Any]] = []
    cursor = 0
    misses = 0
    artist_cap = 3 if intent == "radio" else 2

    while len(selected) < limit and misses < len(sequence) * 3:
        preferred = sequence[cursor % len(sequence)]
        cursor += 1
        order = (preferred, *(pool for pool in PLANNER_POOLS if pool != preferred))
        picked: tuple[str, dict[str, Any]] | None = None
        for pool in order:
            while queues[pool]:
                candidate = queues[pool].pop(0)
                keys = _candidate_keys(candidate)
                artist = _clean(candidate.get("artist") or candidate.get("channel")).casefold()
                if keys & seen or (artist and artist_counts.get(artist, 0) >= artist_cap):
                    continue
                picked = pool, candidate
                seen.update(keys)
                if artist:
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
