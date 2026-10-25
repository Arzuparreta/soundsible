"""One pair planner: compatibility, executable cues, speed and effects; no I/O."""

from __future__ import annotations

import bisect
import math
from collections.abc import Mapping
from typing import Any

from .features import _KEY_NAMES
from .contracts import AnalysisInput, TransitionPlan
from .timing import (
    MAX_STRETCH as _MAX_STRETCH,
    BEATMATCH_TECHNIQUES, PHASE_TOLERANCE_SECONDS,
    comparable_ratio, local_period as _local_period, rate_fits as _rate_fits,
)

_TEMPO_SCORE_RANGE = 0.08


# Seconds kept between a planned blend start and `duration - overlap`.
_OUT_CUE_MARGIN = 1.5


def _harmonic_score(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
    """Closeness on the Camelot graph, normalised by its diameter (7).

    Edges are a fourth/fifth within one mode or the relative major/minor:
    https://mixedinkey.com/camelot-wheel/0/
    No hand-picked scores for individual intervals. C major and A minor are
    one edge apart, C major and C minor four, C major and G minor three.
    """
    positions = []
    for analysis in (left, right):
        key, mode = analysis.get("key"), analysis.get("mode")
        if key not in _KEY_NAMES or mode not in {"major", "minor"}:
            return 0.55  # Preserve the neutral fallback when tonality is unknown.
        tonic = _KEY_NAMES.index(key)
        relative_major = (tonic + 3) % 12 if mode == "minor" else tonic
        # Seven is its own inverse modulo twelve: semitones -> fifths.
        positions.append((7 * relative_major) % 12)
    distance = abs(positions[0] - positions[1])
    steps = min(distance, 12 - distance) + (left["mode"] != right["mode"])
    return 1.0 - steps / 7


def _nearest_grid_point(
    analysis: Mapping[str, Any],
    target: float,
    *,
    prefer_downbeat: bool = True,
) -> float:
    grid = analysis.get("downbeats") if prefer_downbeat else analysis.get("beat_grid")
    if not isinstance(grid, list) or not grid:
        grid = analysis.get("beat_grid")
    values = [float(value) for value in grid or [] if isinstance(value, (int, float))]
    return min(values, key=lambda value: abs(value - target)) if values else target


def _grid_point_at_or_before(analysis: Mapping[str, Any], limit: float) -> float:
    grid = analysis.get("downbeats") or analysis.get("beat_grid") or []
    values = [
        float(value)
        for value in grid
        if isinstance(value, (int, float)) and float(value) <= limit
    ]
    return max(values) if values else limit


def _section_starts(analysis: Mapping[str, Any], labels: set[str]) -> list[float]:
    """Starts of contiguous measured roles, not every eight-bar block in one."""
    if not analysis.get("analysed"):
        return []
    result = []
    previous = None
    for section in analysis.get("sections") or []:
        label = section["label"]
        if label in labels and (previous is None or previous["label"] != label
                                or abs(previous["end"] - section["start"]) > 0.001):
            result.append(float(section["start"]))
        previous = section
    return result


def _structural_exit(analysis: Mapping[str, Any], proposed: float, overlap: float,
                     earliest: float, duration: float) -> tuple[float, float]:
    # Leave at an outro's start, or finish the blend before a breakdown.
    # Use the nearest such opportunity to the existing end-of-song cue; there
    # are no role weights or human ratings. Never move a measured section just
    # to squeeze it inside the players' permitted window.
    targets = [(start, min(overlap, duration - start - _OUT_CUE_MARGIN))
               for start in _section_starts(analysis, {"outro"})]
    targets += [(start - overlap, overlap) for start in _section_starts(analysis, {"breakdown"})]
    candidates = []
    for target, span in targets:
        cue = _nearest_grid_point(analysis, target)
        if span >= 4 and earliest <= cue <= duration - span - _OUT_CUE_MARGIN + 0.001 and abs(cue - target) <= PHASE_TOLERANCE_SECONDS:
            candidates.append((cue, span))
    return min(candidates, key=lambda pair: abs(pair[0] - proposed)) if candidates else (proposed, overlap)


def _drop_entry(outgoing: Mapping[str, Any], incoming: Mapping[str, Any],
                out_cue: float, intro: float, overlap: float, max_stretch: float) -> tuple[float, float] | None:
    """Finish on a measured outgoing phrase as the incoming drop arrives.

    Only align actual downbeats, within the existing overlap/intro limits. The
    playback rate is the one the players will execute, not the global BPM
    ratio. If those constraints do not meet within 5 ms, retain the normal intro.
    """
    if not outgoing.get("downbeats") or not incoming.get("downbeats"):
        return None
    phrases = sorted({float(value) for value in outgoing.get("phrase_boundaries") or []
                      if 4 <= float(value) - out_cue <= overlap + 0.001}, reverse=True)
    for drop in _section_starts(incoming, {"drop"}):
        if abs(_nearest_grid_point(incoming, drop) - drop) > PHASE_TOLERANCE_SECONDS:
            continue
        for end in phrases:
            if abs(_nearest_grid_point(outgoing, end) - end) > PHASE_TOLERANCE_SECONDS:
                continue
            span = end - out_cue
            out_period = _local_period(outgoing, out_cue, span)

            def ratio_at(cue: float) -> float:
                ratio = _local_period(incoming, cue, span) / out_period
                ratio = comparable_ratio(ratio)
                return ratio

            cue = intro
            # Refit at the proposed entry rather than measuring a different
            # part of a long recording. Constant grids converge immediately.
            for _ in range(2):
                cue = _nearest_grid_point(incoming, drop - span * ratio_at(cue))
            ratio = ratio_at(cue)
            if (abs(1 - ratio) <= max_stretch and intro <= cue <= float(incoming.get("duration") or 0) * 0.25
                    and abs((drop - cue) / round(ratio, 6) - span) <= PHASE_TOLERANCE_SECONDS):
                return cue, span
    return None


def plan_transition(outgoing: AnalysisInput, incoming: AnalysisInput) -> TransitionPlan:
    """Choose effects from the pair's measured pulse and available sections.

    Scores retain their route-ordering meaning. Technique choice also checks
    the actual local rate: a good harmonic score cannot make an impossible
    beatmatch safe. No client style or random effect selection is involved.
    """
    out_bpm = float(outgoing.get("bpm") or 0)
    in_bpm = float(incoming.get("bpm") or 0)
    ratio = out_bpm / in_bpm if out_bpm > 0 and in_bpm > 0 else 1.0
    ratio = comparable_ratio(ratio)
    tempo_score = max(0.0, 1 - abs(1 - ratio) / _TEMPO_SCORE_RANGE)
    harmonic = _harmonic_score(outgoing, incoming)
    confidence = min(float(outgoing.get("confidence") or 0), float(incoming.get("confidence") or 0))
    score = 0.46 * tempo_score + 0.32 * harmonic + 0.22 * confidence
    # A followed (drifting) grid has tempo_confidence <= 0.6 (see _rhythm).
    steady = all(float(analysis.get("bpm") or 0) > 0
                 and float(analysis.get("tempo_confidence") or 0) > 0.6
                 for analysis in (outgoing, incoming))
    if steady and score >= 0.55:
        technique = "bass_swap" if score >= 0.72 else "filter_blend"
        plan = _transition_plan(outgoing, incoming, technique, 16, score, confidence)
        if _rate_fits(plan):
            # A longer blend requires actual intro/outro runway in BOTH tracks,
            # and neighbouring Camelot keys. Missing sections never invent it.
            if technique == "bass_swap" and harmonic >= 6 / 7:
                exit_run = _section_run(outgoing, "outro")
                entry_run = _section_run(incoming, "intro")
                if exit_run is None or entry_run is None:
                    return plan
                extended = _transition_plan({**outgoing, "outro_cue": exit_run[0]}, incoming,
                                            "long_blend", 32, score, confidence)
                if (extended["overlap_seconds"] > plan["overlap_seconds"] and _rate_fits(extended)
                        and exit_run[0] - 0.001 <= extended["out_cue"]
                        and extended["out_cue"] + extended["overlap_seconds"] <= exit_run[1] + 0.001
                        and entry_run[0] - 0.001 <= extended["in_cue"]
                        and extended["in_cue"] + extended["overlap_seconds"] * extended["playback_rate"] <= entry_run[1] + 0.001
                        and _grid_runway(outgoing, extended["out_cue"], extended["overlap_seconds"])
                        and _grid_runway(incoming, extended["in_cue"],
                                         extended["overlap_seconds"] * extended["playback_rate"])):
                    return extended
            return plan
    technique = "safe_fade" if confidence < 0.42 else "echo_cut" if steady else "structural_fade"
    return _transition_plan(outgoing, incoming, technique, 8, score, confidence)


def _section_run(analysis: Mapping[str, Any], anchor: str) -> tuple[float, float] | None:
    """Intro/outro extended only through adjacent measured quiet blocks.

    The analyser labels intro/outro on one eight-bar block; a longer quiet
    opening/tail has neighbouring breakdown blocks. Never cross a body, build,
    drop or unmeasured gap to claim more runway.
    """
    if not analysis.get("analysed") or not analysis.get("beat_grid"):
        return None
    sections = analysis.get("sections") or []
    for index, section in enumerate(sections):
        if section["label"] != anchor:
            continue
        start, end = float(section["start"]), float(section["end"])
        neighbours = reversed(sections[:index]) if anchor == "outro" else iter(sections[index + 1:])
        for neighbour in neighbours:
            gap = start - neighbour["end"] if anchor == "outro" else neighbour["start"] - end
            if neighbour["label"] not in {anchor, "breakdown"} or abs(gap) > 0.001:
                break
            start, end = min(start, neighbour["start"]), max(end, neighbour["end"])
        return start, end
    return None


def _grid_runway(analysis: Mapping[str, Any], cue: float, span: float) -> bool:
    """A long mix needs a measured, straight grid throughout, without gaps.

    Each deck gets half the existing 5 ms phase budget. This also rejects
    absent middle windows in long recordings and locally wandering grids.
    """
    period = _local_period(analysis, cue, span)
    grid = analysis.get("beat_grid") or []
    points = grid[bisect.bisect_left(grid, cue - 0.001):bisect.bisect_right(grid, cue + span + period)]
    return bool(points and abs(points[0] - cue) <= PHASE_TOLERANCE_SECONDS / 2 and points[-1] >= cue + span - period
                and all(0 < right - left <= 1.5 * period for left, right in zip(points, points[1:]))
                and all(abs(point - cue - round((point - cue) / period) * period) <= PHASE_TOLERANCE_SECONDS / 2 for point in points))


def _transition_plan(outgoing: Mapping[str, Any], incoming: Mapping[str, Any],
                     technique: str, bars: int, blend_score: float, confidence: float) -> TransitionPlan:
    bar_seconds = float(outgoing.get("bar_seconds") or 2.0)
    overlap = max(4.0, min(48.0, bars * bar_seconds))
    duration = float(outgoing.get("duration") or 0)
    if duration:
        # Match both players' runtime limit before aligning a drop to the end
        # of the overlap. A later shortening would invalidate that alignment.
        overlap = max(1.5, min(overlap, duration * 0.25))
    # `None` means "place it against the real duration". The player knows what it
    # actually loaded; a cue invented here from an unknown length is worse than
    # no cue at all, because it looks authoritative.
    outro = outgoing.get("outro_cue")
    # Both players start their blend no later than one second before
    # `duration - overlap`, and move a later cue (`resolveTransition`,
    # `ProgramDjPlan.resolve`). The extra half second absorbs the difference
    # between this measured duration and the one the player loaded, so a
    # measured downbeat reaches the mix unmoved.
    latest = max(0.0, duration - overlap - _OUT_CUE_MARGIN)
    earliest = min(90.0, duration * 0.6, latest) if duration else 0.0
    if outro is None and not duration:
        out_cue = None
    else:
        proposed_out = float(outro if outro is not None else max(0.0, duration - overlap))
        out_cue = min(proposed_out, latest) if duration else proposed_out
    if out_cue is not None and outgoing.get("analysed"):
        out_cue = _nearest_grid_point(outgoing, float(out_cue))
        if duration and out_cue > latest:
            out_cue = _grid_point_at_or_before(outgoing, latest)
        if duration:
            if technique != "long_blend":
                out_cue, overlap = _structural_exit(outgoing, out_cue, overlap, earliest, duration)
            if out_cue < earliest:
                grid = outgoing.get("downbeats") or outgoing.get("beat_grid") or []
                valid = [float(value) for value in grid if earliest <= float(value) <= latest]
                out_cue = min(valid) if valid else earliest
    in_cue = float(incoming.get("intro_cue") or 0)
    if incoming.get("analysed"):
        in_cue = _nearest_grid_point(incoming, in_cue)

    if technique in BEATMATCH_TECHNIQUES and out_cue is not None:
        entry = _drop_entry(outgoing, incoming, out_cue, in_cue, overlap,
                            _MAX_STRETCH)
        if entry is not None:
            in_cue, overlap = entry

    # The tempo across the stretch that is actually mixed, not at one point.
    out_period = _local_period(outgoing, float(out_cue or 0), overlap)
    in_period = _local_period(incoming, in_cue, overlap)
    # playbackRate scales the incoming tempo. A 125 BPM incoming track needs
    # 120/125 = 0.96 to sit on a 120 BPM outgoing grid.
    local_ratio = in_period / out_period if out_period > 0 and in_period > 0 else 1.0
    local_ratio = comparable_ratio(local_ratio)
    # Above six percent, resampling is more audible than a structural cut. The
    # score can still select a safe technique, but never asks the player to
    # torture a recording merely to claim that it beatmatched.
    playback_rate = local_ratio if abs(1 - local_ratio) <= _MAX_STRETCH else 1.0
    if technique not in BEATMATCH_TECHNIQUES:
        playback_rate = 1.0
    # Echo repeats one measured outgoing beat at the actual exit, never an
    # invented period from bar_seconds or the incoming song. Two seconds is
    # the bounded delay supported by both renderers (30 BPM at normal speed).
    echo_delay = None
    if technique == "echo_cut":
        if (outgoing.get("analysed") and outgoing.get("beat_grid")
                and float(outgoing.get("bpm") or 0) > 0 and float(outgoing.get("tempo_confidence") or 0) > 0.6
                and math.isfinite(out_period) and 0 < out_period <= 2):
            echo_delay = round(out_period, 6)
        else:
            technique = "structural_fade"
    return {
        "technique": technique,
        "out_cue": round(out_cue, 4) if out_cue is not None else None,
        "in_cue": round(in_cue, 4),
        "overlap_seconds": round(overlap, 3),
        "overlap_bars": round(overlap / (4 * out_period), 3),
        # Over a 48 s overlap, 1e-6 of rate error is 0.05 ms of drift.
        "playback_rate": round(playback_rate, 6),
        **({"echo_delay_seconds": echo_delay} if echo_delay is not None else {}),
        "score": round(blend_score, 3),
        "confidence": round(confidence, 3),
        "fallback": technique in {"echo_cut", "safe_fade", "structural_fade"},
        "sync": {
            "out_period": round(out_period, 6),
            "in_period": round(in_period, 6),
            "phase_tolerance_ms": int(PHASE_TOLERANCE_SECONDS * 1000),
            "grid_source": "measured" if outgoing.get("beat_grid") and incoming.get("beat_grid") else "estimated",
        },
    }
