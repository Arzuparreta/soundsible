"""Transition-aware analysis and route planning for Auto Mode.

The engine deliberately stores *features*, never decoded audio.  FFmpeg writes
mono float samples to stdout, the analyser consumes them in memory, and the
only durable artifact is a small, versioned SQLite cache.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import subprocess
import threading
import time
from collections.abc import Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from shared.ffmpeg_runtime import ffmpeg_executable
from shared.runtime import get_cache_dir

ANALYSER_VERSION = 3
# A normal song is decoded in full so the grid and the musical sections come
# from the recording, not from arithmetic projected from its first transient.
# Very long mixes remain bounded: their head and tail still provide everything
# needed for a safe hand-off without monopolising the background analyser.
WINDOWED_ABOVE_SECONDS = 480.0
HEAD_WINDOW_SECONDS = 90.0
TAIL_WINDOW_SECONDS = 120.0
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


_CONNECTIONS = threading.local()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audio_analysis (
    identity TEXT NOT NULL,
    source_stamp TEXT NOT NULL,
    analyser_version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (identity, analyser_version)
)
"""


def _connect() -> sqlite3.Connection:
    """This thread's connection to the analysis cache.

    One `dj-plan` asks for cached analysis once per candidate — 30 to 60 times.
    Each of those used to open a connection and run `CREATE TABLE IF NOT
    EXISTS`. The connection is also configured with WAL and a busy timeout now,
    which it never was: without them it contended with the background analysis
    workers writing to the same file.
    """
    path = _cache_path()
    existing = getattr(_CONNECTIONS, "conn", None)
    if existing is not None and getattr(_CONNECTIONS, "path", None) == path:
        return existing
    if existing is not None:
        # The runtime cache dir moved (tests, storage reconfiguration).
        existing.close()

    conn = sqlite3.connect(path, timeout=10)
    # busy_timeout first: it is per-connection and always succeeds, and without
    # it the journal_mode switch below fails outright rather than waiting.
    conn.execute("PRAGMA busy_timeout=10000")
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        # WAL is a property of the file, not the connection: another connection
        # already set it, and switching needs a lock no reader will yield.
        pass
    conn.execute(_SCHEMA)
    conn.commit()
    _CONNECTIONS.conn = conn
    _CONNECTIONS.path = path
    return conn


def _source_stamp(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def _fallback(duration: float = 0.0) -> dict[str, Any]:
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
        "loudness_db": -14.0,
        "energy": 0.5,
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


def cached_analysis(path: str | Path, identity: str) -> dict[str, Any] | None:
    """Previously measured features for this exact file, or None."""
    source = Path(path)
    if not source.is_file():
        return None
    try:
        stamp = _source_stamp(source)
    except OSError:
        return None
    with _connect() as conn:
        row = conn.execute(
            "SELECT source_stamp, payload FROM audio_analysis WHERE identity = ? AND analyser_version = ?",
            (identity, ANALYSER_VERSION),
        ).fetchone()
    if not row or row[0] != stamp:
        return None
    try:
        return json.loads(row[1])
    except (TypeError, json.JSONDecodeError):
        return None


def analyse_audio(path: str | Path, identity: str, *, duration_hint: float = 0.0) -> dict[str, Any]:
    """Analyse one local/cached audio source, returning cached data when valid."""
    source = Path(path)
    if not source.is_file():
        return _fallback(duration_hint)
    cached = cached_analysis(source, identity)
    if cached is not None:
        return cached

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
            (identity, _source_stamp(source), ANALYSER_VERSION, json.dumps(analysis, separators=(",", ":")), int(time.time())),
        )
    return analysis


_pool: ThreadPoolExecutor | None = None
_pending: set[str] = set()
_pending_lock = threading.Lock()


def _analysis_pool() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        # Two at a time: enough to keep a session's runway warm, few enough that
        # analysis never competes with the streaming the listener can hear.
        _pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="dj-analysis")
    return _pool


def request_analysis(path: str | Path, identity: str, *, duration_hint: float = 0.0) -> None:
    """Measure this source in the background.

    Planning never waits on FFmpeg. A route is built from whatever is already
    known — cached features, or a conservative fallback — and the real analysis
    lands in the cache for the plans that follow, well before the transition it
    describes is committed.
    """
    source = Path(path)
    if not source.is_file() or not identity:
        return
    with _pending_lock:
        if identity in _pending:
            return
        _pending.add(identity)

    def run() -> None:
        try:
            analyse_audio(source, identity, duration_hint=duration_hint)
        except Exception:
            pass
        finally:
            with _pending_lock:
                _pending.discard(identity)

    try:
        _analysis_pool().submit(run)
    except RuntimeError:
        with _pending_lock:
            _pending.discard(identity)


def _probe_duration(path: Path) -> float:
    """Track length without decoding it. Returns 0 when unavailable."""
    executable = Path(ffmpeg_executable())
    probe = executable.with_name(executable.name.replace("ffmpeg", "ffprobe", 1))
    for candidate in (str(probe), "ffprobe"):
        try:
            result = subprocess.run(
                [candidate, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=20,
            )
            return max(0.0, float((result.stdout or b"").decode("utf-8", "ignore").strip() or 0))
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    return 0.0


def _decode(path: Path, sample_rate: int, *, start: float = 0.0, length: float = 0.0):
    """Decode one window to mono float PCM. Returns None on any failure."""
    try:
        import numpy as np
    except ImportError:
        return None
    command = [ffmpeg_executable(), "-v", "error"]
    if start > 0:
        # Before -i, so FFmpeg seeks instead of decoding and discarding.
        command += ["-ss", f"{start:.3f}"]
    command += ["-i", str(path)]
    if length > 0:
        command += ["-t", f"{length:.3f}"]
    command += ["-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "f32le", "pipe:1"]
    try:
        proc = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return np.frombuffer(proc.stdout, dtype="<f4")


def _analyse_pcm(path: Path, *, duration_hint: float) -> dict[str, Any]:
    sample_rate = 11025
    duration = float(duration_hint or 0)
    if duration <= 0:
        duration = _probe_duration(path)

    if duration > WINDOWED_ABOVE_SECONDS:
        head = _decode(path, sample_rate, length=HEAD_WINDOW_SECONDS)
        tail_start = max(0.0, duration - TAIL_WINDOW_SECONDS)
        tail = _decode(path, sample_rate, start=tail_start, length=TAIL_WINDOW_SECONDS)
        if tail is None or tail.size < sample_rate * 4:
            return _fallback(duration)
        return _compose(tail, head, sample_rate, duration=duration, tail_start=tail_start)

    samples = _decode(path, sample_rate)
    if samples is None or samples.size < sample_rate * 4:
        return _fallback(duration or (0.0 if samples is None else samples.size / sample_rate))
    return _compose(samples, samples, sample_rate, duration=samples.size / sample_rate, tail_start=0.0)


def _compose(
    tail,
    head,
    sample_rate: int,
    *,
    duration: float,
    tail_start: float,
) -> dict[str, Any]:
    """Build the stored analysis from the measured windows.

    `tail` carries the pulse, key and outro — everything a transition mixes
    *out* of. `head` only has to say where the music starts, which is what the
    next track mixes *into*.
    """
    import numpy as np

    features = _window_features(tail, sample_rate)
    if features is None:
        return _fallback(duration)
    head_features = features if head is tail else _window_features(head, sample_rate)
    period = features["period"]
    intro_local = head_features["intro"] if head_features is not None else 0.0

    def absolute_beats(window_features: Mapping[str, Any], offset: float) -> list[float]:
        return [
            offset + float(frame) * float(window_features["hop_seconds"])
            for frame in window_features["beat_frames"]
        ]

    beats = absolute_beats(features, tail_start)
    if tail_start and head_features is not None:
        beats = absolute_beats(head_features, 0.0) + beats
    beats = sorted({round(value, 6) for value in beats if 0 <= value <= duration})
    if not beats:
        beat_offset = tail_start + features["beat_offset"]
        beats = list(_frange(beat_offset, duration, period))

    # The strongest quarter-note phase is a much better downbeat proxy than
    # assuming the first onset in the file is beat one.
    strengths = features["beat_strengths"]
    downbeat_phase = max(
        range(4),
        key=lambda phase: sum(float(value) for value in strengths[phase::4]),
    ) if strengths else 0
    tail_beats = absolute_beats(features, tail_start)
    tail_downbeats = tail_beats[downbeat_phase::4]
    if tail_start and head_features is not None:
        head_strengths = head_features["beat_strengths"]
        head_phase = max(
            range(4),
            key=lambda phase: sum(float(value) for value in head_strengths[phase::4]),
        ) if head_strengths else 0
        downbeats = absolute_beats(head_features, 0.0)[head_phase::4] + tail_downbeats
    else:
        downbeats = tail_downbeats
    downbeats = sorted({round(value, 6) for value in downbeats if 0 <= value <= duration})

    # Eight bars is a useful phrase prior, but the additional section starts
    # below are derived from changes in measured bar energy and onset density.
    boundaries = list(downbeats[::8])
    sections = _sections_from_features(features, tail_start, duration, downbeats)
    if tail_start and head_features is not None:
        sections = _sections_from_features(head_features, 0.0, duration, downbeats) + sections
    boundaries.extend(float(section["start"]) for section in sections)
    boundaries = sorted({round(value, 3) for value in boundaries if 0 <= value < duration})
    beat_offset = beats[0]
    last_active = tail_start + features["last_active"]
    outro_limit = min(last_active, duration - period * 4)
    desired_outro = max(0.0, outro_limit - 64 * period)
    outro_candidates = [value for value in boundaries if desired_outro <= value <= outro_limit]
    outro = outro_candidates[0] if outro_candidates else max(0.0, duration - 32 * period)

    tempo_confidence = min(1.0, max(0.0, features["periodicity"]) * 4.0)
    confidence = min(0.98, 0.38 + tempo_confidence * 0.36 + min(0.2, features["key_margin"] / 8))
    return {
        "version": ANALYSER_VERSION,
        "duration": round(duration, 3),
        "bpm": round(features["bpm"], 3),
        "beat_offset": round(beat_offset, 3),
        "bar_seconds": round(period * 4, 3),
        "key": features["key"],
        "mode": features["mode"],
        "loudness_db": round(features["loudness_db"], 3),
        "energy": round(float(np.clip(features["energy"], 0, 1)), 3),
        "intro_cue": round(max(0.0, min(intro_local, duration * 0.25)), 3),
        "outro_cue": round(max(0.0, min(outro, duration - period * 4)), 3),
        "beat_grid": [round(float(value), 3) for value in beats],
        "downbeats": [round(float(value), 3) for value in downbeats],
        "phrase_boundaries": boundaries,
        "sections": sections,
        "tempo_confidence": round(tempo_confidence, 3),
        "confidence": round(confidence, 3),
        "analysed": True,
    }


def _frange(start: float, stop: float, step: float) -> Iterable[float]:
    value = max(0.0, start)
    while step > 0 and value <= stop:
        yield value
        value += step


def _sections_from_features(
    features: Mapping[str, Any],
    offset: float,
    duration: float,
    downbeats: list[float],
) -> list[dict[str, Any]]:
    """Describe measured eight-bar regions and their musical role."""
    import numpy as np

    local_downbeats = [value for value in downbeats if offset <= value < offset + float(features["window_seconds"])]
    starts = local_downbeats[::8]
    if not starts:
        return []
    hop_seconds = float(features["hop_seconds"])
    frame_energy = features["frame_energy"]
    flux = features["flux"]
    regions: list[tuple[float, float, float, float]] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else min(duration, offset + float(features["window_seconds"]))
        left = max(0, int((start - offset) / hop_seconds))
        right = max(left + 1, min(len(frame_energy), int((end - offset) / hop_seconds)))
        region_energy = float(np.mean(frame_energy[left:right])) if right > left else 0.0
        flux_right = max(left + 1, min(len(flux), right))
        onset = float(np.mean(flux[left:flux_right])) if flux_right > left else 0.0
        slope = float(frame_energy[right - 1] - frame_energy[left]) if right - left > 1 else 0.0
        regions.append((start, end, region_energy, onset + max(0.0, slope)))
    median_energy = max(1e-6, float(np.median([row[2] for row in regions])))
    result: list[dict[str, Any]] = []
    for index, (start, end, energy, motion) in enumerate(regions):
        ratio = energy / median_energy
        if index == 0 and ratio < 0.9:
            label = "intro"
        elif index == len(regions) - 1 and end >= duration - 1 and ratio < 0.95:
            label = "outro"
        elif ratio >= 1.18 and motion >= 0.35:
            label = "drop"
        elif ratio <= 0.72:
            label = "breakdown"
        elif motion >= 0.48:
            label = "build"
        else:
            label = "body"
        result.append({
            "start": round(float(start), 3),
            "end": round(float(end), 3),
            "label": label,
            "energy": round(max(0.0, min(1.5, energy)), 3),
        })
    return result


def _window_features(samples, sample_rate: int) -> dict[str, Any] | None:
    """Frame-level measures for one decoded window, in window-relative time."""
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
    # A broad 120 BPM prior only breaks ties between strong autocorrelation
    # peaks; the recording remains authoritative.
    candidate_indices = np.argsort(correlations)[-min(8, correlations.size):]
    best_index = max(
        (int(index) for index in candidate_indices),
        key=lambda index: float(correlations[index]) * (0.96 + 0.04 * math.exp(-abs((60 * sample_rate / ((min_lag + index) * hop)) - 120) / 35)),
    )
    best_lag = min_lag + best_index
    bpm = 60 * sample_rate / (best_lag * hop)
    period = 60.0 / bpm
    first_window = max(1, min(flux.size, best_lag * 2))
    seed = int(np.argmax(flux[:first_window]))
    beat_frames = _snap_beat_frames(flux, seed, best_lag)
    beat_offset = (beat_frames[0] + 1) * hop / sample_rate
    beat_strengths = [float(flux[min(frame_index, flux.size - 1)]) for frame_index in beat_frames]

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

    window_seconds = samples.size / sample_rate
    threshold = max(0.08, float(np.percentile(energy, 35)))
    active_frames = np.flatnonzero(energy >= threshold)
    intro = float(active_frames[0] * hop / sample_rate) if active_frames.size else 0.0
    last_active = float(active_frames[-1] * hop / sample_rate) if active_frames.size else window_seconds
    loudness_db = 20 * math.log10(max(float(np.sqrt(np.mean(samples * samples))), 1e-8))
    periodicity = float(max(0.0, correlations.max()) / (np.dot(centred, centred) + 1e-9))

    return {
        "bpm": float(bpm),
        "period": period,
        "beat_offset": beat_offset,
        "key": _KEY_NAMES[tonic],
        "mode": mode,
        "key_margin": key_margin,
        "loudness_db": loudness_db,
        "energy": float(np.mean(energy)),
        "intro": intro,
        "last_active": last_active,
        "periodicity": periodicity,
        "hop_seconds": hop / sample_rate,
        "window_seconds": window_seconds,
        "beat_frames": beat_frames,
        "beat_strengths": beat_strengths,
        "frame_energy": energy.tolist(),
        "flux": flux.tolist(),
    }


def _snap_beat_frames(flux, seed: int, lag: int) -> list[int]:
    """Follow the tempo while snapping every beat to a nearby real onset."""
    import numpy as np

    if flux.size == 0:
        return []
    radius = max(1, lag // 5)
    frames = [max(0, min(int(seed), flux.size - 1))]

    def next_peak(predicted: int) -> int:
        left = max(0, predicted - radius)
        right = min(flux.size, predicted + radius + 1)
        if right <= left:
            return max(0, min(predicted, flux.size - 1))
        positions = np.arange(left, right)
        distance_cost = np.abs(positions - predicted) / max(1, radius)
        return int(positions[int(np.argmax(flux[left:right] - distance_cost * 0.16))])

    cursor = frames[0]
    while cursor + lag < flux.size:
        cursor = next_peak(cursor + lag)
        if cursor <= frames[-1]:
            cursor = frames[-1] + 1
        frames.append(cursor)
    before: list[int] = []
    cursor = frames[0]
    while cursor - lag >= 0:
        cursor = next_peak(cursor - lag)
        if before and cursor >= before[-1]:
            break
        before.append(cursor)
    return sorted(set(before + frames))


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


def _nearest_grid_point(
    analysis: Mapping[str, Any],
    target: float,
    *,
    prefer_downbeat: bool = True,
) -> float:
    grid = analysis.get("downbeats") if prefer_downbeat else analysis.get("beat_grid")
    if not isinstance(grid, list) or not grid:
        grid = analysis.get("beat_grid")
    values = [float(value) for value in grid or [] if isinstance(value, (int, float))]
    return min(values, key=lambda value: abs(value - target)) if values else target


def _grid_point_at_or_before(analysis: Mapping[str, Any], limit: float) -> float:
    grid = analysis.get("downbeats") or analysis.get("beat_grid") or []
    values = [
        float(value)
        for value in grid
        if isinstance(value, (int, float)) and float(value) <= limit
    ]
    return max(values) if values else limit


def _local_period(analysis: Mapping[str, Any], cue: float) -> float:
    grid = [
        float(value)
        for value in analysis.get("beat_grid") or []
        if isinstance(value, (int, float)) and abs(float(value) - cue) <= 24
    ]
    intervals = [right - left for left, right in zip(grid, grid[1:]) if 0.25 <= right - left <= 1.2]
    if intervals:
        intervals.sort()
        return intervals[len(intervals) // 2]
    bpm = float(analysis.get("bpm") or 0)
    return 60 / bpm if bpm > 0 else max(0.25, float(analysis.get("bar_seconds") or 2) / 4)


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
    # `None` means "place it against the real duration". The player knows what it
    # actually loaded; a cue invented here from an unknown length is worse than
    # no cue at all, because it looks authoritative.
    outro = outgoing.get("outro_cue")
    if outro is None and not duration:
        out_cue = None
    else:
        proposed_out = float(outro if outro is not None else max(0.0, duration - overlap))
        out_cue = min(proposed_out, max(0.0, duration - overlap - 0.5)) if duration else proposed_out
    if out_cue is not None and outgoing.get("analysed"):
        out_cue = _nearest_grid_point(outgoing, float(out_cue))
        if duration:
            latest = max(0.0, duration - overlap - 0.5)
            if out_cue > latest:
                out_cue = _grid_point_at_or_before(outgoing, latest)
    in_cue = float(incoming.get("intro_cue") or 0)
    if incoming.get("analysed"):
        in_cue = _nearest_grid_point(incoming, in_cue)

    out_period = _local_period(outgoing, float(out_cue or 0))
    in_period = _local_period(incoming, in_cue)
    # playbackRate scales the incoming tempo. A 125 BPM incoming track needs
    # 120/125 = 0.96 to sit on a 120 BPM outgoing grid.
    local_ratio = in_period / out_period if out_period > 0 and in_period > 0 else ratio
    if local_ratio < 0.7:
        local_ratio *= 2
    elif local_ratio > 1.4:
        local_ratio /= 2
    # Above six percent, resampling is more audible than a structural cut. The
    # score can still select a safe technique, but never asks the player to
    # torture a recording merely to claim that it beatmatched.
    playback_rate = local_ratio if abs(1 - local_ratio) <= min(0.06, float(policy["max_stretch"])) else 1.0
    if technique not in {"bass_swap", "long_blend", "filter_blend"}:
        playback_rate = 1.0
    return {
        "technique": technique,
        "out_cue": round(out_cue, 3) if out_cue is not None else None,
        "in_cue": round(in_cue, 3),
        "overlap_seconds": round(overlap, 3),
        "overlap_bars": bars,
        "playback_rate": round(playback_rate, 5),
        "score": round(blend_score, 3),
        "confidence": round(confidence, 3),
        "fallback": technique in {"echo_cut", "safe_fade", "structural_fade"},
        "sync": {
            "out_period": round(out_period, 6),
            "in_period": round(in_period, 6),
            "phase_tolerance_ms": 5,
            "grid_source": "measured" if outgoing.get("beat_grid") and incoming.get("beat_grid") else "estimated",
        },
        "automation": {
            "curve": "equal_power",
            "eq": "bass_swap" if technique in {"bass_swap", "long_blend"} else "neutral",
            "filter": technique in {"filter_blend", "long_blend"},
            "echo_out": technique == "echo_cut",
        },
    }


def order_route(
    current_analysis: Mapping[str, Any],
    candidates: Iterable[tuple[dict[str, Any], Mapping[str, Any]]],
    *,
    profile: str,
    limit: int = 3,
    source_sequence: Iterable[str] | None = None,
    source_offset: int = 0,
) -> list[dict[str, Any]]:
    """Greedy lookahead over transition quality and recommendation relevance.

    Missing analysis is an absence of evidence, not evidence of a bad song.
    Treating its conservative fallback as measured compatibility made every
    cold external candidate lose to tracks already downloaded by an earlier
    session, creating a self-reinforcing cache loop.
    """
    remaining = list(candidates)
    route: list[dict[str, Any]] = []
    previous = current_analysis
    sequence = tuple(source_sequence or ())
    while remaining and len(route) < limit:
        preferred = sequence[(source_offset + len(route)) % len(sequence)] if sequence else None
        eligible = (
            [row for row in remaining if row[0].get("source_pool") == preferred]
            if preferred
            else remaining
        )
        if not eligible:
            eligible = remaining
        scored = []
        for index, (item, analysis) in enumerate(eligible):
            transition = plan_transition(previous, analysis, profile=profile)
            relevance = max(0.0, min(1.0, float(item.get("score") or 0.5)))
            transition_quality = (
                float(transition["score"])
                if previous.get("analysed", True) and analysis.get("analysed", True)
                else 0.62
            )
            semantic = max(0.0, min(1.0, float(item.get("semantic_score") or 0.5)))
            score = transition_quality * 0.42 + semantic * 0.38 + relevance * 0.20
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
    max_starts: int = 5,
) -> list[dict[str, Any]]:
    """Reach the request in positions 2–6, preferring position 2.

    The currently playing song is position one. A bridge is admitted only when
    it materially improves safety; otherwise the explicit request is next.
    """
    bridge_rows = list(bridges)[:12]
    requested_item, requested_analysis = requested
    best_score = float(plan_transition(current_analysis, requested_analysis, profile=profile)["score"])
    best: tuple[tuple[dict[str, Any], Mapping[str, Any]], ...] = (requested,)
    max_bridges = max(0, min(4, max_starts - 1))
    # Beam search bounds the four-bridge case while retaining musically strong
    # paths. Delaying costs progressively more, hence "next" remains preferred.
    beam: list[tuple[float, tuple[tuple[dict[str, Any], Mapping[str, Any]], ...], Mapping[str, Any], frozenset[int]]] = [
        (0.0, (), current_analysis, frozenset())
    ]
    for count in range(1, max_bridges + 1):
        expanded = []
        for accumulated, prefix, previous, used in beam:
            for index, row in enumerate(bridge_rows):
                if index in used:
                    continue
                quality = float(plan_transition(previous, row[1], profile=profile)["score"])
                expanded.append((accumulated + quality, (*prefix, row), row[1], used | {index}))
        expanded.sort(key=lambda state: state[0], reverse=True)
        beam = expanded[:48]
        for accumulated, prefix, previous, _ in beam:
            final_quality = float(plan_transition(previous, requested_analysis, profile=profile)["score"])
            sequence_quality = (accumulated + final_quality) / (count + 1)
            delay_cost = 0.055 * count + 0.012 * count * count
            score = sequence_quality - delay_cost
            if score > best_score + 0.015:
                best_score = score
                best = (*prefix, requested)
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
