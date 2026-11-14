"""Bounded joint pulse/grouping prototype; no learned or taste weights.

Compare cyclic Gaussian observation models on the SAME frame observations,
using held-out cycles and BIC complexity. No production integration. Statistical
evidence is not a calibrated probability of a musical interpretation.
"""
from __future__ import annotations

import importlib
import math

import numpy as np

from .common import result


def infer(samples, rate, package):
    rhythm = importlib.import_module(package+'.rhythm')
    metre = importlib.import_module(package+'.metre')
    measured = rhythm._rhythm_stft(samples, rate)
    duration = len(samples)/rate
    if measured is None or np.max(np.abs(samples)) < 1e-6:
        return result([], duration=duration, hypothesis_count=0)
    onset, chroma, centre, low = measured
    fps = rate/rhythm._RHYTHM_HOP
    centred = low-low.mean()
    from scipy.signal import fftconvolve, find_peaks
    corr = fftconvolve(centred, centred[::-1], mode='full')[len(low)-1:]
    peaks, _ = find_peaks(corr)
    peaks = peaks[(peaks >= .25*fps) & (peaks <= 1.5*fps)]
    peaks = sorted(peaks, key=lambda i: corr[i], reverse=True)[:6]
    candidates = sorted(set(round(float(p)*ratio, 3) for p in peaks for ratio in [1., .5, 2., 2/3, 1.5]
                            if .25*fps <= p*ratio <= 1.5*fps))
    normed = chroma/np.maximum(np.linalg.norm(chroma, axis=1)[:, None], 1e-12)
    harmony = np.maximum(0., 1-(normed*np.roll(normed, max(1, round(.1*fps)), axis=0)).sum(axis=1))
    observations = np.column_stack([onset, low, harmony])
    variable = observations.std(axis=0) > 1e-8
    observations = observations[:, variable]
    if not observations.shape[1]:
        return result([], duration=duration, hypothesis_count=0)
    observations = (observations-observations.mean(axis=0))/observations.std(axis=0)
    frame_times = (np.arange(len(onset))*rhythm._RHYTHM_HOP+centre)/rate
    tested = []
    for lag in candidates:
        frames = rhythm._track_beats(onset, lag)
        if len(frames) < 8:
            continue
        times = (rhythm._peak_positions(onset, frames)*rhythm._RHYTHM_HOP+centre)/rate
        period, phase, share = rhythm._phase_fit(times, np.maximum(onset[frames], 0.), lag/fps)
        if period <= 0:
            continue
        for size in [2, 3, 4, 6]:
            # Six bins per pulse resolve halves and thirds without first
            # choosing binary/ternary subdivision. Cross-validate whole bars.
            cycle = np.floor((frame_times-phase)/(period*size)).astype(int)
            if len(set(cycle)) < 4:
                continue
            bins = np.floor(np.mod((frame_times-phase)/period, size)*6).astype(int)
            prediction = np.zeros_like(observations)
            valid = np.zeros(len(bins), dtype=bool)
            for parity in [0, 1]:
                train = cycle % 2 == parity
                test = ~train
                counts = np.bincount(bins[train], minlength=size*6)
                means = np.zeros((size*6, observations.shape[1]))
                for column in range(observations.shape[1]):
                    means[:, column] = np.bincount(bins[train], weights=observations[train, column], minlength=size*6)/np.maximum(counts, 1)
                prediction[test] = means[bins[test]]
                valid[test] = counts[bins[test]] > 0
            errors = (observations[valid]-prediction[valid])**2
            if not len(errors):
                continue
            variance = np.maximum(errors.mean(axis=0), 1e-12)
            n = len(errors)
            bic = float(n*np.log(variance).sum()+size*6*observations.shape[1]*math.log(n))
            tested.append((bic, period, phase, size, share))
    if not tested:
        return result([], duration=duration, hypothesis_count=0)
    bic, period, phase, size, share = min(tested)
    grid = phase+period*np.arange(math.ceil(-phase/period), math.floor((duration-phase)/period)+1)
    grid, pulse = rhythm._settle_beat_phase(samples, rate, grid)
    if pulse < rhythm._MIN_PULSE_DB:
        return result([], duration=duration, hypothesis_count=len(tested))
    grid = rhythm._align_attacks(samples, rate, grid, rhythm._attack_floor(samples, rhythm._ATTACK_PREEMPHASIS), constant=True)
    grid = grid[(grid >= 0) & (grid < duration)]
    novelty, strength = rhythm._bar_observations(samples, rate, grid, chroma, centre)
    blocks = np.array_split(np.arange(len(grid)), max(1, len(grid)//24))
    subdivisions = [rhythm._subdivision(onset, rate, grid[b], centre) for b in blocks]
    regions = metre.metric_regions(grid, novelty, strength, duration=duration, period=period,
                                    pulse_confidence=float(np.clip((share-.4)/.5, 0, 1)), subdivisions=subdivisions)
    return result(grid, [t for r in regions for t in r['downbeats']], duration=duration, regions=regions,
                  hypothesis_count=len(tested), selected_bic=bic, joint_grouping_hypothesis=size)


def infer_dbn(samples, rate, package):
    """Joint temporal decoding of non-neural rhythmic/harmonic observations.

    Empirical ranks define dimensionless emission indices, not calibrated
    probabilities. The decoder jointly explores pulse tempo, 2/3/4/6 grouping
    and bar phase. No preferred BPM is selected before it. No tuned weights.
    """
    from scipy.stats import rankdata
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor
    rhythm = importlib.import_module(package+'.rhythm')
    measured = rhythm._rhythm_stft(samples, rate)
    duration = len(samples)/rate
    if measured is None or np.max(abs(samples)) < 1e-6:
        return result([], duration=duration)
    onset, chroma, centre, low = measured
    normed = chroma/np.maximum(np.linalg.norm(chroma, axis=1)[:, None], 1e-12)
    novelty = np.maximum(0., 1-(normed[1:]*normed[:-1]).sum(axis=1))
    novelty = np.r_[0., novelty]
    # Flat features produce zero evidence, not a 0.5 probability from ties.
    def rank(values):
        return (rankdata(values, method='min')-1)/max(len(values)-1, 1)
    pulse = rank(onset)
    first = pulse*rank(novelty)
    activation = np.column_stack([pulse-first, first])
    activation = np.clip(activation, 1e-8, 1-1e-8)
    decoder = DBNDownBeatTrackingProcessor(beats_per_bar=[2, 3, 4, 6], fps=rate/rhythm._RHYTHM_HOP, num_threads=1)
    points = decoder(activation)
    beats = points[:, 0]+centre/rate
    bars = points[points[:, 1] == 1, 0]+centre/rate
    beats, bars = beats[beats <= duration], bars[bars <= duration]
    return result(beats, bars, duration=duration, activations=activation,
                  activation_kind=f'empirical_rank_indices_{rate/rhythm._RHYTHM_HOP}fps',
                  confidence_interpretation='uncalibrated observation indices; no harmonic confidence transfer')
