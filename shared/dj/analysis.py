"""Compose complete analysis from measured PCM windows; no decoding, cache or jobs."""

from __future__ import annotations

from .contracts import ANALYSER_VERSION, Analysis, fallback_analysis as _fallback
from .features import _window_features
from .structure import structure_from_windows


def _compose(
    tail,
    head,
    sample_rate: int,
    *,
    duration: float,
    tail_start: float,
    loudness_lufs: float | None = None,
) -> Analysis:
    """Build the stored analysis from the measured windows.

    `tail` carries the pulse, key and outro — everything a transition mixes
    *out* of. `head` only has to say where the music starts, which is what the
    next track mixes *into*.

    `loudness_lufs` is measured by the decoder, on the original channels.
    """
    features = _window_features(tail, sample_rate)
    if features is None:
        return _fallback(duration)
    head_features = features if head is tail else _window_features(head, sample_rate)
    period = features["period"]
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
    return {
        "version": ANALYSER_VERSION,
        "duration": round(duration, 3),
        "bpm": round(features["bpm"], 3),
        "beat_offset": round(beat_offset, 4),
        "bar_seconds": round(period * 4, 4),
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
