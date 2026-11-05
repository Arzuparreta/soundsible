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
from contextlib import contextmanager
from contextvars import ContextVar

from .contracts import AnalysisInput, PlanInput, PlaybackRatio, Seconds

# The pitch range of a turntable or CDJ (decision of the user, P12-b: 120 and
# 128 BPM were heard as mixable and are 6.7 % apart).
MAX_STRETCH = 0.08
PHASE_TOLERANCE_SECONDS = 0.005
BEATMATCH_TECHNIQUES = frozenset({'bass_swap', 'filter_blend', 'long_blend'})
# The smallest speed change the players make: phase riding and the return to
# normal speed move in quarter-percent steps. A split plan leaves one step
# inside the pitch range, so the incoming deck can still be nudged both ways.
RATE_STEP = 0.0025
# The outgoing deck reaches its mix speed with the same 8 s ramp the players
# already use to return to normal speed, measured in outgoing media seconds.
RATE_RAMP_SECONDS = 8.0
# The ramp ends this long before `out_cue`: the players' silent preroll lasts
# at most 4 s, and Android arms the blend only after the outgoing speed has
# settled (1 s), at up to 7.75 % above normal speed (4 + 1 s at 1.0775 is
# 5.4 media seconds). The rest is margin for the cue the player relocates.
RATE_RAMP_END_LEAD = 7.0

# Clients that can play both decks at a shared tempo send
# `X-Soundsible-Dj-Rates: split` (`session.scoped`). Every other client keeps
# the plans it was built for: only the incoming deck changes speed.
_SPLIT_RATES: ContextVar[bool] = ContextVar('dj_split_rates', default=False)


@contextmanager
def split_rates(enabled: bool):
    """Plan for clients that move both decks toward a common tempo."""
    token = _SPLIT_RATES.set(bool(enabled))
    try:
        yield
    finally:
        _SPLIT_RATES.reset(token)


def split_enabled() -> bool:
    return _SPLIT_RATES.get()


def deck_rates(relation: PlaybackRatio) -> tuple[PlaybackRatio, PlaybackRatio] | None:
    """(outgoing, incoming) deck speeds that hold `relation`, or None.

    `relation` is incoming media seconds per outgoing media second. Without
    split clients only the incoming deck moves (outgoing 1.0, 8 % range).
    With them, both share the change so that neither moves more than the
    other: s_out = 2 / (1 + r) and s_in = r · s_out deviate from normal speed
    by the same |1 − r| / (1 + r), the smallest possible largest change of the
    two (120 ↔ 140 BPM: 129.23 BPM, each deck 7.69 %).
    """
    if not (math.isfinite(relation) and relation > 0):
        return None
    if not split_enabled():
        return (1.0, relation) if abs(1 - relation) <= MAX_STRETCH else None
    out = 2 / (1 + relation)
    return (out, relation * out) if abs(1 - out) <= MAX_STRETCH - RATE_STEP + 1e-12 else None


def deviation(relation: PlaybackRatio) -> float:
    """The larger speed change of the two decks that hold `relation`."""
    return abs(1 - relation) / (1 + relation) if split_enabled() else abs(1 - relation)

# (outgoing beats, incoming beats) of one common cycle. Up to four a side
# covers every pair of tempi the beat model reports (55–215 BPM).
CYCLES = ((1, 1), (1, 2), (2, 1), (2, 3), (3, 2), (3, 4), (4, 3), (1, 3), (3, 1), (1, 4), (4, 1))


def pulse_relations(ratio: PlaybackRatio) -> list[tuple[int, int, PlaybackRatio]]:
    """Every common cycle and the playback rate it needs, closest to 1 first.

    `ratio` is incoming over outgoing beat period. m outgoing beats equal n
    incoming beats played at `rate`: m · out_period = n · in_period / rate.
    One beat against one beat comes first whenever the players can hold it
    (decision of the user, 2026-11-05): with both decks moving, 120 ↔ 140 BPM
    meet at 129.23 BPM in 1:1 rather than at 3:4, which needs one point less of
    speed change but keeps only one beat in three together. Within one deck's
    range no other cycle can also fit next to 1:1, so old clients are unchanged.
    """
    def key(row):
        return (not (row[:2] == (1, 1) and deck_rates(row[2]) is not None), deviation(row[2]), row[0] + row[1])
    return sorted(((m, n, ratio * n / m) for m, n in CYCLES), key=key)


def pulse_relation(ratio: PlaybackRatio):
    """The common cycle the players can hold, or None beyond their speed limit."""
    best = pulse_relations(ratio)[0]
    return best if deck_rates(best[2]) is not None else None


def tempo_coordinate(bpm: float, reference: float) -> float:
    """BPM projected onto the route reference octave, for continuity distance."""
    return bpm * 2 ** round(math.log2(reference / bpm))


def rate_drift(playback_rate: PlaybackRatio, ratio: PlaybackRatio, overlap: Seconds) -> Seconds:
    """Cumulative error using the rounded rate/periods sent to the players."""
    return abs(playback_rate / ratio - 1) * overlap


def rate_fits(plan: PlanInput, *, tolerance: Seconds | None = PHASE_TOLERANCE_SECONDS) -> bool:
    """Validate even incomplete plans at the bridge admission boundary.

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
        if sync.get('alignment') not in ('bars', 'beats'):
            return False
        out_rate = float(plan.get('out_playback_rate', 1.0))
        if not (math.isfinite(out_rate) and abs(1 - out_rate) <= MAX_STRETCH + 1e-9
                and abs(1 - out_rate * rate) <= MAX_STRETCH + 1e-9):
            return False
        if out_rate != 1.0:
            ramp = plan['out_rate_ramp']
            lead, length = float(ramp['lead_seconds']), float(ramp['seconds'])
            if not (math.isfinite(lead) and math.isfinite(length) and 0 < length < lead
                    and float(plan['out_cue']) - lead >= 0):
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
        cycle = sync['cycle_beats']
        beats = (int(cycle[0]), int(cycle[1]))
        if beats not in CYCLES or list(beats) != list(cycle):
            return False
        expected = in_period * beats[1] / (out_period * beats[0])
        step = sync.get('relocation_seconds')
        if step is not None and not (math.isfinite(float(step)) and float(step) > 0):
            return False
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


def projected_bar(analysis: AnalysisInput, region):
    """Beats of a region without a bar that lie whole bars from a measured one.

    The beat model may give no one where only harmony plays: an intro whose
    counterpoint suggests another one, until the beat enters and reveals the
    bar ("Teardrops (Rules Remix)", decision of the user, P12-b). Counting
    beats carries the nearest measured one into the region, the following one
    first: the bar the music goes on to play. The count holds only along one
    steady pulse on a regular, gapless grid. Returns the region's beats on
    those ones and the bar's pulse count, or None.
    """
    rows = list(analysis.get('metric_regions') or [])
    if region not in rows or region.get('beats_per_bar') or region.get('pulse_confidence', 0) <= STEADY_PULSE:
        return None
    index = rows.index(region)
    grid = analysis.get('beat_grid') or []
    for step in (1, -1):
        position = index
        while 0 <= position + step < len(rows):
            neighbour = rows[position + step]
            boundary = (rows[position]['end'], neighbour['start']) if step > 0 else (neighbour['end'], rows[position]['start'])
            if abs(boundary[0] - boundary[1]) > 1e-3 or neighbour.get('pulse_confidence', 0) <= STEADY_PULSE:
                break
            ones = neighbour.get('downbeats') or []
            size = neighbour.get('beats_per_bar')
            if size and ones:
                anchor = float(ones[0] if step > 0 else ones[-1])
                beats = [float(t) for t in grid if region['start'] <= t < region['end']]
                period = float(region['period'])
                if not beats:
                    return None
                first, last = (beats[0], anchor) if step > 0 else (anchor, beats[-1])
                if not _grid_holds(analysis, first, last - first, period, PHASE_TOLERANCE_SECONDS / 2):
                    break
                return {'downbeats': [t for t in beats if round((anchor - t) / period) % size == 0],
                        'beats_per_bar': size}
            position += step
    return None


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
        projected = None if region.get('beats_per_bar') else projected_bar(analysis, region)
        return {
            'start': run[0]['start'], 'end': run[-1]['end'],
            'pulse_unit': region['pulse_unit'], 'beats_per_bar': size,
            # The bar the cue itself sits on: its one, and whole bars from it
            # within this region, are where a relocated cue may land. Where
            # the region has no bar, the one counted from a measured one.
            'cue_beats_per_bar': region.get('beats_per_bar') or (projected and projected['beats_per_bar']),
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

    Both cues sit on each song's first beat where one is known, or whole
    bars from the nearest one measured along the same pulse
    (`projected_bar`), so the common cycle (`cycle_beats`: m outgoing beats =
    n incoming beats) starts on both ones. `bars`: both first beats confirmed by independent evidence
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
    result = {'alignment': 'none', 'out_bar_seconds': None, 'in_bar_seconds': None,
              'out_metre': None, 'in_metre': None, 'cycle_beats': None, 'relocation_seconds': None}
    relation = pulse_relation(in_period / out_period) if out_period > 0 and in_period > 0 else None
    if relation is None:
        return result
    cycle = list(relation[:2])
    tolerance = PHASE_TOLERANCE_SECONDS / 2
    sides = ((outgoing, out_cue, span, out_period), (incoming, in_cue, span * rate, in_period))

    def step(region):
        # Whole bars of the region the cue sits in, also whole cycles. A bar
        # unknown elsewhere in the overlap does not shrink the step to a beat:
        # that moved a measured one off its one (P12-b, user's session).
        beats = region.get('cue_beats_per_bar', region['beats_per_bar']) or 0
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
