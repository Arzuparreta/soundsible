"""Transition-aware analysis and route planning for Auto Mode.

The engine deliberately stores *features*, never decoded audio.  FFmpeg writes
mono float samples to stdout, the analyser consumes them in memory, and the
only durable artifact is a small, versioned SQLite cache.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import sqlite3
import subprocess
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from shared.ffmpeg_runtime import ffmpeg_executable
from shared.runtime import get_cache_dir

ANALYSER_VERSION = 1
DJ_PROFILES = {"adaptive", "long_blend", "cuts_drops", "open_format"}
_PROFILE_POLICY = {
    "adaptive": {"bars": 16, "max_stretch": 0.08, "cut": 0.45},
    "long_blend": {"bars": 32, "max_stretch": 0.06, "cut": 0.15},
    "cuts_drops": {"bars": 8, "max_stretch": 0.1, "cut": 0.8},
    "open_format": {"bars": 8, "max_stretch": 0.12, "cut": 0.7},
}
_KEY_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
_MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)


def _cache_path() -> Path:
    root = get_cache_dir() / "dj"
    root.mkdir(parents=True, exist_ok=True)
    return root / "analysis.sqlite3"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_cache_path(), timeout=10)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audio_analysis (
            identity TEXT NOT NULL,
            source_stamp TEXT NOT NULL,
            analyser_version INTEGER NOT NULL,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (identity, analyser_version)
        )
        """
    )
    return conn


def _source_stamp(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def _fallback(duration: float = 0.0) -> dict[str, Any]:
    duration = max(0.0, float(duration or 0))
    outro = max(0.0, duration - min(24.0, duration * 0.15)) if duration else 0.0
    return {
        "version": ANALYSER_VERSION,
        "duration": round(duration, 3),
        "bpm": 0.0,
        "beat_offset": 0.0,
        "bar_seconds": 2.0,
        "key": None,
        "mode": None,
        "loudness_db": -14.0,
        "energy": 0.5,
        "intro_cue": 0.0,
        "outro_cue": round(outro, 3),
        "phrase_boundaries": [0.0, round(outro, 3)] if outro else [0.0],
        "confidence": 0.18,
        "analysed": False,
    }


def analyse_audio(path: str | Path, identity: str, *, duration_hint: float = 0.0) -> dict[str, Any]:
    """Analyse one local/cached audio source, returning cached data when valid."""
    source = Path(path)
    if not source.is_file():
        return _fallback(duration_hint)
    stamp = _source_stamp(source)
    with _connect() as conn:
        row = conn.execute(
            "SELECT source_stamp, payload FROM audio_analysis WHERE identity = ? AND analyser_version = ?",
            (identity, ANALYSER_VERSION),
        ).fetchone()
        if row and row[0] == stamp:
            try:
                return json.loads(row[1])
            except (TypeError, json.JSONDecodeError):
                pass

    analysis = _analyse_pcm(source, duration_hint=duration_hint)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO audio_analysis(identity, source_stamp, analyser_version, payload, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(identity, analyser_version) DO UPDATE SET
                source_stamp = excluded.source_stamp,
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (identity, stamp, ANALYSER_VERSION, json.dumps(analysis, separators=(",", ":")), int(time.time())),
        )
    return analysis


def _analyse_pcm(path: Path, *, duration_hint: float) -> dict[str, Any]:
    try:
        import numpy as np
    except ImportError:
        return _fallback(duration_hint)

    sample_rate = 11025
    try:
        proc = subprocess.run(
            [
                ffmpeg_executable(),
                "-v",
                "error",
                "-i",
                str(path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(sample_rate),
                "-f",
                "f32le",
                "pipe:1",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError):
        return _fallback(duration_hint)
    samples = np.frombuffer(proc.stdout, dtype="<f4")
    if samples.size < sample_rate * 4:
        return _fallback(duration_hint or samples.size / sample_rate)

    duration = samples.size / sample_rate
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
    windowed = frames * np.hanning(frame)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    energy = rms / max(float(np.percentile(rms, 95)), 1e-7)
    spectrum = np.abs(np.fft.rfft(windowed, axis=1))
    flux = np.maximum(0.0, np.diff(spectrum, axis=0)).sum(axis=1)
    flux /= max(float(np.percentile(flux, 95)), 1e-7)

    min_lag = max(1, round(60 * sample_rate / (190 * hop)))
    max_lag = max(min_lag + 1, round(60 * sample_rate / (65 * hop)))
    centred = flux - np.mean(flux)
    correlations = np.array(
        [float(np.dot(centred[:-lag], centred[lag:])) if lag < centred.size else 0.0 for lag in range(min_lag, max_lag + 1)]
    )
    best_lag = min_lag + int(np.argmax(correlations))
    bpm = 60 * sample_rate / (best_lag * hop)
    period = 60.0 / bpm
    first_window = max(1, min(flux.size, best_lag * 2))
    beat_offset = (int(np.argmax(flux[:first_window])) + 1) * hop / sample_rate

    # A compact chroma estimator.  It is deliberately confidence-gated: the
    # route planner treats uncertain keys as neutral rather than inventing a
    # harmonic incompatibility.
    frequencies = np.fft.rfftfreq(frame, 1 / sample_rate)
    chroma = np.zeros(12, dtype=float)
    valid = frequencies > 55
    midi = np.rint(69 + 12 * np.log2(np.maximum(frequencies[valid], 1e-6) / 440)).astype(int)
    bins = np.mod(midi, 12)
    mean_spectrum = np.mean(spectrum[:, valid], axis=0)
    for pitch_class in range(12):
        chroma[pitch_class] = float(mean_spectrum[bins == pitch_class].sum())
    chroma /= max(float(chroma.sum()), 1e-9)
    candidates: list[tuple[float, int, str]] = []
    for tonic in range(12):
        candidates.append((float(np.dot(chroma, np.roll(_MAJOR_PROFILE, tonic))), tonic, "major"))
        candidates.append((float(np.dot(chroma, np.roll(_MINOR_PROFILE, tonic))), tonic, "minor"))
    candidates.sort(reverse=True)
    key_score, tonic, mode = candidates[0]
    key_margin = max(0.0, key_score - candidates[1][0])

    threshold = max(0.08, float(np.percentile(energy, 35)))
    active_frames = np.flatnonzero(energy >= threshold)
    intro = float(active_frames[0] * hop / sample_rate) if active_frames.size else 0.0
    last_active = float(active_frames[-1] * hop / sample_rate) if active_frames.size else duration
    beats_per_phrase = 32
    phrase_seconds = beats_per_phrase * period
    first_phrase = beat_offset + max(0, math.ceil((intro - beat_offset) / phrase_seconds)) * phrase_seconds
    boundaries = [max(0.0, first_phrase)]
    while boundaries[-1] + phrase_seconds < duration:
        boundaries.append(boundaries[-1] + phrase_seconds)
    outro_candidates = [value for value in boundaries if value <= min(last_active, duration - period * 4)]
    outro = outro_candidates[-1] if outro_candidates else max(0.0, duration - phrase_seconds)
    loudness_db = 20 * math.log10(max(float(np.sqrt(np.mean(samples * samples))), 1e-8))
    periodicity = float(max(0.0, correlations.max()) / (np.dot(centred, centred) + 1e-9))
    confidence = min(0.98, 0.42 + max(0.0, periodicity) * 1.8 + min(0.2, key_margin / 8))

    return {
        "version": ANALYSER_VERSION,
        "duration": round(duration, 3),
        "bpm": round(float(bpm), 3),
        "beat_offset": round(beat_offset, 3),
        "bar_seconds": round(period * 4, 3),
        "key": _KEY_NAMES[tonic],
        "mode": mode,
        "loudness_db": round(loudness_db, 3),
        "energy": round(float(np.clip(np.mean(energy), 0, 1)), 3),
        "intro_cue": round(max(0.0, min(intro, first_phrase)), 3),
        "outro_cue": round(max(0.0, min(outro, duration - period * 4)), 3),
        "phrase_boundaries": [round(float(value), 3) for value in boundaries],
        "confidence": round(confidence, 3),
        "analysed": True,
    }


def _harmonic_score(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
    if not left.get("key") or not right.get("key"):
        return 0.55
    a = _KEY_NAMES.index(str(left["key"]))
    b = _KEY_NAMES.index(str(right["key"]))
    distance = min((a - b) % 12, (b - a) % 12)
    if distance == 0:
        return 1.0 if left.get("mode") == right.get("mode") else 0.82
    if distance in {5, 7}:
        return 0.86
    if distance in {3, 4, 8, 9}:
        return 0.68
    return 0.35


def plan_transition(
    outgoing: Mapping[str, Any],
    incoming: Mapping[str, Any],
    *,
    profile: str = "adaptive",
) -> dict[str, Any]:
    if profile not in DJ_PROFILES:
        profile = "adaptive"
    policy = _PROFILE_POLICY[profile]
    out_bpm = float(outgoing.get("bpm") or 0)
    in_bpm = float(incoming.get("bpm") or 0)
    ratio = out_bpm / in_bpm if out_bpm > 0 and in_bpm > 0 else 1.0
    # Half/double-time pairs represent the same pulse grid.
    if ratio < 0.7:
        ratio *= 2
    elif ratio > 1.4:
        ratio /= 2
    stretch = abs(1 - ratio)
    tempo_score = max(0.0, 1 - stretch / max(float(policy["max_stretch"]), 0.01))
    harmonic = _harmonic_score(outgoing, incoming)
    confidence = min(float(outgoing.get("confidence") or 0), float(incoming.get("confidence") or 0))
    blend_score = 0.46 * tempo_score + 0.32 * harmonic + 0.22 * confidence
    cut_bias = float(policy["cut"])
    if blend_score >= 0.72 and cut_bias < 0.75:
        technique = "bass_swap" if profile != "long_blend" else "long_blend"
    elif blend_score >= 0.55 and profile != "cuts_drops":
        technique = "filter_blend"
    elif confidence >= 0.42:
        technique = "echo_cut" if cut_bias >= 0.55 else "structural_fade"
    else:
        technique = "safe_fade"
    bars = int(policy["bars"])
    if technique in {"echo_cut", "safe_fade", "structural_fade"}:
        bars = min(bars, 8)
    bar_seconds = float(outgoing.get("bar_seconds") or 2.0)
    overlap = max(4.0, min(48.0, bars * bar_seconds))
    duration = float(outgoing.get("duration") or 0)
    proposed_out = float(outgoing.get("outro_cue") or max(0.0, duration - overlap))
    out_cue = min(proposed_out, max(0.0, duration - overlap - 0.5)) if duration else proposed_out
    in_cue = float(incoming.get("intro_cue") or 0)
    return {
        "technique": technique,
        "out_cue": round(out_cue, 3),
        "in_cue": round(in_cue, 3),
        "overlap_seconds": round(overlap, 3),
        "overlap_bars": bars,
        "playback_rate": round(ratio if technique in {"bass_swap", "long_blend", "filter_blend"} else 1.0, 5),
        "score": round(blend_score, 3),
        "confidence": round(confidence, 3),
        "fallback": technique in {"echo_cut", "safe_fade", "structural_fade"},
    }


def order_route(
    current_analysis: Mapping[str, Any],
    candidates: Iterable[tuple[dict[str, Any], Mapping[str, Any]]],
    *,
    profile: str,
    limit: int = 3,
) -> list[dict[str, Any]]:
    """Greedy lookahead over transition quality and recommendation relevance."""
    remaining = list(candidates)
    route: list[dict[str, Any]] = []
    previous = current_analysis
    while remaining and len(route) < limit:
        scored = []
        for index, (item, analysis) in enumerate(remaining):
            transition = plan_transition(previous, analysis, profile=profile)
            relevance = max(0.0, min(1.0, float(item.get("score") or 0.5)))
            score = transition["score"] * 0.72 + relevance * 0.28
            scored.append((score, -index, item, analysis, transition))
        _, _, item, analysis, transition = max(scored, key=lambda row: (row[0], row[1]))
        route.append({**item, "analysis": dict(analysis), "transition": transition})
        remaining = [(candidate, data) for candidate, data in remaining if candidate is not item]
        previous = analysis
    return route


def route_to_request(
    current_analysis: Mapping[str, Any],
    bridges: Iterable[tuple[dict[str, Any], Mapping[str, Any]]],
    requested: tuple[dict[str, Any], Mapping[str, Any]],
    *,
    profile: str,
    max_starts: int = 3,
) -> list[dict[str, Any]]:
    """Choose zero, one, or two bridges, always ending at the exact request."""
    bridge_rows = list(bridges)[:12]
    requested_item, requested_analysis = requested
    best_score = -1.0
    best: tuple[tuple[dict[str, Any], Mapping[str, Any]], ...] = (requested,)
    max_bridges = max(0, min(2, max_starts - 1))
    for count in range(max_bridges + 1):
        for prefix in itertools.permutations(bridge_rows, count):
            sequence = (*prefix, requested)
            previous = current_analysis
            scores: list[float] = []
            for _, analysis in sequence:
                scores.append(float(plan_transition(previous, analysis, profile=profile)["score"]))
                previous = analysis
            # A bridge has to materially improve the path to justify delaying an
            # explicit request.  This small cost makes a clean direct mix win.
            score = sum(scores) / len(scores) - count * 0.035
            if score > best_score:
                best_score = score
                best = sequence
    route: list[dict[str, Any]] = []
    previous = current_analysis
    for item, analysis in best:
        transition = plan_transition(previous, analysis, profile=profile)
        route.append({**item, "analysis": dict(analysis), "transition": transition})
        previous = analysis
    return route


def analysis_identity(item: Mapping[str, Any]) -> str:
    raw = (
        str(item.get("track_id") or "")
        or str(item.get("youtube_id") or item.get("id") or "")
        or f"{item.get('artist', '')}:{item.get('title', '')}"
    )
    return hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()
