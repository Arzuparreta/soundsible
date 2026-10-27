"""Window-level note density, tonality and texture; independent DSP resolutions."""

from __future__ import annotations

import math

from .rhythm import _rhythm
from .contracts import WindowFeatures

# Spectral flatness is read where music has its harmonics. Frames more than
# 20 dB under the song's loud level (fades, gaps) and windows quieter than
# -80 dBFS say nothing about how the music sounds.
_FLATNESS_BAND = (100.0, 5000.0)


_LOUD_FRAME_RATIO = 0.1


_SILENT_RMS = 1e-4


# Octave bands (IEC 61260 centres) where the arrangement is read for structure
# (`structure`): 63 Hz to 4 kHz, the top one cut at the 5 kHz the other
# measures stop at. The two lowest, 44-177 Hz, hold the kick and the bass.
OCTAVE_CENTRES = (63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0)


_OCTAVE_EDGES = tuple(centre / 2 ** .5 for centre in OCTAVE_CENTRES) + (5000.0,)


_KEY_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


_MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)


_MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)


def _window_features(samples, sample_rate: int, events=None) -> WindowFeatures | None:
    """Frame-level measures for one decoded window, in window-relative time.

    `events` are the beat model's (beats, first beats) for this window; without
    them the window has no pulse.
    """
    import numpy as np

    if samples is None or samples.size < sample_rate * 4:
        return None
    hop = 512
    frame = 2048
    usable = samples[: samples.size - frame]
    count = max(1, 1 + (usable.size - frame) // hop)
    frames = np.lib.stride_tricks.as_strided(
        usable,
        shape=(count, frame),
        strides=(usable.strides[0] * hop, usable.strides[0]),
        writeable=False,
    )
    # Only per-frame measures survive this calculation. Keep a small FFT
    # working set instead of several full-song matrices (over 400 MiB for an
    # eight-minute track, multiplied by concurrent analyses).
    frequencies = np.fft.rfftfreq(frame, 1 / sample_rate)
    band = np.searchsorted(frequencies, _FLATNESS_BAND)
    rms, flatness, octaves = _spectral_features(frames, flatness_bins=slice(int(band[0]), int(band[1])),
                                                band_bins=np.searchsorted(frequencies, _OCTAVE_EDGES))
    loud_level = float(np.percentile(rms, 95))
    # Level against the song's own loud level: where it starts and stops
    # sounding. Not comparable between songs.
    energy = rms / max(loud_level, 1e-7)
    loud = rms >= loud_level * _LOUD_FRAME_RATIO if loud_level >= _SILENT_RMS else np.zeros(rms.size, dtype=bool)
    loud_weights = rms[loud].astype(float) ** 2
    note_count, sounding_seconds = _note_onsets(samples, sample_rate)
    rhythm = _rhythm(samples, sample_rate, events)

    key, mode, key_margin = _tonal_features(samples, sample_rate) if loud_level >= _SILENT_RMS else (None, None, 0.0)

    window_seconds = samples.size / sample_rate
    threshold = max(0.08, float(np.percentile(energy, 35)))
    active_frames = np.flatnonzero(energy >= threshold)
    intro = float(active_frames[0] * hop / sample_rate) if active_frames.size else 0.0
    last_active = float(active_frames[-1] * hop / sample_rate) if active_frames.size else window_seconds

    return {
        # Without a measurable pulse (silence, a drone) the tempo is reported
        # as unknown, 0 BPM, like an unmeasured song's; no grid is invented.
        # The structural cues below still need a beat length: 120 BPM is
        # only a unit there.
        "bpm": rhythm["bpm"] if rhythm else 0.0,
        "period": rhythm["period"] if rhythm else 0.5,
        "beats": rhythm["beats"] if rhythm else [],
        "metric_regions": rhythm["metric_regions"] if rhythm else [],
        "tempo_confidence": rhythm["tempo_confidence"] if rhythm else 0.0,
        "key": key,
        "mode": mode,
        "key_margin": key_margin,
        "note_count": note_count,
        "sounding_seconds": sounding_seconds,
        "flatness_power": float(np.dot(flatness[loud], loud_weights)),
        "loud_power": float(loud_weights.sum()),
        "intro": intro,
        "last_active": last_active,
        "hop_seconds": hop / sample_rate,
        "frame_seconds": frame / sample_rate,
        "window_seconds": window_seconds,
        "band_power": octaves,
    }


def _spectral_features(frames, *, flatness_bins: slice = slice(1, None), band_bins=None):
    """Same per-frame measures as a whole-matrix FFT, with bounded scratch space.

    Returns per-frame RMS, per-frame spectral flatness (geometric over
    arithmetic mean of the power) across `flatness_bins`, and per-frame power
    in the contiguous bands that `band_bins` delimits (float32, frames x bands).
    """
    import numpy as np

    count, frame_size = frames.shape
    rms = np.empty(count, dtype=frames.dtype if frames.dtype.kind == "f" else float)
    flatness = np.empty(count, dtype=float)
    edges = np.asarray(band_bins if band_bins is not None else [], dtype=int)
    bands = np.empty((count, max(0, edges.size - 1)), dtype=np.float32)
    window = np.hanning(frame_size)
    for start in range(0, count, 256):
        block = frames[start:start + 256]
        end = start + len(block)
        rms[start:end] = np.sqrt(np.mean(block * block, axis=1) + 1e-12)
        spectrum = np.abs(np.fft.rfft(block * window, axis=1))
        power = spectrum[:, flatness_bins] ** 2 + 1e-12
        flatness[start:end] = np.exp(np.log(power).mean(axis=1)) / power.mean(axis=1)
        if edges.size > 1:
            bands[start:end] = np.add.reduceat(spectrum[:, edges[0]:edges[-1]] ** 2, edges[:-1] - edges[0], axis=1)
    return rms, flatness, bands


# Tonality --------------------------------------------------------------------
# The section/rhythm FFT cannot separate low semitones: its 5.4 Hz bins exceed
# the 1.94 Hz between C1 and C#1. Here 16384 samples give 0.67 Hz bins at the
# decoder's 11025 Hz. Half-window hops and 32-frame blocks keep cost and scratch
# memory bounded. Cadences across all 24 keys, registers and harmonic timbres
# establish this resolution (tests/test_dj_harmony.py).
_TONAL_FRAME = 16384


_TONAL_BLOCK = 32


_TONAL_BAND = (32.7, 5000.0)  # C1 through the analysed musical spectrum, Hz.


def _tonal_features(samples, sample_rate: int) -> tuple[str | None, str | None, float]:
    """Chroma with resolved bass notes; Krumhansl-Schmuckler correlation.

    Pearson correlation centres and normalises *both* profiles. A raw dot
    product favours the minor profile's larger mean and norm even for major
    cadences. These are the existing published profiles, without taste weights.
    https://extras.humdrum.org/man/keycor/
    """
    import numpy as np

    if samples.size < _TONAL_FRAME:
        return None, None, 0.0
    frames = np.lib.stride_tricks.sliding_window_view(samples, _TONAL_FRAME)[::_TONAL_FRAME // 2]
    frequencies = np.fft.rfftfreq(_TONAL_FRAME, 1 / sample_rate)
    valid = (frequencies >= _TONAL_BAND[0]) & (frequencies <= _TONAL_BAND[1])
    pitch_classes = np.rint(69 + 12 * np.log2(frequencies[valid] / 440)).astype(int) % 12
    spectrum_sum = np.zeros(_TONAL_FRAME // 2 + 1, dtype=float)
    window = np.hanning(_TONAL_FRAME)
    for start in range(0, len(frames), _TONAL_BLOCK):
        spectrum_sum += np.abs(np.fft.rfft(frames[start:start + _TONAL_BLOCK] * window, axis=1)).sum(axis=0)
    chroma = np.bincount(pitch_classes, weights=spectrum_sum[valid], minlength=12)
    # A uniform chroma (including silence) has no tonal centre.
    chroma /= max(float(chroma.sum()), 1e-12)
    chroma -= chroma.mean()
    norm = float(np.linalg.norm(chroma))
    if norm <= 1e-12:
        return None, None, 0.0
    candidates = []
    for mode, values in (("major", _MAJOR_PROFILE), ("minor", _MINOR_PROFILE)):
        profile = np.asarray(values) - np.mean(values)
        profile /= np.linalg.norm(profile)
        for tonic in range(12):
            candidates.append((float(np.dot(chroma, np.roll(profile, tonic)) / norm), tonic, mode))
    candidates.sort(reverse=True)
    score, tonic, mode = candidates[0]
    margin = max(0.0, score - candidates[1][0])
    return _KEY_NAMES[tonic], mode, margin


# Notes -----------------------------------------------------------------------
#
# Notes per second counts attacks: a new pitch, or the same one struck again.
# The onset function is a spectral flux in the manner of SuperFlux (Böck and
# Widmer, 2013): log magnitudes in quarter-tone bands, each compared with the
# loudest of its neighbours two frames earlier, so a vibrato that moves a
# partial within a quarter tone either way rises nowhere. A band rises only by
# more than it fluctuates by itself: a noisy band (cymbals, a choir's breath,
# hiss) has to rise more than a steady partial does.
#
# The constants are signal-processing constants, set so that synthetic
# signals with a known number of notes measure it: tests/test_dj_note_rate.py
# has melodies of 1 to 12 notes per second played legato and staccato, with
# and without vibrato and hall reverberation, repeated orchestral chords,
# choral chords, drum patterns, noise and a drone.

_NOTE_FRAME = 512  # 46 ms at 11025 Hz


_NOTE_HOP = 128  # 11.6 ms


_NOTE_BAND = (40.0, 5000.0)


_NOTE_BANDS_PER_OCTAVE = 24


_NOTE_LAG = 2  # frames between the compared spectra


_NOTE_SMOOTHING = 3  # frames averaged before the comparison


# Floor of the log compression, against the loud frame level: -60 dB.
_NOTE_FLOOR = 1e-3


# Peak picking: a local maximum over +-30 ms, `_NOTE_DELTA` above the mean of
# the onset function from 50 ms before to 70 ms after, 60 ms after the last.
_NOTE_DELTA = 2.0


_NOTE_PEAK_SECONDS = 0.03


_NOTE_MEAN_BEFORE = 0.05


_NOTE_MEAN_AFTER = 0.07


_NOTE_MIN_GAP = 0.06


# A band's own fluctuation is its median change over a block of 256 frames
# (3 s); counting is over the seconds within 20 dB of the loud level, rests
# of up to a second either side included.
_NOTE_BLOCK = 256


_NOTE_SOUNDING_RATIO = 0.1


_NOTE_REST_SECONDS = 1.0


def _note_onsets(samples, sample_rate: int) -> tuple[int, float]:
    """Number of note attacks in one window, and the seconds that sound.

    Memory is bounded by `_NOTE_BLOCK` frames whatever the window's length.
    """
    import numpy as np

    signal = np.ascontiguousarray(samples, dtype=np.float32)
    count = 1 + (signal.size - _NOTE_FRAME) // _NOTE_HOP if signal.size >= _NOTE_FRAME else 0
    if count < 16:
        return 0, 0.0
    frames = np.lib.stride_tricks.as_strided(
        signal,
        shape=(count, _NOTE_FRAME),
        strides=(signal.strides[0] * _NOTE_HOP, signal.strides[0]),
        writeable=False,
    )
    level = np.empty(count, dtype=np.float64)
    for start in range(0, count, _NOTE_BLOCK):
        block = frames[start:start + _NOTE_BLOCK].astype(np.float64)
        level[start:start + len(block)] = np.sqrt(np.mean(block * block, axis=1))
    loud_level = float(np.percentile(level, 95))
    if loud_level < _SILENT_RMS:
        return 0, 0.0

    frequencies = np.fft.rfftfreq(_NOTE_FRAME, 1 / sample_rate)
    selected = np.flatnonzero((frequencies >= _NOTE_BAND[0]) & (frequencies <= min(_NOTE_BAND[1], sample_rate * 0.475)))
    band_index = np.rint(_NOTE_BANDS_PER_OCTAVE * np.log2(frequencies[selected] / _NOTE_BAND[0])).astype(int)
    # Below about 400 Hz a bin is wider than a quarter tone: each bin is a band.
    band_starts = np.flatnonzero(np.r_[True, np.diff(band_index) > 0])
    band_sizes = np.diff(np.r_[band_starts, selected.size]).astype(np.float32)
    # A unit sinusoid in a Hann frame peaks at N/4 in its bin.
    scale = np.float32(1.0 / (_NOTE_FLOOR * loud_level * math.sqrt(2) * _NOTE_FRAME / 4))
    window = np.hanning(_NOTE_FRAME).astype(np.float32)
    history = _NOTE_SMOOTHING - 1 + _NOTE_LAG
    carried = None
    onset = np.zeros(count, dtype=np.float64)
    for start in range(0, count, _NOTE_BLOCK):
        block = frames[start:start + _NOTE_BLOCK] * window
        magnitude = np.abs(np.fft.rfft(block, axis=1))[:, selected]
        bands = np.log1p(np.add.reduceat(magnitude, band_starts, axis=1) / band_sizes * scale)
        if carried is not None:
            bands = np.concatenate([carried, bands])
        offset = 0 if carried is None else carried.shape[0]
        carried = bands[-history:]
        # Causal moving mean over `_NOTE_SMOOTHING` frames.
        cumulative = np.cumsum(np.pad(bands, ((1, 0), (0, 0))), axis=0)
        smooth = np.empty_like(bands)
        width = np.minimum(np.arange(1, bands.shape[0] + 1), _NOTE_SMOOTHING)[:, None]
        rows = np.arange(bands.shape[0])
        smooth[:] = (cumulative[rows + 1] - cumulative[np.maximum(rows + 1 - _NOTE_SMOOTHING, 0)]) / width
        padded = np.pad(smooth, ((0, 0), (1, 1)), mode="edge")
        widest = np.maximum(np.maximum(padded[:, :-2], padded[:, 1:-1]), padded[:, 2:])
        rise = smooth[_NOTE_LAG:] - widest[:-_NOTE_LAG]
        jitter = np.median(np.abs(smooth[_NOTE_LAG:] - smooth[:-_NOTE_LAG]), axis=0)
        flux = np.maximum(0.0, rise - jitter).sum(axis=1)
        # Row r of `flux` describes block-relative frame r + _NOTE_LAG.
        first = max(offset, _NOTE_LAG)
        stop = start + len(block)
        onset[start + first - offset:stop] = flux[first - _NOTE_LAG:]

    frame_rate = sample_rate / _NOTE_HOP
    peak = int(round(_NOTE_PEAK_SECONDS * frame_rate))
    before = int(round(_NOTE_MEAN_BEFORE * frame_rate))
    after = int(round(_NOTE_MEAN_AFTER * frame_rate))
    view = np.lib.stride_tricks.sliding_window_view
    local_max = view(np.pad(onset, peak, mode="edge"), 2 * peak + 1).max(axis=1)
    local_mean = view(np.pad(onset, (before, after), mode="edge"), before + after + 1).mean(axis=1)
    candidates = np.flatnonzero((onset == local_max) & (onset >= local_mean + _NOTE_DELTA))
    rest = int(round(_NOTE_REST_SECONDS * frame_rate))
    sounding = view(np.pad(level, rest, mode="edge"), 2 * rest + 1).max(axis=1) >= loud_level * _NOTE_SOUNDING_RATIO
    gap = _NOTE_MIN_GAP * frame_rate
    notes = 0
    last = -math.inf
    for index in candidates:
        if index - last >= gap:
            last = index
            notes += int(sounding[index])
    return notes, float(sounding.sum() / frame_rate)
