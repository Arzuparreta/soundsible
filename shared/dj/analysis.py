"""Compose complete analysis from measured PCM windows; no decoding, cache or jobs."""

from __future__ import annotations

from .contracts import ANALYSER_VERSION, Analysis, fallback_analysis as _fallback
from .features import _window_features
from .structure import structure_from_windows

# Decimation 22050 → 11025 Hz: Kaiser-windowed sinc (β 9, 64 taps a side,
# about 90 dB of stopband), cutoff at 97 % of the new Nyquist like FFmpeg's
# default resampler. The bands the 11025 Hz measures read end at 5 kHz.
_DECIMATION_TAPS = 64
_DECIMATION_CUTOFF = 0.97
_DECIMATION_BETA = 9.0


def decimate(samples):
    """The 22050 Hz window band-limited and halved: 11025 Hz float32, zero phase.

    The beat model reads 22050 Hz; the other measures keep the 11025 Hz
    resolution they were validated at. One FFmpeg decode feeds both.
    """
    import numpy as np

    signal = np.asarray(samples, dtype=np.float32)
    span = _DECIMATION_TAPS
    k = np.arange(-span, span + 1)
    cutoff = 0.25 * _DECIMATION_CUTOFF  # Cycles per input sample; the new Nyquist is 0.25.
    taps = 2 * cutoff * np.sinc(2 * cutoff * k) * np.kaiser(k.size, _DECIMATION_BETA)
    taps = (taps / taps.sum()).astype(np.float32)
    # y[n] = Σ_m taps[m] · padded[2n + 2T − m] with padded = x surrounded by T
    # zeros. Even taps read only even samples and odd taps only odd ones, so
    # two half-rate convolutions replace one at the input rate.
    padded = np.pad(signal, span)
    count = (signal.size + 1) // 2
    even = np.convolve(padded[0::2], taps[0::2])[span:span + count]
    odd = np.convolve(padded[1::2], taps[1::2])[span - 1:span - 1 + count]
    return (even + odd).astype(np.float32)


def _compose(
    tail,
    head,
    sample_rate: int,
    *,
    duration: float,
    tail_start: float,
    loudness_lufs: float | None = None,
    events=None,
) -> Analysis:
    """Build the stored analysis from the measured windows.

    `tail` carries the pulse, key and outro — everything a transition mixes
    *out* of. `head` only has to say where the music starts, which is what the
    next track mixes *into*.

    `loudness_lufs` is measured by the decoder, on the original channels.
    `events` is (tail, head) beat-model events in window seconds, or None.
    """
    tail_events, head_events = events if events is not None else (None, None)
    features = _window_features(tail, sample_rate, tail_events)
    if features is None:
        return _fallback(duration)
    head_features = features if head is tail else _window_features(head, sample_rate, head_events)
    structure = structure_from_windows(features, head_features, duration=duration, tail_start=tail_start)
    beats = structure["beat_grid"]
    beat_offset = beats[0] if beats else 0.0

    # A long mix enters on its head grid and leaves on its tail grid: the
    # weaker of the two is how far either can be trusted.
    tempo_confidence = features["tempo_confidence"]
    measured_windows = [features]
    if tail_start and head_features is not None:
        tempo_confidence = min(tempo_confidence, head_features["tempo_confidence"])
        measured_windows.append(head_features)
    # Both windows of a long mix count as one sample of it: notes over the
    # seconds that sound, flatness over the loud frames' power.
    notes = sum(window["note_count"] for window in measured_windows)
    sounding = sum(window["sounding_seconds"] for window in measured_windows)
    flatness_power = sum(window["flatness_power"] for window in measured_windows)
    loud_power = sum(window["loud_power"] for window in measured_windows)
    confidence = min(0.98, 0.38 + tempo_confidence * 0.36 + min(0.2, features["key_margin"] / 8))
    regions = []
    windows = [(features, tail_start)]
    if tail_start and head_features is not None:
        windows.insert(0, (head_features, 0.0))
    for window, offset in windows:
        for region in window['metric_regions']:
            regions.append({**region, 'start': round(offset + region['start'], 4),
                            'end': round(offset + region['end'], 4),
                            'downbeats': [round(offset + t, 4) for t in region['downbeats']]})
    # A scalar is only a summary of one constant grouping, never a default 4/4.
    bars = {region['bar_seconds'] for region in regions}
    bar_seconds = next(iter(bars)) if len(bars) == 1 else None
    summary = {}
    for key in ('beats_per_bar', 'subdivision', 'pulse_unit'):
        values = {region[key] for region in regions}
        summary[key] = next(iter(values)) if len(values) == 1 else None
    for key in ('metre_confidence', 'downbeat_confidence', 'subdivision_confidence'):
        summary[key] = min((region[key] for region in regions), default=0.)
    return {
        **summary,
        "version": ANALYSER_VERSION,
        "duration": round(duration, 3),
        "bpm": round(features["bpm"], 3),
        "beat_offset": round(beat_offset, 4),
        "bar_seconds": bar_seconds,
        "metric_regions": regions,
        "key": features["key"],
        "mode": features["mode"],
        # Physical magnitudes, comparable between songs: notes per second of
        # sounding music, EBU R128 integrated loudness, and the spectral
        # flatness of the loud frames (0 for a pure tone, about 0.56 for white
        # noise). docs/dj/HANDOFF.md, P4.
        "note_rate": round(notes / sounding, 3) if sounding > 0 else 0.0,
        "loudness_lufs": round(float(loudness_lufs), 2) if loudness_lufs is not None else None,
        "spectral_flatness": round(flatness_power / loud_power, 4) if loud_power > 0 else 0.0,
        "intro_cue": structure["intro_cue"],
        "outro_cue": structure["outro_cue"],
        # Tenths of a millisecond: the mixers align these points to the sample.
        "beat_grid": structure["beat_grid"],
        "downbeats": structure["downbeats"],
        "phrase_boundaries": structure["phrase_boundaries"],
        "sections": structure["sections"],
        "tempo_confidence": round(tempo_confidence, 3),
        "confidence": round(confidence, 3),
        "analysed": True,
    }
