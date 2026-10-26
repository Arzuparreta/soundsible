"""Bars per region: the beat model's estimate and independent evidence for it.

The beat model (Beat This! + DBN) proposes how many pulses each bar has and
where it starts. Its activations do not separate right from wrong first beats
(P12-a), so they are no evidence of their own. `grouping` measures periodic
harmony changes and accents on the same grid: a profile must predict withheld
repetitions better than a constant profile, and the shortest statistically
indistinguishable period wins (3, not its multiple 6). Only where both agree on
size and phase do the bar and first-beat confidences leave zero. These are
measurements, not probabilities of a notated time signature.
"""
from __future__ import annotations


def grouping(observations):
    """(pulses/bar, phase, grouping confidence, first-pulse confidence).

    Each column is an independent physical observation. Harmony changes may
    identify a weak first beat even when another beat has the loudest attack.
    Four repetitions and a three-standard-error separation are required.
    """
    import numpy as np

    evidence = []
    for column in range(observations.shape[1]):
        values = observations[:, column]
        if column == 0:
            # Group chord-change EVENTS, not their magnitudes: alternating
            # large/small chord changes do not double the number of pulses in
            # a bar. Separate stable/changing chroma in log distance.
            logs = np.log(np.maximum(values, 1e-6))
            centres = np.percentile(logs, [25, 75])
            for _ in range(16):
                labels = np.abs(logs[:, None] - centres).argmin(axis=1)
                if not all(np.any(labels == label) for label in (0, 1)):
                    break
                updated = np.array([logs[labels == label].mean() for label in (0, 1)])
                if np.max(np.abs(updated - centres)) < 1e-6:
                    break
                centres = updated
            values = (logs > float(np.mean(centres))).astype(float)
        total = float(np.var(values))
        if total < 1e-8:
            continue
        candidates = []
        for size in (2, 3, 4, 6):
            cycles = len(values) // size
            if cycles < 4:
                continue
            rows = values[:cycles * size].reshape(cycles, size)
            means = rows.mean(axis=0)
            # Leave each bar out when predicting its phase profile.
            prediction = (rows.sum(axis=0) - rows) / (cycles - 1)
            errors = np.mean((rows - prediction) ** 2, axis=1)
            improvement = total - float(np.mean(errors))
            uncertainty = 3 * float(np.std(errors)) / cycles ** .5
            if improvement <= uncertainty:
                continue
            explained = max(0., min(1., improvement / total))
            candidates.append((size, explained, means, rows))
        if not candidates:
            continue
        best = max(row[1] for row in candidates)
        # Resolution of a finite sample: adding a multiple of the same pattern
        # is not new evidence for a longer bar.
        selected = next(row for row in candidates if row[1] >= best - 1 / len(values))
        size, explained, means, rows = selected
        phase = int(np.argmax(means))
        runner = float(np.partition(means, -2)[-2])
        margin = float(means[phase] - runner)
        noise = 3 * float(np.std(rows - means)) / rows.shape[0] ** .5
        first = max(0., min(1., (margin - noise) / max(float(np.ptp(means)), 1e-12)))
        evidence.append((column, size, phase, explained, first))
    if not evidence:
        return None, None, 0., 0.
    selected = max(evidence, key=lambda row: row[3])
    harmonic = next((row for row in evidence if row[0] == 0 and row[4] > 0), None)
    if harmonic and any(row[1] != harmonic[1] for row in evidence):
        # Alternating attack levels can repeat over two harmonic bars. A
        # shorter, phase-consistent chord-change cycle retains its grouping.
        if not all(row[1] % harmonic[1] == 0 and row[2] % harmonic[1] == harmonic[2]
                   for row in evidence):
            return None, None, 0., 0.
    # Chord-change events locate a weak one independently of attack loudness.
    column, size, phase, confidence, first = harmonic or selected
    return size, phase if first > 0 else None, confidence, first


def metric_regions(grid, novelty, strength, *, duration, period, pulse_confidence, subdivisions, first_beats):
    """Disjoint regions, each supported by at most 48 pulse observations.

    `first_beats` are the grid indices of the beat model's first beats. A block
    with one consistent bar length from the model carries it, its first beats
    and its bar duration; the confidences stay zero unless `grouping` on the
    same block finds that size and phase independently. 24 observations
    contain four repetitions of every tested grouping. No region or phase is
    extrapolated across unknown blocks. Adjacent matching estimates are merged
    for the wire/cache.
    """
    import numpy as np

    firsts = np.asarray(sorted(first_beats), dtype=int)
    # Balance the last block so a tiny trailing fragment cannot inherit metre.
    count = max(1, len(grid) // 24)
    blocks = np.array_split(np.arange(len(grid)), count)
    result = []
    for block, (subdivision, subdivision_confidence) in zip(blocks, subdivisions):
        first, stop = int(block[0]), int(block[-1]) + 1
        start = 0. if first == 0 else float(grid[first])
        end = float(grid[stop]) if stop < len(grid) else duration
        local_period = float(np.median(np.diff(grid[first:stop]))) if stop - first > 1 else period
        size, phase = _model_bars(firsts, first, stop)
        downbeats = grid[first + phase:stop:size].tolist() if size else []
        metre_confidence = first_confidence = 0.
        if size:
            observations = np.column_stack((novelty[first:stop], strength[first:stop]))
            measured, measured_phase, confidence, first_measure = grouping(observations)
            if measured == size and measured_phase == phase % size:
                metre_confidence, first_confidence = confidence, first_measure
        row = {
            'start': round(start, 4), 'end': round(end, 4),
            'period': round(local_period, 6), 'pulse_unit': 'dotted_quarter' if subdivision == 3 else 'quarter' if subdivision == 2 else None,
            'beats_per_bar': size, 'subdivision': subdivision,
            'bar_seconds': round(local_period * size, 6) if size else None,
            'pulse_confidence': round(pulse_confidence, 3),
            'metre_confidence': round(metre_confidence, 3),
            'downbeat_confidence': round(first_confidence, 3),
            'subdivision_confidence': round(subdivision_confidence, 3),
            'downbeats': [round(t, 4) for t in downbeats],
        }
        previous = result[-1] if result else None
        same = previous and all(previous[key] == row[key] for key in ('beats_per_bar', 'subdivision', 'pulse_unit'))
        if same and bool(previous['downbeats']) != bool(downbeats):
            same = False
        if same and bool(previous['downbeat_confidence']) != bool(row['downbeat_confidence']):
            same = False  # Confirmed and unconfirmed bars stay separate regions.
        if same and size and previous['downbeats'] and downbeats:
            expected = (downbeats[0] - previous['downbeats'][-1]) / (local_period * size)
            same = abs(expected - 1) <= .05
        if same and abs(previous['period'] / row['period'] - 1) <= .003:
            previous['end'] = row['end']
            previous['downbeats'].extend(row['downbeats'])
            for key in ('pulse_confidence', 'metre_confidence', 'downbeat_confidence', 'subdivision_confidence'):
                previous[key] = min(previous[key], row[key])
        else:
            result.append(row)
    return result


def _model_bars(firsts, first: int, stop: int):
    """(pulses per bar, phase in the block) if the model's bars are regular there.

    Every bar of known length that overlaps the block counts, including one
    that enters it from the previous block and the one that leaves it; the
    last first beat of a window starts a bar of unknown length. Mixed lengths
    give (None, None): no estimate rather than a guessed one.
    """
    inside = firsts[(firsts >= first) & (firsts < stop)]
    if inside.size == 0:
        return None, None
    starts = firsts[:-1]
    ends = firsts[1:]
    overlapping = (ends > first) & (starts < stop)
    lengths = set((ends - starts)[overlapping].tolist())
    if len(lengths) != 1:
        return None, None
    size = int(lengths.pop())
    if size < 2:
        return None, None
    return size, int(inside[0] - first)
