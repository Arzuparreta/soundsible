"""Joint beat and first-beat decoding of network activations; NumPy only, no I/O.

A port of the bar-pointer dynamic Bayesian network that Beat This! applies to
its activations: madmom's `DBNDownBeatTrackingProcessor` with the parameters
Beat This! passes (3 and 4 pulses per bar, 55–215 BPM, 50 frames/s, tempo
change λ = 100). The algorithm and its defaults come from Böck, Krebs and
Widmer, "Joint Beat and Downbeat Tracking with Recurrent Neural Networks",
ISMIR 2016, and Krebs, Böck and Widmer, "An Efficient State Space Model for
Joint Tempo and Meter Tracking", ISMIR 2015; madmom's code is BSD-licensed.

The port exists so the engine needs neither madmom (a 2018 source-only
package bundling non-commercial weights) nor SciPy. It reproduces madmom's
decisions, including its edge cases, so the events equal those measured in
the P12-a comparison (docs/dj/detector_comparison).
"""

from __future__ import annotations

import math

FPS = 50.0
BEATS_PER_BAR = (3, 4)
MIN_BPM, MAX_BPM = 55.0, 215.0
NUM_TEMPI = 60
TRANSITION_LAMBDA = 100.0
OBSERVATION_LAMBDA = 16
THRESHOLD = 0.05
_EPSILON = 1e-5  # Beat This! keeps probabilities off 0 and 1 for the DBN.


def _intervals(min_interval: float, max_interval: float, num_intervals: int | None):
    """Beat lengths in frames, as madmom's BeatStateSpace."""
    import numpy as np

    intervals = np.arange(np.round(min_interval), np.round(max_interval) + 1)
    if num_intervals is not None and num_intervals < len(intervals):
        count = num_intervals
        intervals = []
        while len(intervals) < num_intervals:
            intervals = np.unique(np.round(np.logspace(np.log2(min_interval), np.log2(max_interval), count, base=2)))
            count += 1
    return np.ascontiguousarray(intervals, dtype=int)


class _BarModel:
    """State space, sparse transitions and observation pointers for one bar length.

    States run through `beats` consecutive beat cycles; each cycle holds one
    run of `interval` states for every modelled interval (tempo). Inside a
    run the only predecessor is the previous state. The first state of a run
    is reached from the last state of every run of the previous beat, with
    madmom's exponential tempo-change probability.
    """

    def __init__(self, beats: int, min_interval: float, max_interval: float, num_intervals: int | None):
        import numpy as np

        intervals = _intervals(min_interval, max_interval, num_intervals)
        per_beat = int(intervals.sum())
        self.beats = beats
        self.intervals = intervals
        self.num_states = beats * per_beat
        first = np.cumsum(np.r_[0, intervals[:-1]])
        self.first = np.array([first + b * per_beat for b in range(beats)])  # (beats, intervals)
        self.last = self.first + intervals - 1
        positions = np.concatenate([np.linspace(0, 1, i, endpoint=False) for i in intervals])
        self.positions = np.concatenate([positions + b for b in range(beats)])
        border = 1.0 / OBSERVATION_LAMBDA
        self.pointers = np.zeros(self.num_states, dtype=np.intp)
        self.pointers[self.positions % 1 < border] = 1
        self.pointers[self.positions < border] = 2
        ratio = intervals[None, :].astype(float) / intervals[:, None].astype(float)
        probability = np.exp(-TRANSITION_LAMBDA * np.abs(ratio - 1.0))
        probability[probability <= np.spacing(1)] = 0
        probability /= probability.sum(axis=1)[:, None]
        with np.errstate(divide='ignore'):
            self.log_tempo = np.log(probability)  # (from interval, to interval)
        inner = np.ones(self.num_states, dtype=bool)
        inner[self.first.ravel()] = False
        self.inner = np.flatnonzero(inner)

    def viterbi(self, log_densities):
        """Best state path and its log probability, as madmom's HMM.viterbi."""
        import numpy as np

        frames = len(log_densities)
        count = len(self.intervals)
        previous = np.full(self.num_states, -math.log(self.num_states))
        current = np.empty(self.num_states)
        # Only the entry into a beat has a choice; every other state follows
        # its predecessor. Store the chosen previous interval per entry state.
        choice = np.empty((frames, self.beats, count), dtype=np.int16)
        for frame in range(frames):
            current[self.inner] = previous[self.inner - 1]
            for beat in range(self.beats):
                options = previous[self.last[beat - 1]][:, None] + self.log_tempo
                best = np.argmax(options, axis=0)  # First maximum, as madmom's strict ">".
                choice[frame, beat] = best
                current[self.first[beat]] = options[best, np.arange(count)]
            current += log_densities[frame, self.pointers]
            previous, current = current, previous
        state = int(np.argmax(previous))
        log_probability = float(previous[state])
        if math.isinf(log_probability):
            return np.empty(0, dtype=np.intp), log_probability
        entry = {int(s): (b, j) for b in range(self.beats) for j, s in enumerate(self.first[b])}
        path = np.empty(frames, dtype=np.intp)
        for frame in range(frames - 1, -1, -1):
            path[frame] = state
            if state in entry:
                beat, interval = entry[state]
                state = int(self.last[beat - 1][choice[frame, beat, interval]])
            else:
                state -= 1
        return path, log_probability


_MODELS: dict[tuple, list[_BarModel]] = {}


def _models(fps: float) -> list[_BarModel]:
    key = (fps, BEATS_PER_BAR, MIN_BPM, MAX_BPM, NUM_TEMPI)
    if key not in _MODELS:
        _MODELS[key] = [_BarModel(beats, 60.0 * fps / MAX_BPM, 60.0 * fps / MIN_BPM, NUM_TEMPI)
                        for beats in BEATS_PER_BAR]
    return _MODELS[key]


def probabilities(beat_logits, downbeat_logits):
    """Beat This!'s DBN input: (beat without first beat, first beat), off 0 and 1."""
    import numpy as np

    beat = 1.0 / (1.0 + np.exp(-np.asarray(beat_logits, dtype=np.float64)))
    first = 1.0 / (1.0 + np.exp(-np.asarray(downbeat_logits, dtype=np.float64)))
    beat = beat * (1 - _EPSILON) + _EPSILON / 2
    first = first * (1 - _EPSILON) + _EPSILON / 2
    return np.column_stack((np.maximum(beat - first, _EPSILON / 2), first))


def decode(activations, fps: float = FPS):
    """(beat times, beat number in its bar from 1) for (frames, 2) activations.

    Empty arrays when no activation reaches the threshold. Each beat is moved
    to the strongest activation frame inside its beat states, as madmom's
    `correct=True`.
    """
    import numpy as np

    activations = np.asarray(activations, dtype=np.float64)
    first = 0
    rows = np.nonzero(activations >= THRESHOLD)[0]
    # madmom tests `idx.any()`: a lone crossing on frame 0 crops to nothing.
    if rows.any():
        first = max(0, int(np.min(rows)))
        activations = activations[first:min(len(activations), int(np.max(rows)) + 1)]
    else:
        activations = activations[0:0]
    if not activations.any():
        return np.empty(0), np.empty(0, dtype=int)
    densities = np.empty((len(activations), 3))
    with np.errstate(divide='ignore'):
        densities[:, 0] = np.log((1.0 - activations.sum(axis=1)) / (OBSERVATION_LAMBDA - 1))
        densities[:, 1] = np.log(activations[:, 0])
        densities[:, 2] = np.log(activations[:, 1])
    models = _models(fps)
    results = [model.viterbi(densities) for model in models]
    best = int(np.argmax([log_probability for _, log_probability in results]))
    path, _ = results[best]
    model = models[best]
    if path.size == 0:
        return np.empty(0), np.empty(0, dtype=int)
    numbers = model.positions[path].astype(int) + 1
    in_beat = model.pointers[path] >= 1
    if not in_beat.any():
        return np.empty(0), np.empty(0, dtype=int)
    edges = np.nonzero(np.diff(in_beat.astype(int)))[0] + 1
    if in_beat[0]:
        edges = np.r_[0, edges]
    if in_beat[-1]:
        edges = np.r_[edges, in_beat.size]
    frames = []
    if edges.any():
        for left, right in edges.reshape((-1, 2)):
            frames.append(int(np.argmax(activations[left:right])) // 2 + left)
    frames = np.asarray(frames, dtype=int)
    return (frames + first) / float(fps), numbers[frames]


def beats_and_downbeats(beat_logits, downbeat_logits, fps: float = FPS):
    """Beat This!'s `Postprocessor(type="dbn")`: beat times and first-beat times."""
    times, numbers = decode(probabilities(beat_logits, downbeat_logits), fps)
    return times, times[numbers == 1]
