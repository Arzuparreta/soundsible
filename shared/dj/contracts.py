"""Versioned DJ wire contracts and absence of evidence; no I/O."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, NotRequired, TypeAlias, TypedDict

ANALYSER_VERSION = 8

# JSON numbers retain their wire representation. Aliases name units rather
# than wrapping samples or changing the versioned SQLite payload.
Seconds: TypeAlias = float
BeatsPerMinute: TypeAlias = float
PlaybackRatio: TypeAlias = float
AnalysisInput: TypeAlias = Mapping[str, Any]  # Includes partial/old caller data.
PlanInput: TypeAlias = Mapping[str, Any]  # Validate old/incomplete plans at admission.
Candidate: TypeAlias = tuple[dict[str, Any], AnalysisInput]


class Section(TypedDict):
    start: Seconds
    end: Seconds
    label: Literal['intro', 'build', 'drop', 'breakdown', 'body', 'outro']
    level: float  # Relative to this window's loud frames, not inter-song LUFS.


class AnalysisSummary(TypedDict):
    version: int
    duration: Seconds  # 0 = unknown length.
    bpm: BeatsPerMinute  # 0 = unknown pulse, never 0 measured BPM.
    beat_offset: Seconds
    bar_seconds: Seconds  # Current four-beat prior; not measured metre (P12).
    key: str | None
    mode: str | None
    note_rate: float | None  # Notes / sounding second. None unknown; 0 measured.
    loudness_lufs: float | None  # EBU R128 on original channels; None no reading.
    spectral_flatness: float | None  # Power-weighted, dimensionless; 0 valid.
    intro_cue: Seconds
    outro_cue: Seconds | None  # None: player must use its loaded duration.
    tempo_confidence: float
    confidence: float  # Legacy tempo/key composite, not metre/phrase confidence.
    analysed: bool


class Structure(TypedDict):
    beat_grid: list[Seconds]
    downbeats: list[Seconds]
    phrase_boundaries: list[Seconds]
    sections: list[Section]
    intro_cue: Seconds
    outro_cue: Seconds | None


class Analysis(AnalysisSummary):
    # Absolute track seconds, measured only inside decoded windows. Empty lists
    # mean no evidence. Gaps between head/tail must never be interpolated.
    beat_grid: list[Seconds]
    downbeats: list[Seconds]
    phrase_boundaries: list[Seconds]
    sections: list[Section]


class RhythmWindow(TypedDict):
    bpm: BeatsPerMinute
    period: Seconds
    beats: list[Seconds]  # Window-relative times.
    downbeat_phase: int  # Current four-position prior, not metre inference.
    tempo_confidence: float
    grid: Literal['constant', 'local']


class WindowFeatures(TypedDict):
    bpm: BeatsPerMinute
    period: Seconds
    beats: list[Seconds]
    downbeat_phase: int
    tempo_confidence: float
    key: str | None
    mode: str | None
    key_margin: float
    note_count: int
    sounding_seconds: Seconds
    flatness_power: float
    loud_power: float
    intro: Seconds
    last_active: Seconds
    hop_seconds: Seconds
    window_seconds: Seconds  # Coverage is [offset, offset + window_seconds].
    frame_energy: list[float]
    flux: list[float]


class Sync(TypedDict):
    out_period: Seconds
    in_period: Seconds
    phase_tolerance_ms: float
    grid_source: Literal['measured', 'estimated']


class TransitionPlan(TypedDict):
    technique: Literal['bass_swap', 'filter_blend', 'long_blend', 'echo_cut', 'structural_fade', 'safe_fade']
    out_cue: Seconds | None
    in_cue: Seconds
    overlap_seconds: Seconds
    overlap_bars: float
    playback_rate: PlaybackRatio
    echo_delay_seconds: NotRequired[Seconds]
    score: float  # Pair ranking, not a certificate of executable beatmatch.
    confidence: float
    fallback: bool
    sync: Sync


def analysis_summary(analysis: AnalysisInput) -> AnalysisSummary:
    """Compact client view; retain unknowns/zeroes and any future scalar fields.

    Full grids stay in the server cache. Keeping sixteen of them on the wire
    would exceed Android's 256 KiB response budget.
    """
    return {key: value for key, value in analysis.items()
            if key not in {'beat_grid', 'downbeats', 'phrase_boundaries', 'sections'}}


def fallback_analysis(duration: Seconds = 0.0) -> Analysis:
    """A track nobody has measured yet.

    `outro_cue` is deliberately `None` rather than a guess: the player knows the
    real duration of what it has loaded and can place a safe fade against it,
    whereas a number invented here from a missing duration hint is how a
    transition ends up scheduled at 0:00.
    """
    duration = max(0.0, float(duration or 0))
    outro = max(0.0, duration - min(24.0, duration * 0.15)) if duration else None
    return {
        "version": ANALYSER_VERSION,
        "duration": round(duration, 3),
        "bpm": 0.0,
        "beat_offset": 0.0,
        "bar_seconds": 2.0,
        "key": None,
        "mode": None,
        "note_rate": None,
        "loudness_lufs": None,
        "spectral_flatness": None,
        "intro_cue": 0.0,
        "outro_cue": round(outro, 3) if outro else None,
        "beat_grid": [],
        "downbeats": [],
        "phrase_boundaries": [],
        "sections": [],
        "tempo_confidence": 0.0,
        "confidence": 0.18,
        "analysed": False,
    }
