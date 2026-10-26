"""Pure ordering and request policies within caller-selected candidates."""

from __future__ import annotations

import math
import statistics
from collections.abc import Iterable, Mapping
from typing import Any

from .contracts import AnalysisInput, Candidate
from .transitions import plan_transition
from .timing import tempo_coordinate, beatmatch_fits

def order_continuous_route(
    current_analysis: AnalysisInput,
    candidates: Iterable[Candidate],
) -> list[dict[str, Any]]:
    """Order an already chosen set, without selecting for cache availability.

    Each measured slot takes the nearest remaining measured song. Distance has
    five equally scaled components: transition-score deficit and changes in
    notes/s, LUFS, flatness and tempo. Each component uses its population
    standard deviation in this set, rather than a hand-tuned unit or weight.
    Constant or incomplete dimensions contribute nothing. Tempo is folded onto
    the seed's octave so half/double-time measurements describe the same pulse.

    Unmeasured songs retain their shuffled slots. After an unmeasured song we
    keep shuffle order too: there is no evidence for ranking its next seam.
    Callers must choose the set *before* inspecting analysis; otherwise even a
    neutral missing-data score would favour the already downloaded catalogue.
    """
    selected = list(candidates)
    measured = [analysis for _, analysis in selected if analysis.get("analysed")]
    features = ("note_rate", "loudness_lufs", "spectral_flatness", "bpm")

    def value(analysis: Mapping[str, Any], name: str) -> float | None:
        raw = analysis.get(name)
        if not isinstance(raw, (int, float)) or not math.isfinite(raw):
            return None
        if name == "bpm" and raw <= 0:
            return None
        return float(raw)

    tempo_reference = next(
        (bpm for analysis in [current_analysis, *measured] if (bpm := value(analysis, "bpm")) is not None),
        None,
    )

    def coordinate(analysis: Mapping[str, Any], name: str) -> float | None:
        result = value(analysis, name)
        if name == "bpm" and result is not None and tempo_reference is not None:
            result = tempo_coordinate(result, tempo_reference)
        return result

    scales = {}
    for name in features:
        values = [coordinate(analysis, name) for analysis in measured]
        if len(values) >= 2 and all(number is not None for number in values):
            scale = statistics.pstdev(values)
            if scale > 0:
                scales[name] = scale

    remaining = list(range(len(selected)))
    route: list[dict[str, Any]] = []
    previous = current_analysis
    for slot_index, (_, slot_analysis) in enumerate(selected):
        # Cold rows are anchors, never competitors against measured rows.
        eligible = [index for index in remaining if selected[index][1].get("analysed")]
        if not slot_analysis.get("analysed"):
            eligible = [slot_index]
        transitions = {
            index: plan_transition(previous, selected[index][1])
            for index in eligible
        }
        chosen = eligible[0]
        if slot_analysis.get("analysed") and previous.get("analysed") and len(eligible) > 1:
            qualities = [transitions[index]["score"] for index in eligible]
            quality_scale = statistics.pstdev(qualities)
            best_quality = max(qualities)
            coordinates = {name: coordinate(previous, name) for name in scales}

            def distance(index: int) -> float:
                analysis = selected[index][1]
                components = [
                    (coordinate(analysis, name) - origin) / scales[name]
                    for name, origin in coordinates.items() if origin is not None
                ]
                if quality_scale > 0:
                    components.append((best_quality - transitions[index]["score"]) / quality_scale)
                return sum(component * component for component in components)

            # min is stable: ties retain the session/segment shuffle.
            chosen = min(eligible, key=distance)
        item, analysis = selected[chosen]
        route.append({**item, "analysis": dict(analysis), "transition": transitions[chosen]})
        remaining.remove(chosen)
        previous = analysis
    return route


def order_route(
    current_analysis: AnalysisInput,
    candidates: Iterable[Candidate],
    *,
    limit: int = 3,
    source_sequence: Iterable[str] | None = None,
    source_offset: int = 0,
) -> list[dict[str, Any]]:
    """Greedy lookahead over transition quality and recommendation relevance.

    Missing analysis is an absence of evidence, not evidence of a bad song.
    Treating its conservative fallback as measured compatibility made every
    cold external candidate lose to tracks already downloaded by an earlier
    session, creating a self-reinforcing cache loop.
    """
    remaining = list(candidates)
    route: list[dict[str, Any]] = []
    previous = current_analysis
    sequence = tuple(source_sequence or ())
    while remaining and len(route) < limit:
        preferred = sequence[(source_offset + len(route)) % len(sequence)] if sequence else None
        eligible = (
            [row for row in remaining if row[0].get("source_pool") == preferred]
            if preferred
            else remaining
        )
        if not eligible:
            eligible = remaining
        scored = []
        for index, (item, analysis) in enumerate(eligible):
            transition = plan_transition(previous, analysis)
            relevance = max(0.0, min(1.0, float(item.get("score") or 0.5)))
            transition_quality = (
                float(transition["score"])
                if previous.get("analysed", True) and analysis.get("analysed", True)
                else 0.62
            )
            semantic = max(0.0, min(1.0, float(item.get("semantic_score") or 0.5)))
            score = transition_quality * 0.42 + semantic * 0.38 + relevance * 0.20
            scored.append((score, -index, item, analysis, transition))
        _, _, item, analysis, transition = max(scored, key=lambda row: (row[0], row[1]))
        route.append({**item, "analysis": dict(analysis), "transition": transition})
        remaining = [(candidate, data) for candidate, data in remaining if candidate is not item]
        previous = analysis
    return route


def route_to_request(
    current_analysis: AnalysisInput,
    bridges: Iterable[Candidate],
    requested: Candidate,
    *,
    max_starts: int = 5,
) -> list[dict[str, Any]]:
    """Reach the request in positions 2–6, preferring position 2.

    The currently playing song is position one. A bridge is admitted only when
    it materially improves safety; otherwise the explicit request is next.
    """
    bridge_rows = list(bridges)[:12]
    requested_item, requested_analysis = requested
    best_score = float(plan_transition(current_analysis, requested_analysis)["score"])
    best: tuple[tuple[dict[str, Any], Mapping[str, Any]], ...] = (requested,)
    max_bridges = max(0, min(4, max_starts - 1))
    # Beam search bounds the four-bridge case while retaining musically strong
    # paths. Delaying costs progressively more, hence "next" remains preferred.
    beam: list[tuple[float, tuple[tuple[dict[str, Any], Mapping[str, Any]], ...], Mapping[str, Any], frozenset[int]]] = [
        (0.0, (), current_analysis, frozenset())
    ]
    for count in range(1, max_bridges + 1):
        expanded = []
        for accumulated, prefix, previous, used in beam:
            for index, row in enumerate(bridge_rows):
                if index in used:
                    continue
                plan = plan_transition(previous, row[1])
                if ('metric_regions' in previous or 'metric_regions' in row[1]) and not beatmatch_fits(plan, previous, row[1]):
                    continue
                quality = float(plan["score"])
                expanded.append((accumulated + quality, (*prefix, row), row[1], used | {index}))
        expanded.sort(key=lambda state: state[0], reverse=True)
        beam = expanded[:48]
        for accumulated, prefix, previous, _ in beam:
            plan = plan_transition(previous, requested_analysis)
            if ('metric_regions' in previous or 'metric_regions' in requested_analysis) and not beatmatch_fits(plan, previous, requested_analysis):
                continue
            final_quality = float(plan["score"])
            sequence_quality = (accumulated + final_quality) / (count + 1)
            delay_cost = 0.055 * count + 0.012 * count * count
            score = sequence_quality - delay_cost
            if score > best_score + 0.015:
                best_score = score
                best = (*prefix, requested)
    route: list[dict[str, Any]] = []
    previous = current_analysis
    for item, analysis in best:
        transition = plan_transition(previous, analysis)
        route.append({**item, "analysis": dict(analysis), "transition": transition})
        previous = analysis
    return route


REPAIR_ROUTE_CAP = 16
_REPAIR_MAX_BRIDGES = 2
_REPAIR_STABILITY_BONUS = 0.06


def route_identity(item: dict) -> str:
    return str(item.get("recommendation_identity") or item.get("id") or "")


def repair_route(
    current_analysis: AnalysisInput,
    parsed: list[tuple[bool, dict, AnalysisInput]],
    extra_pool: Iterable[Candidate],
    *,
    target: int,
) -> list[dict]:
    """Preserve pins/depths; rechoose filler with the existing relevance policy."""
    anchors = [(item, analysis) for pinned, item, analysis in parsed if pinned]
    spares = [(item, analysis) for pinned, item, analysis in parsed if not pinned]
    # How deep each pin sat, measured in songs before it. Holding only their
    # relative order would let a song the listener dropped at slot nine surface
    # as the very next one — order intact, intent destroyed. Repair re-chooses
    # what fills a gap, never how long the gap is.
    depths: list[int] = []
    run = 0
    for pinned, _, _ in parsed:
        if pinned:
            depths.append(run)
            run = 0
        else:
            run += 1

    # An equal-quality seam should keep the row already on screen. `order_route`
    # weights relevance at 0.20, so this is a tiebreak rather than a thumb on
    # the scale — a genuinely bad seam still loses its slot.
    pool: list[tuple[dict, dict]] = [
        ({**item, "score": min(1.0, float(item.get("score") or 0.5) + _REPAIR_STABILITY_BONUS)}, analysis)
        for item, analysis in spares
    ]
    pool.extend(extra_pool)

    built: list[dict] = []
    previous = current_analysis
    def spend(rows: list[dict]) -> None:
        spent = {route_identity(row) for row in rows}
        pool[:] = [row for row in pool if route_identity(row[0]) not in spent]

    for position, (anchor_item, anchor_analysis) in enumerate(anchors):
        # Room the anchors still to come have already claimed is not spendable.
        remaining = len(anchors) - position
        fill = order_route(
            previous, pool,
            limit=max(0, min(depths[position], target - len(built) - remaining)),
        )
        for row in fill:
            row["route_kind"] = "generated"
        built.extend(fill)
        spend(fill)
        if fill:
            previous = fill[-1]["analysis"]
        # Bridges may push past the route's original length, and only bridges
        # may. Measuring their room against that length instead meant a route
        # the listener had filled entirely with their own songs — the exact case
        # this endpoint exists for — could never be given a way into them.
        headroom = REPAIR_ROUTE_CAP - len(built) - remaining
        segment = route_to_request(
            previous,
            pool,
            (anchor_item, anchor_analysis),
            max_starts=1 + max(0, min(_REPAIR_MAX_BRIDGES, headroom)),
        )
        for row in segment[:-1]:
            row["route_kind"] = "bridge"
            row["owner_queue_id"] = anchor_item.get("queue_id") or ""
        segment[-1]["route_kind"] = "user"
        built.extend(segment)
        spend(segment)
        previous = anchor_analysis

    # Repair re-seams a route, it does not grow one. When the pool runs dry the
    # tail comes back short and the browser's own refill tops it up at the next
    # natural moment; there should not be a second thing that lengthens a route.
    tail = order_route(previous, pool, limit=max(0, target - len(built)))
    for row in tail:
        row["route_kind"] = "generated"
    built.extend(tail)

    return built


def choose_placement(
    current_analysis: AnalysisInput,
    route: list[Candidate],
    requested: Candidate,
    bridge_pool: Iterable[Candidate],
    *,
    fixed_index: int | None = None,
) -> tuple[int, list[dict], dict | None] | None:
    """Choose a gap by adjacent score and delay; fixed placement forbids bridges."""
    bridge_pool = [] if fixed_index is not None else list(bridge_pool)
    gap_indexes = [fixed_index] if fixed_index is not None else list(range(len(route) + 1))
    best = None
    for gap in gap_indexes:
        if gap is None:
            continue
        previous = current_analysis if gap == 0 else route[gap - 1][1]
        segment = route_to_request(
            previous,
            bridge_pool,
            requested,
            max_starts=1 if fixed_index is not None else 3,
        )
        qualities = [float(row["transition"]["score"]) for row in segment]
        following = None
        if gap < len(route):
            following = plan_transition(requested[1], route[gap][1])
            qualities.append(float(following["score"]))
        score = sum(qualities) / max(1, len(qualities)) - gap * 0.009
        candidate = (score, -gap, gap, segment, following)
        if best is None or candidate[:2] > best[:2]:
            best = candidate

    if best is None:
        return None
    _, _, insert_at, segment, following = best
    return insert_at, segment, following


def choose_request_segment(
    current_analysis: AnalysisInput,
    candidates: Iterable[Candidate],
    targets: Iterable[Candidate],
    *,
    max_starts: int,
) -> tuple[list[dict], AnalysisInput] | None:
    """Legacy artist/song request policy: mean pair score, relevance and delay."""
    candidates = list(candidates)
    candidate_segments = []
    for target, target_analysis in targets:
        target_segment = route_to_request(current_analysis, candidates, (target, target_analysis),
                                          max_starts=max_starts)
        if not target_segment:
            continue
        transition_quality = sum(float(row["transition"]["score"]) for row in target_segment) / len(target_segment)
        position_cost = max(0, len(target_segment) - 1) * 0.025
        candidate_segments.append((
            transition_quality + float(target.get("score") or 0.5) * 0.08 - position_cost,
            target_segment,
            target_analysis,
        ))
    if not candidate_segments:
        return None
    _, segment, requested_analysis = max(candidate_segments, key=lambda row: row[0])
    return segment, requested_analysis
