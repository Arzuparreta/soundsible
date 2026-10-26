"""Shared pulse relations and execution budget, without musical selection.

Two songs mix on a common cycle: whole numbers of beats of each that last the
same. Any reading of a pulse relates to another by factors of 2 and 3 — a
12/8 is a 4/4 with ternary beats, a 6/8 reads as two pulses or as three — so
1:1, 2:1, 3:2, 4:3, 3:1 and 4:1 are all relations the players can hold within
their speed limit (decision of the user, P12-b). Route continuity projects
BPM onto a reference octave instead; that distinct objective keeps its
logarithmic folding. Neither operation detects metre (P12).
"""

from __future__ import annotations

import bisect
import math

from .contracts import AnalysisInput, PlanInput, PlaybackRatio, Seconds

MAX_STRETCH = 0.06
PHASE_TOLERANCE_SECONDS = 0.005
BEATMATCH_TECHNIQUES = frozenset({'bass_swap', 'filter_blend', 'long_blend'})

# (outgoing beats, incoming beats) of one common cycle. Up to four a side
# covers every pair of tempi the beat model reports (55–215 BPM).
CYCLES = ((1, 1), (1, 2), (2, 1), (2, 3), (3, 2), (3, 4), (4, 3), (1, 3), (3, 1), (1, 4), (4, 1))


def pulse_relations(ratio: PlaybackRatio) -> list[tuple[int, int, PlaybackRatio]]:
    """Every common cycle and the playback rate it needs, closest to 1 first.

    `ratio` is incoming over outgoing beat period. m outgoing beats equal n
    incoming beats played at `rate`: m · out_period = n · in_period / rate.
    """
    return sorted(((m, n, ratio * n / m) for m, n in CYCLES), key=lambda row: (abs(row[2] - 1), row[0] + row[1]))


def pulse_relation(ratio: PlaybackRatio, max_stretch: float = MAX_STRETCH):
    """The common cycle the players can hold, or None beyond their speed limit."""
    best = pulse_relations(ratio)[0]
    return best if abs(best[2] - 1) <= max_stretch else None


def comparable_ratio(ratio: PlaybackRatio) -> PlaybackRatio:
    """The half/double-pulse equivalence of plans made before common cycles."""
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
        if 'out_bar_seconds' in sync and 'alignment' not in sync:
            return False  # Incomplete metric contract, not a legacy pulse plan.
        if 'alignment' in sync:
            if sync['alignment'] not in ('bars', 'beats'):
                return False
            bars = (sync['out_bar_seconds'], sync['in_bar_seconds'])
            if sync['alignment'] == 'bars' or bars != (None, None):
                out_bar, in_bar = float(bars[0]), float(bars[1])
                if not all(math.isfinite(value) and value > 0 for value in (out_bar, in_bar)):
                    return False
                if rate_drift(rate, in_bar / out_bar, overlap) > budget:
                    return False
            for prefix, cue, span in (('out', float(plan['out_cue']), overlap), ('in', float(plan['in_cue']), overlap * rate)):
                metre = sync[f'{prefix}_metre']
                if not (metre['start'] <= cue + budget and cue + span <= metre['end'] + budget):
                    return False
        cycle = sync.get('cycle_beats')
        if cycle is not None:
            beats = (int(cycle[0]), int(cycle[1]))
            if beats not in CYCLES or list(beats) != list(cycle):
                return False
            expected = in_period * beats[1] / (out_period * beats[0])
            step = sync.get('relocation_seconds')
            if step is not None and not (math.isfinite(float(step)) and float(step) > 0):
                return False
        else:
            expected = comparable_ratio(in_period / out_period)
        return math.isfinite(budget) and budget >= 0 and rate_drift(rate, expected, overlap) <= budget
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
    coverage = next((row for row in analysis.get('metric_regions') or [] if row['start'] <= cue < row['end']), None)
    if coverage:
        grid = grid[bisect.bisect_left(grid, coverage['start']):bisect.bisect_right(grid, coverage['end'])]
        coarse = float(coverage['period'])
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


def local_metre(analysis: AnalysisInput, cue: float, span: float = 0.0):
    """Evidence covering the entire executed interval, with an identified one."""
    for region in analysis.get('metric_regions') or []:
        if (region.get('beats_per_bar') and region.get('metre_confidence', 0) > 0
                and region.get('downbeat_confidence', 0) > 0 and region.get('downbeats')
                and region['start'] <= cue + PHASE_TOLERANCE_SECONDS
                and cue + span <= region['end'] + PHASE_TOLERANCE_SECONDS):
            return region
    return None


# A followed (drifting) grid has a pulse confidence of at most 0.6 (`rhythm`).
STEADY_PULSE = 0.6


def local_pulse(analysis: AnalysisInput, cue: float, span: float = 0.0):
    """Steady measured pulse across the entire executed interval, or None.

    Regions of one window are contiguous; a run of them may cover the span.
    The bar estimate is the beat model's where one length holds across the
    run, and None otherwise; its confidences are the run's weakest.
    """
    rows = [row for row in analysis.get('metric_regions') or []]
    for index, region in enumerate(rows):
        if not region['start'] <= cue + PHASE_TOLERANCE_SECONDS < region['end']:
            continue
        run = [region]
        while run[-1]['end'] < cue + span - PHASE_TOLERANCE_SECONDS and index + len(run) < len(rows):
            following = rows[index + len(run)]
            if abs(following['start'] - run[-1]['end']) > 1e-3:
                break  # The unmeasured gap between head and tail windows.
            run.append(following)
        if run[-1]['end'] + PHASE_TOLERANCE_SECONDS < cue + span:
            return None
        if any(row.get('pulse_confidence', 0) <= STEADY_PULSE for row in run):
            return None
        sizes = {row.get('beats_per_bar') for row in run}
        size = sizes.pop() if len(sizes) == 1 else None
        return {
            'start': run[0]['start'], 'end': run[-1]['end'],
            'pulse_unit': region['pulse_unit'], 'beats_per_bar': size,
            'subdivision': region['subdivision'],
            **{key: min(row[key] for row in run) for key in (
                'pulse_confidence', 'metre_confidence', 'downbeat_confidence', 'subdivision_confidence')},
        }
    return None


def _grid_holds(analysis: AnalysisInput, cue: float, length: float, period: float, tolerance: float) -> bool:
    """The cue on a measured beat and a regular, gapless grid to the end of the span."""
    grid = analysis.get('beat_grid') or []
    points = grid[bisect.bisect_left(grid, cue - tolerance):bisect.bisect_right(grid, cue + length + period)]
    if not points or abs(points[0] - cue) > tolerance or points[-1] < cue + length - period:
        return False
    if any(not 0 < b - a <= 1.5 * period for a, b in zip(points, points[1:])):
        return False
    return all(abs(t - cue - round((t - cue) / period) * period) <= tolerance for t in points)


_METRE_KEYS = ('start', 'end', 'pulse_unit', 'beats_per_bar', 'subdivision',
               'pulse_confidence', 'metre_confidence', 'downbeat_confidence', 'subdivision_confidence')


def metric_sync(outgoing: AnalysisInput, incoming: AnalysisInput, out_cue: float,
                in_cue: float, span: float, rate: float, out_period: float, in_period: float):
    """What the two players can keep aligned for the whole overlap.

    Both cues sit on each song's first beat where one is known, so the
    common cycle (`cycle_beats`: m outgoing beats = n incoming beats) starts
    on both ones. `bars`: both first beats confirmed by independent evidence
    and equal executed bars, whatever their pulse counts (four 0.5 s pulses,
    two 1 s pulses and three 0.667 s pulses all make a 2 s bar). `beats`: a
    steady pulse on both sides held on the common cycle; the beat model's
    bars, when both have one of equal executed length, are sent but not
    promised. `none` otherwise.

    `relocation_seconds` is the only step a player may move the outgoing cue
    by: whole outgoing bars that are also whole common cycles, so the
    outgoing one stays on the incoming one and on the cycle. Without a bar
    estimate, whole cycles.
    """
    if 'metric_regions' not in outgoing and 'metric_regions' not in incoming:
        return {}  # Legacy contract: its four-pulse prior is not new evidence.
    result = {'alignment': 'none', 'out_bar_seconds': None, 'in_bar_seconds': None,
              'out_metre': None, 'in_metre': None, 'cycle_beats': None, 'relocation_seconds': None}
    relation = pulse_relation(in_period / out_period) if out_period > 0 and in_period > 0 else None
    if relation is None:
        return result
    cycle = list(relation[:2])
    tolerance = PHASE_TOLERANCE_SECONDS / 2
    sides = ((outgoing, out_cue, span, out_period), (incoming, in_cue, span * rate, in_period))

    def step(region):
        beats = region['beats_per_bar'] or 0
        return round(out_period * (math.lcm(beats, cycle[0]) if beats else cycle[0]), 6)

    out, inc = local_metre(outgoing, out_cue, span), local_metre(incoming, in_cue, span * rate)
    if out is not None and inc is not None:
        out_bar, in_bar = round(out_period * out['beats_per_bar'], 6), round(in_period * inc['beats_per_bar'], 6)
        if (abs(in_bar / rate / out_bar - 1) * span <= tolerance
                and all(min(abs(cue - t) for t in region['downbeats']) <= tolerance
                        for region, (_, cue, _, _) in zip((out, inc), sides))
                and all(_grid_holds(*side, tolerance) for side in sides)):
            return {'alignment': 'bars', 'out_bar_seconds': out_bar, 'in_bar_seconds': in_bar,
                    'out_metre': {key: out[key] for key in _METRE_KEYS},
                    'in_metre': {key: inc[key] for key in _METRE_KEYS},
                    'cycle_beats': cycle, 'relocation_seconds': step(out)}
    out, inc = local_pulse(outgoing, out_cue, span), local_pulse(incoming, in_cue, span * rate)
    for prefix, region in (('out', out), ('in', inc)):
        if region:
            result[f'{prefix}_metre'] = {key: region[key] for key in _METRE_KEYS}
    if out is None or inc is None or not all(_grid_holds(*side, tolerance) for side in sides):
        return result
    result.update(alignment='beats', cycle_beats=cycle, relocation_seconds=step(out))
    if out['beats_per_bar'] and inc['beats_per_bar']:
        out_bar, in_bar = round(out_period * out['beats_per_bar'], 6), round(in_period * inc['beats_per_bar'], 6)
        if abs(in_bar / rate / out_bar - 1) * span <= tolerance:
            result['out_bar_seconds'], result['in_bar_seconds'] = out_bar, in_bar
    return result


def beatmatch_fits(plan: PlanInput, outgoing: AnalysisInput, incoming: AnalysisInput) -> bool:
    """Single bridge-admission rule for the actual technique and executed sync."""
    return (all(float(analysis.get('bpm') or 0) > 0 for analysis in (outgoing, incoming))
            and plan.get('technique') in BEATMATCH_TECHNIQUES and rate_fits(plan, tolerance=None))
