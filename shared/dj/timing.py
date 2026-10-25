"""Shared tempo equivalence and execution budget, without musical selection.

Scoring/execution fold one octave at the existing 0.7/1.4 boundaries. Route
continuity projects onto a reference octave instead; that distinct objective
retains its logarithmic folding. Neither operation detects metre (P12).
"""

from __future__ import annotations

import bisect
import math

from .contracts import AnalysisInput, PlanInput, PlaybackRatio, Seconds

MAX_STRETCH = 0.06
PHASE_TOLERANCE_SECONDS = 0.005
BEATMATCH_TECHNIQUES = frozenset({'bass_swap', 'filter_blend', 'long_blend'})


def comparable_ratio(ratio: PlaybackRatio) -> PlaybackRatio:
    """Existing half/double-pulse equivalence, one octave at most."""
    if ratio < 0.7:
        return ratio * 2
    if ratio > 1.4:
        return ratio / 2
    return ratio


def tempo_coordinate(bpm: float, reference: float) -> float:
    """BPM projected onto the route reference octave, for continuity distance."""
    return bpm * 2 ** round(math.log2(reference / bpm))


def rate_drift(playback_rate: PlaybackRatio, ratio: PlaybackRatio, overlap: Seconds) -> Seconds:
    """Cumulative error using the rounded rate/periods sent to the players."""
    return abs(playback_rate / ratio - 1) * overlap


def rate_fits(plan: PlanInput, *, tolerance: Seconds | None = PHASE_TOLERANCE_SECONDS) -> bool:
    """Validate even old/incomplete plans at the bridge admission boundary.

    The planner supplies complete positive periods. Reject missing/invalid
    evidence here rather than inferring pulse from a technique or a score.
    Renderers keep their own duration/source/rate guards in each platform.
    """
    try:
        sync = plan['sync']
        budget = float(sync['phase_tolerance_ms']) / 1000 if tolerance is None else tolerance
        out_period, in_period = float(sync['out_period']), float(sync['in_period'])
        rate, overlap = float(plan['playback_rate']), float(plan['overlap_seconds'])
        if not all(math.isfinite(value) and value > 0 for value in (out_period, in_period, rate, overlap)):
            return False
        return math.isfinite(budget) and budget >= 0 and rate_drift(rate, comparable_ratio(in_period / out_period), overlap) <= budget
    except (KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError):
        return False


def local_period(analysis: AnalysisInput, cue: float, span: float = 0.0) -> float:
    """Seconds per beat across [cue, cue + span], from a line through the grid there.

    The median of neighbouring intervals cannot resolve a tempo difference
    smaller than the grid's rounding; a line through a few dozen beats can, and
    it follows a drifting performance over the stretch actually being mixed.
    """
    bpm = float(analysis.get("bpm") or 0)
    coarse = 60 / bpm if bpm > 0 else max(0.25, float(analysis.get("bar_seconds") or 2) / 4)
    grid = analysis.get("beat_grid") or []
    lo = bisect.bisect_left(grid, cue - 2 * coarse)
    hi = bisect.bisect_right(grid, cue + max(span, 16 * coarse) + 2 * coarse)
    points = [float(value) for value in grid[lo:hi]]
    if len(points) < 4:
        return coarse
    numbers = [0]
    for left, right in zip(points, points[1:]):
        numbers.append(numbers[-1] + max(1, round((right - left) / coarse)))
    mean_x = sum(numbers) / len(numbers)
    mean_y = sum(points) / len(points)
    variance = sum((x - mean_x) ** 2 for x in numbers)
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(numbers, points)) / variance if variance else 0.0
    return slope if slope > 0 else coarse
