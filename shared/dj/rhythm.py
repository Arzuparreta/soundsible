"""Sample-accurate pulse grid and bar evidence of one PCM window; no I/O.

The beat model (`beat_model`, Beat This! + DBN) decides which pulse the music
has, its octave and phase, and where it puts each first beat. It works in
20 ms frames; this module turns its beats into a grid precise to the sample
(P1) and measures the independent evidence for bars that `metre` compares.
"""

from __future__ import annotations

import math
from .contracts import RhythmWindow
from .metre import metric_regions

# Rhythm ----------------------------------------------------------------------
#
# Two mixed songs share one clock, so a few milliseconds of disagreement
# between their grids is heard as a flam. One phase-consistent line (or local
# lines) runs through the model's beats, weighted by the attack at each, and
# the grid is last aligned to where the attacks start.

_RHYTHM_HOP = 128


_RHYTHM_FRAME = 1024


_RHYTHM_BANDS = 24


# Pre-emphasis makes the attack transient, rather than the slower bass body
# that follows it, the event a grid point marks.
_ATTACK_PREEMPHASIS = 0.95


_ATTACK_WINDOW = 0.035


_ATTACK_SMOOTHING = 0.002


# One straight grid fits a programmed song: for at least half of the window
# its locally fitted beats stay within 12 ms of the line and its local tempo
# within 0.3 % of the line's, and 55 % of the tracked beat weight sits on it.
# Mean rise of 2 ms level at the beats, in dB, below which nothing audibly
# pulses: 0.15 for a steady tone, at least 1.7 across 53 real songs.
_MIN_PULSE_DB = 1.0


_CONSTANT_WANDER = 0.012


_CONSTANT_DRIFT = 0.003


_CONSTANT_SHARE = 0.55


def _rhythm(samples, sample_rate: int, events) -> RhythmWindow | None:
    """Tempo, beat grid and bar evidence of one window, in window-relative seconds.

    `events` are the beat model's (beat times, first-beat times) for this
    window. Without them there is no pulse: nothing else guesses one.
    """
    import numpy as np

    if events is None:
        return None
    beats, firsts = (np.asarray(values, dtype=float) for values in events)
    if beats.size < 8:
        return None
    measured = _rhythm_stft(samples, sample_rate)
    if measured is None:
        return None
    onset, chroma, centre = measured
    times = beats
    weights = _attack_weights(onset, beats, sample_rate, centre)
    duration = samples.size / sample_rate

    # The model's beats are consecutive. Their least-squares slope averages
    # the 20 ms frame rounding that a median interval would keep (24/25
    # frames at 122 BPM is 2 % either side, the width of the phase search).
    index = np.arange(beats.size)
    period, phase, share = _phase_fit(times, weights, float(np.polyfit(index, beats, 1)[0]))
    numbers = _beat_numbers(times, period)
    fitted, slopes = _local_lines(numbers, times, weights)
    # A programmed song keeps its locally fitted beats within a few ms of one
    # line and its local tempo on the line's; a performance that drifts does
    # neither. The tempo test matters because a line allowed half-beat flips
    # is close to any beat half of the time.
    straight = phase + np.rint((fitted - phase) / (period / 2)) * (period / 2)
    wander = _weighted_quantile(np.abs(fitted - straight), weights, 0.5)
    known = np.isfinite(slopes)
    drift = _weighted_quantile(np.abs(slopes[known] / period - 1), weights[known], 0.5) if known.any() else 1.0
    constant = wander <= _CONSTANT_WANDER and drift <= _CONSTANT_DRIFT and share >= _CONSTANT_SHARE
    # The grid covers where the model heard beats, not the whole window: an
    # unpulsed intro or tail gets no invented continuation of the line.
    first, last = beats[0] - period / 2, beats[-1] + period / 2
    if constant:
        grid = phase + period * np.arange(math.ceil((first - phase) / period), math.floor((last - phase) / period) + 1)
        reliability = share
    else:
        grid = _local_grid(numbers, fitted, slopes, duration)
        grid = grid[(grid >= first) & (grid <= last)]
        near = np.abs(times - fitted) <= 0.03
        # A drifting grid is followed, not predicted: the mix holds one rate
        # for its whole overlap while the song keeps moving.
        reliability = 0.7 * float(weights[near].sum() / max(float(weights.sum()), 1e-12))
    if grid.size < 4:
        return None
    _, pulse = _mean_attack(samples, sample_rate, grid, _attack_floor(samples, 0.0), emphasis=0.0)
    if pulse < _MIN_PULSE_DB:
        # A sustained sound: the model followed rounding noise.
        return None
    # Each model first beat names the grid point it falls on; one it cannot
    # name within half a beat is dropped rather than moved.
    nearest = np.clip(np.searchsorted(grid, firsts), 1, grid.size - 1) if firsts.size else np.array([], dtype=int)
    if firsts.size:
        nearest = np.where(np.abs(grid[nearest - 1] - firsts) <= np.abs(grid[nearest] - firsts), nearest - 1, nearest)
        nearest = nearest[np.abs(grid[nearest] - firsts) <= period / 2]
    grid = _align_attacks(samples, sample_rate, grid, _attack_floor(samples, _ATTACK_PREEMPHASIS), constant=constant)
    inside = (grid >= 0) & (grid <= duration)
    index = np.cumsum(inside) - 1
    first_beats = np.unique(index[nearest[inside[nearest]]]) if nearest.size else np.array([], dtype=int)
    grid = grid[inside]
    if grid.size < 4:
        return None
    beat = period if constant else float(np.median(np.diff(grid)))
    pulse_confidence = float(np.clip((reliability - 0.4) / 0.5, 0.0, 1.0))
    novelty, strength = _bar_observations(samples, sample_rate, grid, chroma, centre)
    blocks = np.array_split(np.arange(len(grid)), max(1, len(grid) // 24))
    subdivisions = [_subdivision(onset, sample_rate, grid[block], centre) for block in blocks]
    regions = metric_regions(grid, novelty, strength, duration=duration, period=beat,
                             pulse_confidence=pulse_confidence, subdivisions=subdivisions,
                             first_beats=first_beats.tolist())
    return {
        "bpm": 60.0 / beat,
        "period": beat,
        "beats": grid.tolist(),
        "metric_regions": regions,
        "tempo_confidence": pulse_confidence,
        "grid": "constant" if constant else "local",
    }


def _attack_weights(onset, beats, sample_rate: int, centre: float):
    """Onset strength at each model beat (largest within one 11.6 ms frame).

    Beats the network carries through a break, with nothing attacking there,
    weigh nothing in the fitted line.
    """
    import numpy as np

    frames = np.rint((beats * sample_rate - centre) / _RHYTHM_HOP).astype(int)
    span = np.clip(frames[:, None] + np.arange(-1, 2)[None, :], 0, onset.size - 1)
    return np.maximum(onset[span].max(axis=1), 0.0)


def _rhythm_stft(samples, sample_rate: int):
    """Onset strength and chroma from one bounded float32 STFT pass.

    `onset[k]` is the mean rise of log energy in 24 log-spaced bands into frame
    `k`; every band counts alike, so a quiet hi-hat and a loud bass note mark
    time equally. Returns onset, chroma and the frame-centre offset.
    """
    import numpy as np

    signal = np.ascontiguousarray(samples, dtype=np.float32)
    count = 1 + (signal.size - _RHYTHM_FRAME) // _RHYTHM_HOP
    if count < 16:
        return None
    frames = np.lib.stride_tricks.as_strided(
        signal,
        shape=(count, _RHYTHM_FRAME),
        strides=(signal.strides[0] * _RHYTHM_HOP, signal.strides[0]),
        writeable=False,
    )
    frequencies = np.fft.rfftfreq(_RHYTHM_FRAME, 1 / sample_rate)
    edges = np.geomspace(30.0, min(5000.0, sample_rate * 0.475), _RHYTHM_BANDS + 1)
    # Bands are contiguous runs of bins; pitch classes become contiguous once
    # the tonal bins are ordered by class. `reduceat` sums both runs without a
    # matrix product, whose BLAS thread team would compete with the station.
    band_starts = np.searchsorted(frequencies, edges)
    band_sizes = np.diff(band_starts).astype(np.float32)
    # A band narrower than one bin contributes nothing rather than its neighbour.
    band_scale = np.where(band_sizes > 0, 1.0 / np.maximum(band_sizes, 1.0), 0.0).astype(np.float32)
    tonal = np.flatnonzero((frequencies >= 100) & (frequencies <= 2000))
    pitch = np.mod(np.rint(69 + 12 * np.log2(frequencies[tonal] / 440)).astype(int), 12)
    tonal = tonal[np.argsort(pitch, kind="stable")]
    pitch_starts = np.searchsorted(np.sort(pitch), np.arange(12))
    window = np.hanning(_RHYTHM_FRAME).astype(np.float32)
    bands = np.empty((count, _RHYTHM_BANDS), dtype=np.float32)
    chroma = np.empty((count, 12), dtype=np.float32)
    # Bounded scratch space, as in `_spectral_features`.
    for start in range(0, count, 256):
        block = frames[start:start + 256] * window
        magnitude = np.abs(np.fft.rfft(block, axis=1))
        stop = start + len(block)
        bands[start:stop] = np.add.reduceat(magnitude[:, : band_starts[-1]], band_starts[:-1], axis=1) * band_scale
        chroma[start:stop] = np.add.reduceat(magnitude[:, tonal], pitch_starts, axis=1)
    reference = max(float(np.percentile(bands, 99.5)), 1e-9)
    rise = np.maximum(0.0, np.diff(np.log1p(bands * np.float32(1000.0 / reference)), axis=0))
    onset = np.concatenate([[0.0], rise.mean(axis=1, dtype=np.float64)])
    return onset, chroma, _RHYTHM_FRAME / 2


def _peak_positions(values, frames):
    """Fractional frame of each peak by parabolic interpolation."""
    import numpy as np

    left = values[np.maximum(frames - 1, 0)]
    centre = values[frames]
    right = values[np.minimum(frames + 1, values.size - 1)]
    curvature = left - 2 * centre + right
    shift = np.where(curvature < 0, 0.5 * (left - right) / np.where(curvature < 0, curvature, -1.0), 0.0)
    return frames + np.clip(shift, -0.5, 0.5)


def _phase_fit(times, weights, period: float, *, span: float = 0.02, inlier: float = 0.03):
    """One straight grid through beat times: (period, phase, share of weight on it).

    The period with the strongest phase agreement starts the search; least
    squares over the beats that agree then refines it far below one step.
    """
    import numpy as np

    total = max(float(weights.sum()), 1e-12)
    candidates = period * (1 + np.linspace(-span, span, 401))
    rotations = (np.exp(2j * np.pi * times[None, :] / candidates[:, None]) * weights).sum(axis=1)
    best = int(np.argmax(np.abs(rotations)))
    period = float(candidates[best])
    phase = float(np.angle(rotations[best]) / (2 * np.pi) * period)
    for _ in range(3):
        numbers = np.rint((times - phase) / period)
        agree = np.abs(times - (phase + numbers * period)) <= inlier
        if agree.sum() < 8:
            break
        w = weights[agree]
        x = numbers[agree]
        y = times[agree]
        mean_x = np.average(x, weights=w)
        mean_y = np.average(y, weights=w)
        variance = np.average((x - mean_x) ** 2, weights=w)
        if variance <= 0:
            break
        period = float(np.average((x - mean_x) * (y - mean_y), weights=w) / variance)
        phase = float(mean_y - period * mean_x) % period
    numbers = np.rint((times - phase) / period)
    agree = np.abs(times - (phase + numbers * period)) <= inlier
    return period, phase, float(weights[agree].sum() / total)


def _beat_numbers(times, period: float):
    """Integer beat numbers, tolerating an occasional skipped beat."""
    import numpy as np

    steps = np.maximum(1, np.rint(np.diff(times) / period)).astype(int)
    return np.concatenate([[0], np.cumsum(steps)])


def _local_lines(numbers, times, weights, *, half_width: int = 8):
    """Robust locally weighted lines through beat times, in beat numbers.

    Returns the fitted time and the local period (seconds per beat) of every
    beat; NaN where too few beats support a line.
    """
    import numpy as np

    count = times.size
    robust = np.ones(count)
    fitted = times.astype(float).copy()
    slopes = np.full(count, np.nan)
    lo = np.searchsorted(numbers, numbers - half_width)
    hi = np.searchsorted(numbers, numbers + half_width, side="right")
    columns = lo[:, None] + np.arange(int((hi - lo).max()))[None, :]
    inside = columns < hi[:, None]
    columns = np.minimum(columns, count - 1)
    x = numbers[columns].astype(float)
    y = times[columns]
    distance = np.abs(x - numbers[:, None]) / (half_width + 1)
    tricube = np.where(inside, (1 - distance ** 3) ** 3, 0.0)
    for _ in range(3):
        w = tricube * (weights * robust)[columns]
        total = w.sum(axis=1)
        safe = np.where(total > 0, total, 1.0)
        mean_x = (w * x).sum(axis=1) / safe
        mean_y = (w * y).sum(axis=1) / safe
        variance = (w * (x - mean_x[:, None]) ** 2).sum(axis=1)
        covariance = (w * (x - mean_x[:, None]) * (y - mean_y[:, None])).sum(axis=1)
        slopes = np.where((total > 0) & (variance > 0), covariance / np.where(variance > 0, variance, 1.0), np.nan)
        fitted = np.where(np.isfinite(slopes), mean_y + slopes * (numbers - mean_x), times)
        residual = times - fitted
        scale = max(0.002, 1.4826 * _weighted_quantile(np.abs(residual), weights, 0.5))
        u = residual / (4.685 * scale)
        robust = np.where(np.abs(u) < 1, (1 - u ** 2) ** 2, 0.0)
    return fitted, slopes


def _weighted_quantile(values, weights, quantile: float) -> float:
    import numpy as np

    order = np.argsort(values)
    cumulative = np.cumsum(weights[order])
    if cumulative.size == 0 or cumulative[-1] <= 0:
        return float("inf")
    return float(values[order][min(order.size - 1, int(np.searchsorted(cumulative, quantile * cumulative[-1])))])


def _local_grid(numbers, fitted, slopes, duration: float):
    """One point per beat number, extended to the window edges at the end tempi."""
    import numpy as np

    known = np.isfinite(slopes)
    if known.sum() < 2:
        return np.array([])
    grid = np.interp(np.arange(numbers[0], numbers[-1] + 1), numbers[known], fitted[known])
    first = float(np.nanmedian(slopes[known][:8]))
    last = float(np.nanmedian(slopes[known][-8:]))
    before = grid[0] - first * np.arange(int(grid[0] / first), 0, -1) if first > 0 else np.array([])
    after = grid[-1] + last * np.arange(1, int(max(0.0, duration - grid[-1]) / last) + 1) if last > 0 else np.array([])
    return np.concatenate([before, grid, after])


def _attack_floor(samples, emphasis: float) -> float:
    """Power below which a rise in level is noise: 50 dB under the loud passages.

    Measured over 1024-sample blocks, a quarter of a million samples at a time,
    so no full-length copy of the window is ever made.
    """
    import numpy as np

    blocks = (samples.size - 1) // 1024
    if blocks <= 0:
        return 1e-12
    power = np.empty(blocks)
    for first in range(0, blocks, 256):
        last = min(blocks, first + 256)
        signal = _emphasised(samples, first * 1024 + 1, last * 1024 + 1, emphasis)
        power[first:last] = np.square(signal).reshape(last - first, 1024).mean(axis=1)
    return max(float(np.percentile(power, 99)), 1e-12) * 1e-5


def _emphasised(samples, start: int, stop: int, emphasis: float):
    """samples[start:stop] in float64, pre-emphasised; needs start >= 1."""
    import numpy as np

    signal = np.asarray(samples[start:stop], dtype=np.float64)
    if emphasis:
        signal = signal - emphasis * np.asarray(samples[start - 1:stop - 1], dtype=np.float64)
    return signal


def _attack_curves(samples, sample_rate: int, times, floor: float, *, emphasis: float,
                   window: float = _ATTACK_WINDOW):
    """Rise of 2 ms log energy across each sample boundary near each time.

    Returns (offsets in seconds, one float32 row per usable time, which times
    were usable).
    """
    import numpy as np

    n = max(1, int(round(_ATTACK_SMOOTHING * sample_rate)))
    half = int(round(window * sample_rate))
    span = np.arange(-half - n, half + 2 * n)
    centres = np.rint(np.asarray(times) * sample_rate).astype(int)
    usable = (centres + span[0] >= 1) & (centres + span[-1] < samples.size)
    # Column j of the smoothed level averages span[j:j + n]; the boundary
    # between the window ending at b and the one starting there is span index b.
    boundaries = span[n: span.size - n + 1]
    keep = np.abs(boundaries) <= half
    rows = np.zeros((int(usable.sum()), int(keep.sum())), dtype=np.float32)
    selected = centres[usable]
    signal = np.asarray(samples, dtype=np.float32)
    for first in range(0, selected.size, 256):
        index = selected[first:first + 256, None] + span[None, :]
        segment = signal[index].astype(np.float64)
        if emphasis:
            segment -= emphasis * signal[index - 1]
        cumulative = np.concatenate([np.zeros((segment.shape[0], 1)), np.cumsum(segment * segment, axis=1)], axis=1)
        level = 10 * np.log10((cumulative[:, n:] - cumulative[:, :-n]) / n + floor)
        rows[first:first + 256] = np.maximum(0.0, level[:, n:] - level[:, :-n])[:, keep]
    return boundaries[keep] / sample_rate, rows, usable


def _mean_attack(samples, sample_rate: int, times, floor: float, *, emphasis: float) -> tuple[float, float]:
    """(offset, height) of the strongest mean attack around the given times."""
    import numpy as np

    offsets, rows, _ = _attack_curves(samples, sample_rate, times, floor, emphasis=emphasis)
    if rows.shape[0] < 4:
        return 0.0, 0.0
    curve = rows.mean(axis=0, dtype=np.float64)
    best = int(np.argmax(curve))
    return float(offsets[best]), float(curve[best])


def _align_attacks(samples, sample_rate: int, grid, floor: float, *, constant: bool):
    """Shift grid points onto where the attacks around them start.

    The tracker's beats sit at an analysis-frame convention whose distance from
    the attack depends on the sound. The mean attack over many beats — the
    whole window for one straight grid, a 33-beat neighbourhood for a drifting
    one — fixes that to well under a millisecond on a clear pulse.
    """
    import numpy as np

    offsets, rows, usable = _attack_curves(samples, sample_rate, grid, floor, emphasis=_ATTACK_PREEMPHASIS)
    if rows.shape[0] < 4:
        return grid
    if constant:
        curve = rows.mean(axis=0, dtype=np.float64)
        shift = float(offsets[int(np.argmax(curve))])
        return _attack_line(grid, offsets, rows, usable, shift)
    count = rows.shape[0]
    cumulative = np.concatenate([np.zeros((1, rows.shape[1])), np.cumsum(rows, axis=0, dtype=np.float64)])
    lo = np.clip(np.arange(count) - 16, 0, count)
    hi = np.clip(np.arange(count) + 17, 0, count)
    local = (cumulative[hi] - cumulative[lo]) / (hi - lo)[:, None]
    shift = offsets[np.argmax(local, axis=1)]
    return grid + np.interp(np.arange(grid.size), np.flatnonzero(usable), shift)


# Half of the shortest ripple period of a kick's body (about 160 Hz): each
# beat's own attack is read this close to the mean one, never on a
# neighbouring cycle of the same drum.
_ATTACK_REFINE = 0.0015


def _attack_line(grid, offsets, rows, usable, shift: float):
    """A straight grid through each beat's attack near the mean attack.

    The mean attack over all beats fixes the phase robustly; each beat's own
    attack, searched within ±1.5 ms of it, then fixes the period to the
    sample. Falls back to the mean shift alone when too few beats attack.
    """
    import numpy as np

    near = np.flatnonzero(np.abs(offsets - shift) <= _ATTACK_REFINE)
    local = rows[:, near]
    best = np.argmax(local, axis=1)
    heights = local[np.arange(local.shape[0]), best].astype(np.float64)
    index = np.flatnonzero(usable).astype(np.float64)
    positions = grid[usable] + offsets[near][best]
    if heights.sum() <= 0 or np.count_nonzero(heights > 0) < 8 or np.ptp(index) <= 0:
        return grid + shift
    mean_x = np.average(index, weights=heights)
    mean_y = np.average(positions, weights=heights)
    variance = np.average((index - mean_x) ** 2, weights=heights)
    slope = np.average((index - mean_x) * (positions - mean_y), weights=heights) / variance
    return mean_y + slope * (np.arange(grid.size) - mean_x)


def _bar_observations(samples, sample_rate: int, grid, chroma, centre: float):
    """Harmonic change across one pulse and attack rise (dB), separately."""
    import numpy as np

    _, rows, usable = _attack_curves(
        samples, sample_rate, grid, _attack_floor(samples, 0.0), emphasis=0.0, window=0.015,
    )
    strength = np.zeros(grid.size)
    if rows.size:
        strength[usable] = rows.max(axis=1)
    frames = np.clip(np.rint((grid * sample_rate - centre) / _RHYTHM_HOP).astype(int), 0, chroma.shape[0] - 1)
    cumulative = np.vstack([np.zeros((1, 12)), np.cumsum(chroma, axis=0, dtype=np.float64)])
    slices = cumulative[frames[1:]] - cumulative[frames[:-1]]
    norms = np.linalg.norm(slices, axis=1)
    normalized = slices / np.maximum(norms[:, None], 1e-12)
    novelty = np.zeros(grid.size)
    novelty[1:-1] = np.maximum(0., 1 - (normalized[:-1] * normalized[1:]).sum(axis=1))
    return novelty, strength


def _subdivision(onset, sample_rate: int, grid, centre):
    """Compare spectral attacks at halves and at both thirds of a pulse.

    Three standard errors separate hypotheses; no tempo-octave folding can
    turn a binary subdivision into a ternary one. Unknown includes mixtures.
    Notated pulse units are a convention, since audio cannot prove a denominator.
    """
    import numpy as np

    intervals = grid[1:] - grid[:-1]
    values = []
    for fraction in (.5, 1 / 3, 2 / 3):
        frames = np.rint(((grid[:-1] + fraction * intervals) * sample_rate - centre) / _RHYTHM_HOP).astype(int)
        positions = np.clip(frames[:, None] + np.arange(-2, 3), 0, len(onset) - 1)
        values.append(onset[positions].max(axis=1))
    means = np.array([float(np.mean(row)) for row in values])
    uncertainty = 3 * max(float(np.std(row)) / len(row) ** .5 for row in values)
    binary, first, second = means
    first_frame = max(0, int((grid[0] * sample_rate - centre) / _RHYTHM_HOP))
    last_frame = min(len(onset), int((grid[-1] * sample_rate - centre) / _RHYTHM_HOP) + 1)
    background = onset[first_frame:last_frame]
    baseline = float(np.mean(background))
    uncertainty += 3 * float(np.std(background)) / max(1, len(background)) ** .5
    binary_present = binary > baseline + uncertainty
    ternary_present = min(first, second) > baseline + uncertainty
    if ternary_present and not binary_present:
        return 3, min(1., (min(first, second) - baseline - uncertainty) / max(min(first, second), 1e-12))
    if binary_present and not ternary_present:
        return 2, min(1., (binary - baseline - uncertainty) / max(binary, 1e-12))
    return None, 0.
