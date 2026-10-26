"""Beat This! pulse and first-beat events for one PCM window; NumPy, no I/O.

The network is Beat This! `final0` (Foscarin, Schlüter and Widmer, ISMIR 2024;
code and weights MIT, https://github.com/CPJKU/beat_this), exported to ONNX
and run by ONNX Runtime. Its events are decoded by `dbn`. The P12-a comparison
measured this path against the upstream PyTorch pipeline: identical events on
all 62 inputs (docs/dj/detector_comparison/RESULTS.md).

`session` is anything with ONNX Runtime's `run(None, {"spect": array})`; the
weights and the runtime are loaded by `weights`, never here.
"""

from __future__ import annotations

from . import dbn

SAMPLE_RATE = 22050
FPS = 50  # One spectrogram frame every 441 samples.
_N_FFT, _HOP, _F_MIN, _F_MAX, _N_MELS = 1024, 441, 30.0, 11000.0, 128
# The network was trained on 1500-frame excerpts and discards six frames at
# each edge of a prediction; whole pieces are predicted in overlapping chunks.
_CHUNK, _BORDER = 1500, 6


def _hz_to_mel(f):
    import numpy as np

    f = np.asarray(f, dtype=np.float64)
    log = f >= 1000.0
    return np.where(log, 15.0 + np.log(np.maximum(f, 1e-12) / 1000.0) / (np.log(6.4) / 27.0), f / (200.0 / 3))


def _mel_to_hz(m):
    import numpy as np

    m = np.asarray(m, dtype=np.float64)
    return np.where(m >= 15.0, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - 15.0)), m * (200.0 / 3))


_FILTERBANK = None


def _filterbank():
    """Slaney mel triangles without area normalisation, as torchaudio's."""
    import numpy as np

    global _FILTERBANK
    if _FILTERBANK is None:
        freqs = np.linspace(0, SAMPLE_RATE // 2, _N_FFT // 2 + 1)
        points = _mel_to_hz(np.linspace(_hz_to_mel(_F_MIN), _hz_to_mel(_F_MAX), _N_MELS + 2))
        diff = points[1:] - points[:-1]
        slopes = points[None, :] - freqs[:, None]
        _FILTERBANK = np.maximum(0.0, np.minimum(-slopes[:, :-2] / diff[:-1], slopes[:, 2:] / diff[1:]))
    return _FILTERBANK


def log_mel(signal):
    """Beat This!'s input: (frames, 128) log1p(1000 · mel magnitude).

    Centred, reflect-padded periodic-Hann STFT; magnitude scaled by
    1/sqrt(n_fft), which is torchaudio's `normalized="frame_length"`.
    Computed in blocks so a long window never holds its whole spectrum.
    """
    import numpy as np

    signal = np.asarray(signal, dtype=np.float32)
    window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(_N_FFT) / _N_FFT)).astype(np.float32)
    padded = np.pad(signal, _N_FFT // 2, mode='reflect')
    count = 1 + (len(padded) - _N_FFT) // _HOP
    frames = np.lib.stride_tricks.as_strided(
        padded, shape=(count, _N_FFT), strides=(padded.strides[0] * _HOP, padded.strides[0]), writeable=False)
    bank = _filterbank()
    result = np.empty((count, _N_MELS), dtype=np.float32)
    for start in range(0, count, 1024):
        block = np.abs(np.fft.rfft(frames[start:start + 1024] * window, axis=1)) / np.sqrt(_N_FFT)
        result[start:start + len(block)] = np.log1p(1000.0 * (block @ bank))
    return result


def logits(session, spect):
    """(beat, first-beat) logits per frame, chunked like upstream `keep_first`."""
    import numpy as np

    size = len(spect)
    starts = np.arange(-_BORDER, size - _BORDER, _CHUNK - 2 * _BORDER)
    if size > _CHUNK - 2 * _BORDER:
        starts[-1] = size - (_CHUNK - _BORDER)
    beat = np.full(size, -1000.0, dtype=np.float32)
    first = np.full(size, -1000.0, dtype=np.float32)
    for start in reversed(starts):  # Earlier chunks overwrite later ones.
        piece = spect[max(start, 0):min(start + _CHUNK, size)]
        piece = np.pad(piece, ((max(0, -start), max(0, min(_BORDER, start + _CHUNK - size))), (0, 0)))
        out_beat, out_first = session.run(None, {'spect': piece[None]})
        span = slice(start + _BORDER, start + _CHUNK - _BORDER)
        width = len(beat[span])
        beat[span] = out_beat[0][_BORDER:-_BORDER][:width]
        first[span] = out_first[0][_BORDER:-_BORDER][:width]
    return beat, first


def events(session, signal):
    """(beat times, first-beat times) in window seconds from 22050 Hz mono PCM.

    The DBN chooses each beat's frame and its place in the bar. The time is
    then read between frames: a parabola through the activation peak and its
    neighbours, in the column (beat or first beat) that peaks there. The
    decisions stay those measured in P12-a; only their timing gains precision.
    """
    import numpy as np

    beat, first = logits(session, log_mel(signal))
    activations = dbn.probabilities(beat, first)
    times, numbers = dbn.decode(activations, FPS)
    if times.size == 0:
        return times, times
    frames = np.rint(times * FPS).astype(int)
    column = np.argmax(activations[frames], axis=1)
    left = activations[np.maximum(frames - 1, 0), column]
    centre = activations[frames, column]
    right = activations[np.minimum(frames + 1, len(activations) - 1), column]
    curvature = left - 2 * centre + right
    shift = np.where(curvature < 0, 0.5 * (left - right) / np.where(curvature < 0, curvature, -1.0), 0.0)
    times = (frames + np.clip(shift, -0.5, 0.5)) / FPS
    return times, times[numbers == 1]
