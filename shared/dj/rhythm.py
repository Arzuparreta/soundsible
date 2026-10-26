"""Measured pulse and downbeat phase of one PCM window; no I/O."""

from __future__ import annotations

import math
from .contracts import RhythmWindow
from .metre import metric_regions

# Rhythm ----------------------------------------------------------------------
#
# Two mixed songs share one clock, so a few milliseconds of disagreement
# between their grids is heard as a flam. Tempo and beats therefore come from
# a finer pass than the spectral features above: 11.6 ms steps instead of
# 46 ms, one phase-consistent fit across the window instead of beats snapped to
# whole frames, and a last alignment of the grid to where attacks start.

_RHYTHM_HOP = 128


_RHYTHM_FRAME = 1024


_RHYTHM_BANDS = 24


_TEMPO_RANGE = (60.0, 200.0)


# Cost of a beat-to-beat step away from the tempo (Ellis 2007, "tightness").
_TRACKER_TIGHTNESS = 100.0


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


def _rhythm(samples, sample_rate: int) -> RhythmWindow | None:
    """Tempo, beat grid and bar phase of one window, in window-relative seconds."""
    import numpy as np

    measured = _rhythm_stft(samples, sample_rate)
    if measured is None:
        return None
    onset, chroma, centre, pulse_onset = measured
    frame_rate = sample_rate / _RHYTHM_HOP
    lag = _tempo_lag(pulse_onset, frame_rate)
    if lag is None:
        return None
    lag = _pulse_lag(pulse_onset, lag, frame_rate)
    frames = _track_beats(onset, lag)
    if frames.size < 8:
        return None
    times = (_peak_positions(onset, frames) * _RHYTHM_HOP + centre) / sample_rate
    weights = np.maximum(onset[frames], 0.0)
    duration = samples.size / sample_rate

    period, phase, share = _phase_fit(times, weights, lag / frame_rate)
    # The tracker can follow the off-beat for a section and the beat for the
    # rest; both lie on one constant grid of half the period.
    half_period, half_phase, half_share = _phase_fit(times, weights, lag / frame_rate / 2)
    if half_share > share + 0.15:
        period, phase, share = 2 * half_period, half_phase, half_share
    numbers = _beat_numbers(times, period)
    fitted, slopes = _local_lines(numbers, times, weights)
    # A programmed song keeps its locally fitted beats within a few ms of one
    # line (the tracker's own section-dependent bias) and its local tempo on
    # the line's; a performance that drifts does neither. The tempo test
    # matters because a line allowed half-beat flips is close to any beat
    # half of the time.
    straight = phase + np.rint((fitted - phase) / (period / 2)) * (period / 2)
    wander = _weighted_quantile(np.abs(fitted - straight), weights, 0.5)
    known = np.isfinite(slopes)
    drift = _weighted_quantile(np.abs(slopes[known] / period - 1), weights[known], 0.5) if known.any() else 1.0
    constant = wander <= _CONSTANT_WANDER and drift <= _CONSTANT_DRIFT and share >= _CONSTANT_SHARE
    if constant:
        grid = phase + period * np.arange(math.ceil(-phase / period), math.floor((duration - phase) / period) + 1)
        reliability = share
    else:
        grid = _local_grid(numbers, fitted, slopes, duration)
        near = np.abs(times - fitted) <= 0.03
        # A drifting grid is followed, not predicted: the mix holds one rate
        # for its whole overlap while the song keeps moving.
        reliability = 0.7 * float(weights[near].sum() / max(float(weights.sum()), 1e-12))
    if grid.size < 4:
        return None

    grid, pulse = _settle_beat_phase(samples, sample_rate, grid)
    if pulse < _MIN_PULSE_DB:
        # A sustained sound: the tracker found only rounding noise to follow.
        return None
    grid = _align_attacks(samples, sample_rate, grid, _attack_floor(samples, _ATTACK_PREEMPHASIS), constant=constant)
    grid = grid[(grid >= 0) & (grid <= duration)]
    if grid.size < 4:
        return None
    beat = period if constant else float(np.median(np.diff(grid)))
    pulse_confidence = float(np.clip((reliability - 0.4) / 0.5, 0.0, 1.0))
    novelty, strength = _bar_observations(samples, sample_rate, grid, chroma, centre)
    blocks = np.array_split(np.arange(len(grid)), max(1, len(grid) // 24))
    subdivisions = [_subdivision(onset, sample_rate, grid[block], centre) for block in blocks]
    regions = metric_regions(grid, novelty, strength, duration=duration, period=beat,
                             pulse_confidence=pulse_confidence, subdivisions=subdivisions)
    return {
        "bpm": 60.0 / beat,
        "period": beat,
        "beats": grid.tolist(),
        "metric_regions": regions,
        "tempo_confidence": pulse_confidence,
        "grid": "constant" if constant else "local",
    }


def _rhythm_stft(samples, sample_rate: int):
    """Onset strength and chroma from one bounded float32 STFT pass.

    `onset[k]` is the mean rise of log energy in 24 log-spaced bands into frame
    `k`; every band counts alike, so a quiet hi-hat and a loud bass note mark
    time equally. Returns onset, chroma, frame-centre offset and low-band onset.
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
    # Resolve the pulse octave before grouping. Low-band transients separate
    # a bass/kick pulse from hi-hat subdivisions; use all bands for tracking.
    # No preference for a 120 BPM octave or a binary bar is applied.
    low = max(1, int(np.searchsorted(edges[1:], 180.)))
    pulse_onset = np.concatenate([[0.], rise[:, :low].mean(axis=1, dtype=np.float64)])
    return onset, chroma, _RHYTHM_FRAME / 2, pulse_onset


def _tempo_lag(onset, frame_rate: float) -> float | None:
    """Beat period in (fractional) frames from the onset autocorrelation."""
    import numpy as np

    width = max(1, int(frame_rate * 1.5))
    envelope = np.maximum(0.0, onset - np.convolve(onset, np.ones(width) / width, mode="same"))
    envelope -= envelope.mean()
    size = 1 << int(math.ceil(math.log2(2 * envelope.size)))
    spectrum = np.fft.rfft(envelope, size)
    acf = np.fft.irfft(spectrum * np.conj(spectrum), size)[: envelope.size]
    if acf[0] <= 1e-12:
        return None
    acf /= acf[0]
    low, high = _TEMPO_RANGE
    lags = np.arange(int(60 * frame_rate / high), int(math.ceil(60 * frame_rate / low)) + 1)
    lags = lags[(lags > 0) & (lags * 4 < acf.size)]
    if lags.size < 3:
        return None
    # Test both binary and ternary repetitions without preferring a bar size.
    # Integer multiples miss narrow peaks: allow three frames of resolution.
    reach = np.lib.stride_tricks.sliding_window_view(np.pad(acf, 3, constant_values=-1.0), 7).max(axis=1)
    score = sum(reach[multiple * lags] / multiple for multiple in (1, 2, 3, 4))
    best = int(np.argmax(score))
    lag = float(lags[best])
    if 0 < best < lags.size - 1:
        left, centre, right = score[best - 1], score[best], score[best + 1]
        curvature = left - 2 * centre + right
        if curvature < 0:
            lag += 0.5 * (left - right) / curvature
    return lag


def _pulse_lag(onset, proposed: float, frame_rate: float) -> float:
    """Resolve pulse and subdivision hypotheses by low-band onset coverage.

    Phase-consistent onset mass divided by sqrt(number of grid points) is the
    normalized projection onto a pulse train. A half-time grid misses attacks;
    a subdivision grid adds empty points. Equal binary/ternary hypotheses are
    tested, without treating a ternary pulse as half/double tempo.
    """
    import numpy as np

    peaks = np.flatnonzero((onset[1:-1] > onset[:-2]) & (onset[1:-1] >= onset[2:])) + 1
    if len(peaks) < 8:
        return proposed
    times = _peak_positions(onset, peaks) / frame_rate
    weights = np.maximum(onset[peaks], 0.)
    candidates = []
    for factor in (1., .5, 2., 2 / 3, 3 / 2):
        period = proposed * factor / frame_rate
        if not 60 / _TEMPO_RANGE[1] <= period <= 60 / _TEMPO_RANGE[0]:
            continue
        supports, periods = [], []
        for start in np.arange(0., times[-1], 12.):
            inside = (times >= start) & (times < start + 12.)
            if inside.sum() < 8:
                continue
            fitted, _, share = _phase_fit(times[inside] - start, weights[inside], period)
            supports.append(share * math.sqrt(fitted))
            periods.append(fitted)
        if supports:
            candidates.append((float(np.median(supports)), float(np.median(periods))))
    return max(candidates)[1] * frame_rate if candidates else proposed


def _track_beats(onset, period: float):
    """Ellis dynamic-programming beat tracker, in vectorised blocks.

    A beat can only follow one at least `shortest` frames earlier, so every
    block of `shortest` frames depends only on frames before it.
    """
    import numpy as np

    spread = float(np.std(onset))
    if onset.size < 4 or spread <= 0 or period < 2:
        return np.array([], dtype=int)
    reach = int(round(period))
    offsets = np.arange(-reach, reach + 1)
    local = np.convolve(onset / spread, np.exp(-0.5 * (offsets * 32.0 / period) ** 2), mode="same")
    shortest = max(1, int(period * 0.7))
    lags = np.arange(shortest, max(shortest + 1, int(math.ceil(period * 1.4))) + 1)
    penalty = -_TRACKER_TIGHTNESS * np.log(lags / period) ** 2
    score = local.copy()
    previous = np.full(onset.size, -1, dtype=np.int64)
    for start in range(shortest, onset.size, shortest):
        index = np.arange(start, min(onset.size, start + shortest))
        candidates = index[:, None] - lags[None, :]
        options = np.where(candidates >= 0, score[np.maximum(candidates, 0)] + penalty, -np.inf)
        best = np.argmax(options, axis=1)
        gain = options[np.arange(index.size), best]
        linked = np.isfinite(gain) & (gain > 0)
        score[index] = local[index] + np.where(linked, gain, 0.0)
        previous[index] = np.where(linked, candidates[np.arange(index.size), best], -1)
    peaks = np.flatnonzero((score[1:-1] >= score[:-2]) & (score[1:-1] > score[2:])) + 1
    if peaks.size == 0:
        return np.array([], dtype=int)
    strong = peaks[score[peaks] >= 0.5 * float(np.median(score[peaks]))]
    beats = [int(strong[-1] if strong.size else peaks[-1])]
    while previous[beats[-1]] >= 0:
        beats.append(int(previous[beats[-1]]))
    beats = np.array(beats[::-1], dtype=int)
    # Leading and trailing beats the tracker merely coasted through.
    strength = local[beats]
    kept = np.flatnonzero(strength >= 0.5 * math.sqrt(float(np.mean(strength ** 2))))
    return beats[kept[0]: kept[-1] + 1] if kept.size else beats


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


def _halfway(grid):
    import numpy as np

    return np.concatenate([[grid[0] - (grid[1] - grid[0]) / 2], (grid[:-1] + grid[1:]) / 2])


def _settle_beat_phase(samples, sample_rate: int, grid):
    """Move the grid to the half beat when the attacks clearly live there.

    Returns the grid and the mean attack height (dB) at its points.

    The tracker locks onto the stronger of beat and off-beat in its own onset
    measure, where an off-beat hi-hat or bass note counts as much as a kick
    drum. The jump in overall level separates them: it belongs to the kick.
    Without pre-emphasis, which would hand the decision back to the hi-hat.
    """
    floor = _attack_floor(samples, 0.0)
    shifted = _halfway(grid)
    _, on_beat = _mean_attack(samples, sample_rate, grid, floor, emphasis=0.0)
    _, off_beat = _mean_attack(samples, sample_rate, shifted, floor, emphasis=0.0)
    return (shifted, off_beat) if off_beat > 1.1 * on_beat else (grid, on_beat)


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
        return grid + float(offsets[int(np.argmax(curve))])
    count = rows.shape[0]
    cumulative = np.concatenate([np.zeros((1, rows.shape[1])), np.cumsum(rows, axis=0, dtype=np.float64)])
    lo = np.clip(np.arange(count) - 16, 0, count)
    hi = np.clip(np.arange(count) + 17, 0, count)
    local = (cumulative[hi] - cumulative[lo]) / (hi - lo)[:, None]
    shift = offsets[np.argmax(local, axis=1)]
    return grid + np.interp(np.arange(grid.size), np.flatnonzero(usable), shift)


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
