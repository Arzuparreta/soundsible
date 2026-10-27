"""Phrases, sections and candidate cues on the measured bars; no pulse or bar detector.

The bars are the beat model's (P12-b): its first beats, or whole bars counted
from one along a steady pulse (`timing.projected_bar`). A run of bars ends
where they do; nothing is counted across a block whose bar is unknown or across
the unmeasured middle of a long recording.

Three things are kept apart (P13):

- **Phrase starts.** A bar line where the arrangement measurably changes: in
  some octave band the four bars after it differ from the four before by at
  least 3 dB, the change of a sound carrying as much power as the band already
  had entering it (or half of it leaving), and by more than three standard
  errors of those bars. Each bar is the median of its beats' levels, so a
  pickup or a decaying tail on one beat does not move a change to another
  bar. Between changes, phrases are counted in whole bars from each change:
  with the length the intervals between changes share where that is
  established at the three-sigma level, else with eight bars, an assumption
  marked as such.
- **Sections.** Consecutive phrases with one role.
- **Roles**, from levels with units. The kick and bass octaves (44-177 Hz) at
  least 10 dB under the track's loudest section there, less than half as loud,
  by more than three standard errors: no beat (breakdown; build when its upper
  octaves rise by at least 3 dB across it into a drop). Within 10 dB by as
  much: the beat (body; drop where it returns after none). Neither: the state
  of the previous section, or no role. intro: the track's opening phrases
  while each change adds sound and removes none; outro: its closing phrases
  while each change removes sound and adds none.

The constants are signal-processing and statistical ones, checked against
synthetic signals with known answers (tests/test_dj_structure.py), not values
fitted to songs or to anyone's taste.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from .contracts import Phrase, Section, Structure, WindowFeatures
from .timing import projected_bar

# Power doubled or halved in a band: a sound at least as strong as what the
# band held enters, or one holding half of it leaves.
_CHANGE_DB = 10 * math.log10(2)


# Less than half as loud: loudness doubles every 10 phon (Stevens).
_ABSENT_DB = 10.0


# Bars compared either side of a bar line: four observations, the repetitions
# `metre` requires, and the shortest phrase this resolves.
_SIDE_BARS = 4


_ERRORS = 3.0


# The two-sided tail of three standard errors, 0.0027.
_ALPHA = math.erfc(_ERRORS / math.sqrt(2))


_ASSUMED_PHRASE_BARS = 8


# The 63 and 125 Hz octaves of `features.OCTAVE_CENTRES`: 44-177 Hz.
_LOW_BANDS = 2


def _bar_runs(window: Mapping[str, Any]) -> list[tuple[list[float], float]]:
    """(first beats of consecutive bars, end of their coverage), window seconds.

    A run follows contiguous regions with bars; it ends at a region without
    one or at a gap between regions.
    """
    rows = window['metric_regions']
    analysis = {'metric_regions': rows, 'beat_grid': window['beats']}
    runs: list[tuple[list[float], float]] = []
    current: list[float] = []
    previous = None
    for row in rows:
        ones = row['downbeats'] or (projected_bar(analysis, row) or {}).get('downbeats') or []
        if current and (not ones or abs(previous['end'] - row['start']) > 1e-3):
            runs.append((current, float(previous['end'])))
            current = []
        # Region limits are rounded to 0.1 ms and the window grid is not: a
        # projected bar can end on the next region's first beat.
        for value in ones:
            if not current or value > current[-1] + 1e-3:
                current.append(float(value))
        previous = row
    if current:
        runs.append((current, float(previous['end'])))
    return runs


def _beat_levels(window: Mapping[str, Any], grid):
    """dB of each beat: every octave band, then the low and the upper octaves together."""
    import numpy as np

    power = np.asarray(window['band_power'], dtype=np.float64)
    if power.ndim != 2 or power.shape[1] <= _LOW_BANDS or grid.size < 2:
        return None
    centres = np.arange(power.shape[0]) * float(window['hop_seconds']) + float(window['frame_seconds']) / 2
    columns = np.column_stack([power, power[:, :_LOW_BANDS].sum(axis=1), power[:, _LOW_BANDS:].sum(axis=1)])
    cumulative = np.vstack([np.zeros((1, columns.shape[1])), np.cumsum(columns, axis=0)])
    edges = np.searchsorted(centres, grid)
    counts = np.diff(edges)
    with np.errstate(divide='ignore', invalid='ignore'):
        mean = (cumulative[edges[1:]] - cumulative[edges[:-1]]) / counts[:, None]
    levels = 10 * np.log10(np.maximum(mean, 1e-12))
    levels[counts == 0] = np.nan
    return levels


def _bars(beat_levels, grid, ones: list[float], end: float):
    """Bar edges (window seconds) and each bar's median beat levels.

    The last first beat closes a whole bar only where the grid reaches its
    end inside the measured coverage, with as many beats as the bar before.
    """
    import warnings

    import numpy as np

    index = np.searchsorted(grid, np.asarray(ones) - 1e-3)
    closing = 2 * index[-1] - index[-2] if index.size > 1 else grid.size
    if closing < grid.size and grid[closing] <= end + 1e-3:
        index = np.append(index, closing)
    if index.size < 2:
        return grid[index], np.empty((0, beat_levels.shape[1]))
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)  # A bar without frames stays NaN.
        levels = np.array([np.nanmedian(beat_levels[a:b], axis=0) for a, b in zip(index, index[1:])])
    return grid[index], levels


def _changes(levels) -> list[tuple[int, Any, Any]]:
    """(bar, change per band in dB, significant bands) at each measured change.

    Only the bar line with the largest margin over its neighbours within four
    bars is kept, the earlier one on a tie, so two changes are at least four
    bars apart and a steady ramp yields one change, not one every few bars.
    """
    import numpy as np

    bands = levels[:, :-2]
    count = len(levels)
    margins = np.full(count, -np.inf)
    found: dict[int, tuple[Any, Any]] = {}
    for bar in range(_SIDE_BARS, count - _SIDE_BARS + 1):
        before, after = bands[bar - _SIDE_BARS:bar], bands[bar:bar + _SIDE_BARS]
        if not (np.isfinite(before).all() and np.isfinite(after).all()):
            continue
        delta = after.mean(axis=0) - before.mean(axis=0)
        error = np.sqrt((before.var(axis=0, ddof=1) + after.var(axis=0, ddof=1)) / _SIDE_BARS)
        margin = np.abs(delta) - np.maximum(_ERRORS * error, _CHANGE_DB)
        margins[bar] = float(margin.max())
        found[bar] = (delta, margin > 0)
    kept = []
    for bar in found:
        if margins[bar] <= 0:
            continue
        earlier = margins[max(0, bar - _SIDE_BARS + 1):bar]
        later = margins[bar + 1:bar + _SIDE_BARS]
        if (earlier < margins[bar]).all() and (later <= margins[bar]).all():
            kept.append((bar, *found[bar]))
    return kept


def _binomial_tail(trials: int, hits: int, probability: float) -> float:
    return sum(math.comb(trials, k) * probability ** k * (1 - probability) ** (trials - k)
               for k in range(hits, trials + 1))


def phrase_length(changes: list[int], bars: int) -> int | None:
    """Bars that the intervals between consecutive changes share, or None.

    A length L must divide at least two intervals, more of them than chance
    allows: an interval is a multiple of L with probability 1/L, the binomial
    tail is multiplied by the number of lengths tried (Bonferroni) and must
    stay under the three-sigma level. Lengths from four bars (the resolution
    of a change) to a quarter of the run (four repetitions); the smallest
    tail wins, so 16-bar changes give 16, not 8 or 4.
    """
    intervals = [right - left for left, right in zip(changes, changes[1:])]
    lengths = range(_SIDE_BARS, bars // 4 + 1)
    best = None
    for length in lengths:
        hits = sum(interval % length == 0 for interval in intervals)
        if hits < 2:
            continue
        tail = _binomial_tail(len(intervals), hits, 1 / length) * len(lengths)
        if tail < _ALPHA and (best is None or tail < best[0]):
            best = (tail, length)
    return best[1] if best else None


def _phrase_starts(changes: list[int], bars: int, length: int | None) -> dict[int, str]:
    """Bar index -> evidence of every phrase start in one run.

    Counting restarts at every change, so an extension or an anacrusis moves
    the phrases after it. A counted start closer than four bars to the next
    change is left out: that change, not the count, ends the phrase.
    """
    step = length or _ASSUMED_PHRASE_BARS
    evidence = 'counted' if length else 'assumed'
    starts = {bar: 'boundary' for bar in changes}
    anchors = changes or [0]
    if not changes:
        starts[0] = 'assumed'
    bar = anchors[0] - step
    while bar >= 0:
        starts[bar] = evidence
        bar -= step
    for index, anchor in enumerate(anchors):
        stop = anchors[index + 1] - _SIDE_BARS if index + 1 < len(anchors) else bars - 1
        bar = anchor + step
        while bar <= stop:
            starts.setdefault(bar, evidence)
            bar += step
    return dict(sorted(starts.items()))


def _state(low: float, error: float, reference: float, previous: str | None) -> str | None:
    """'absent' or 'present' beat in the kick/bass octaves, or the previous state."""
    gap = reference - low
    if gap - _ABSENT_DB > _ERRORS * error:
        return 'absent'
    if _ABSENT_DB - gap > _ERRORS * error:
        return 'present'
    return previous


def _rises(values) -> bool:
    """A level rising by at least 3 dB across the bars, beyond three standard errors of the slope."""
    import numpy as np

    if values.size < 3 or not np.isfinite(values).all():
        return False
    x = np.arange(values.size, dtype=float)
    slope, intercept = np.polyfit(x, values, 1)
    residual = values - (slope * x + intercept)
    error = math.sqrt(float(residual @ residual) / (values.size - 2) / float(((x - x.mean()) ** 2).sum()))
    return slope * (values.size - 1) >= _CHANGE_DB and slope > _ERRORS * error


def _sections(runs: list[dict[str, Any]]) -> list[Section]:
    """Measured roles of the phrases between changes, merged into sections."""
    import numpy as np

    segments = []
    for number, run in enumerate(runs):
        cuts = [0] + [bar for bar, _, _ in run['changes']] + [len(run['levels'])]
        for first, stop in zip(cuts, cuts[1:]):
            low, upper = run['levels'][first:stop, -2], run['levels'][first:stop, -1]
            segments.append({'run': number, 'first': first, 'stop': stop, 'low': low, 'upper': upper})
    sized = [row for row in segments if row['stop'] - row['first'] >= 2 and np.isfinite(row['low']).all()]
    if not sized:
        return []
    low_reference = max(float(row['low'].mean()) for row in sized)
    upper_reference = max(float(row['upper'].mean()) for row in sized)

    result: list[Section] = []
    for number, run in enumerate(runs):
        rows = [row for row in segments if row['run'] == number]
        changes = {bar: (delta, significant) for bar, delta, significant in run['changes']}

        def adds(bar: int) -> bool:
            delta, significant = changes[bar]
            return bool((significant & (delta > 0)).any() and not (significant & (delta < 0)).any())

        def removes(bar: int) -> bool:
            delta, significant = changes[bar]
            return bool((significant & (delta < 0)).any() and not (significant & (delta > 0)).any())

        labels: list[str | None] = [None] * len(rows)
        if run['changes']:
            states: list[str | None] = []
            for row in rows:
                size = row['stop'] - row['first']
                if size < 2 or not np.isfinite(row['low']).all():
                    states.append(None)
                    continue
                error = float(row['low'].std(ddof=1)) / math.sqrt(size)
                states.append(_state(float(row['low'].mean()), error, low_reference, states[-1] if states else None))
            for index, state in enumerate(states):
                if state == 'present':
                    labels[index] = 'drop' if index and states[index - 1] == 'absent' else 'body'
                elif state == 'absent':
                    leads = index + 1 < len(rows) and states[index + 1] == 'present'
                    labels[index] = 'build' if leads and _rises(rows[index]['upper']) else 'breakdown'
            # The track opens until its beat starts or, opening on the beat,
            # while each change only adds sound. It closes from where its beat
            # stops or, closing on the beat, from where each change only
            # removes sound.
            if number == 0:
                beatless = states[0] == 'absent'
                index = 0
                while index < len(rows) and (states[index] == 'absent' if beatless
                                             else index + 1 < len(rows) and adds(rows[index + 1]['first'])):
                    labels[index] = 'intro'
                    index += 1
            if number == len(runs) - 1:
                beatless = states[-1] == 'absent'
                index = len(rows) - 1
                while index >= 0 and labels[index] != 'intro' and (
                        states[index] == 'absent' if beatless else index > 0 and removes(rows[index]['first'])):
                    labels[index] = 'outro'
                    index -= 1
        start = 0
        while start < len(rows):
            stop = start + 1
            while stop < len(rows) and labels[stop] == labels[start]:
                stop += 1
            first, last = rows[start]['first'], rows[stop - 1]['stop']
            low = run['levels'][first:last, -2]
            upper = run['levels'][first:last, -1]
            result.append({
                'start': round(run['offset'] + float(run['edges'][first]), 4),
                'end': round(run['offset'] + float(run['edges'][last]), 4),
                'bars': int(last - first),
                'label': labels[start],
                'low_db': round(float(np.nanmean(low)) - low_reference, 2) if np.isfinite(low).any() else None,
                'upper_db': round(float(np.nanmean(upper)) - upper_reference, 2) if np.isfinite(upper).any() else None,
                'starts_on_change': first > 0,
            })
            start = stop
    return result


def measured_runs(features: WindowFeatures, head_features: WindowFeatures | None, *,
                  tail_start: float) -> list[dict[str, Any]]:
    """Each run of measured bars: offset, bar edges, bar levels, changes and phrase length."""
    import numpy as np

    windows = [(features, tail_start, math.inf)]
    if tail_start and head_features is not None:
        windows.insert(0, (head_features, 0.0, tail_start))
    runs = []
    for window, offset, limit in windows:
        grid = np.asarray(window['beats'], dtype=float)
        levels = _beat_levels(window, grid)
        if levels is None:
            continue
        for ones, end in _bar_runs(window):
            ones = [value for value in ones if offset + value < limit]
            if not ones:
                continue
            edges, bars = _bars(levels, grid, ones, min(end, limit - offset))
            if len(bars) == 0:
                continue
            changes = _changes(bars)
            runs.append({'offset': offset, 'edges': edges, 'levels': bars, 'changes': changes,
                         'length': phrase_length([bar for bar, _, _ in changes], len(bars))})
    return runs


def structure_from_windows(
    features: WindowFeatures,
    head_features: WindowFeatures | None,
    *,
    duration: float,
    tail_start: float,
) -> Structure:
    """Grids, phrases, sections and cues from the measured windows (P13)."""
    period = features["period"]
    intro_local = head_features["intro"] if head_features is not None else 0.0

    def window_grid(window_features: Mapping[str, Any], offset: float) -> tuple[list[float], list[float]]:
        beats = [offset + float(value) for value in window_features["beats"]]
        return beats, [offset + value for region in window_features["metric_regions"]
                       for value in region["downbeats"]]

    beats, downbeats = window_grid(features, tail_start)
    if tail_start and head_features is not None:
        head_beats, head_downbeats = window_grid(head_features, 0.0)
        # The windows are measured apart; neither grid is extended across the gap.
        beats = [value for value in head_beats if value < tail_start] + beats
        downbeats = [value for value in head_downbeats if value < tail_start] + downbeats
    beats = [value for value in beats if 0 <= value <= duration]
    downbeats = [value for value in downbeats if 0 <= value <= duration]

    runs = measured_runs(features, head_features, tail_start=tail_start)
    phrases: list[Phrase] = []
    for run in runs:
        starts = _phrase_starts([bar for bar, _, _ in run['changes']], len(run['levels']), run['length'])
        indices = list(starts)
        for position, bar in enumerate(indices):
            following = indices[position + 1] if position + 1 < len(indices) else len(run['levels'])
            at = run['offset'] + float(run['edges'][bar])
            if 0 <= at < duration:
                phrases.append({'start': round(at, 4), 'bars': following - bar, 'evidence': starts[bar]})
    sections = [row for row in _sections(runs) if 0 <= row['start'] < duration]

    last_active = tail_start + features["last_active"]
    last_regions = features['metric_regions']
    reserve = float(last_regions[-1]['bar_seconds'] or 2.) if last_regions else 2.
    outro_limit = min(last_active, duration - reserve)
    desired_outro = max(0.0, outro_limit - 64 * period)
    outro_candidates = [row['start'] for row in phrases if desired_outro <= row['start'] <= outro_limit]
    outro = outro_candidates[0] if outro_candidates else max(0.0, duration - 32 * period)

    return {
        "beat_grid": [round(float(value), 4) for value in beats],
        "downbeats": [round(float(value), 4) for value in downbeats],
        "phrases": phrases,
        "sections": sections,
        "intro_cue": round(max(0.0, min(intro_local, duration * 0.25)), 3),
        "outro_cue": round(max(0.0, min(outro, duration - reserve)), 3),
    }
