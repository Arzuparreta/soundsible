"""Transition-aware analysis and route planning for Auto Mode.

The engine deliberately stores *features*, never decoded audio.  FFmpeg writes
mono float samples to stdout, the analyser consumes them in memory, and the
only durable artifact is a small, versioned SQLite cache.
"""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import sqlite3
import subprocess
import sys
import threading
import time
from collections.abc import Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from shared.ffmpeg_runtime import ffmpeg_executable
from shared.runtime import get_cache_dir

ANALYSER_VERSION = 6
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
# Seconds kept between a planned blend start and `duration - overlap`.
_OUT_CUE_MARGIN = 1.5
# Spectral flatness is read where music has its harmonics. Frames more than
# 20 dB under the song's loud level (fades, gaps) and windows quieter than
# -80 dBFS say nothing about how the music sounds.
_FLATNESS_BAND = (100.0, 5000.0)
_LOUD_FRAME_RATIO = 0.1
_SILENT_RMS = 1e-4
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
    with _pending_lock:
        if _pool is None:
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
    return _decode_measured(path, sample_rate, start=start, length=length)[0]


def _decode_measured(path: Path, sample_rate: int, *, start: float = 0.0, length: float = 0.0):
    """Mono float PCM of one window, and its integrated loudness in LUFS.

    The loudness comes from FFmpeg's EBU R128 meter on the original channels
    and sample rate, in the same pass: the meter on a branch of the decoded
    stream that ends in a sink, the PCM on the other. The PCM is the same,
    sample for sample, as a decode without the meter. Returns (None, None) on
    any failure and a None loudness when the meter has no reading (silence,
    under one 400 ms gating block).
    """
    try:
        import numpy as np
    except ImportError:
        return None, None
    from shared.loudness.measure import parse_integrated_loudness

    command = [ffmpeg_executable(), "-nostdin", "-hide_banner", "-nostats", "-v", "info"]
    if start > 0:
        # Before -i, so FFmpeg seeks instead of decoding and discarding.
        command += ["-ss", f"{start:.3f}"]
    command += ["-i", str(path)]
    if length > 0:
        command += ["-t", f"{length:.3f}"]
    command += [
        "-filter_complex", "[0:a:0]asplit=2[meter][pcm];[meter]ebur128=framelog=quiet,anullsink",
        "-map", "[pcm]",
        "-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "f32le", "pipe:1",
    ]
    try:
        proc = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError):
        return None, None
    lufs = parse_integrated_loudness((proc.stderr or b"").decode("utf-8", "ignore"))
    return np.frombuffer(proc.stdout, dtype="<f4"), lufs


def _analyse_pcm(path: Path, *, duration_hint: float) -> dict[str, Any]:
    sample_rate = 11025
    duration = float(duration_hint or 0)
    if duration <= 0:
        duration = _probe_duration(path)

    if duration > WINDOWED_ABOVE_SECONDS:
        head, head_lufs = _decode_measured(path, sample_rate, length=HEAD_WINDOW_SECONDS)
        tail_start = max(0.0, duration - TAIL_WINDOW_SECONDS)
        tail, tail_lufs = _decode_measured(path, sample_rate, start=tail_start, length=TAIL_WINDOW_SECONDS)
        if tail is None or tail.size < sample_rate * 4:
            return _fallback(duration)
        lufs = _combined_lufs([(head_lufs, HEAD_WINDOW_SECONDS), (tail_lufs, TAIL_WINDOW_SECONDS)])
        return _compose_off_loop(
            tail, head, sample_rate, duration=duration, tail_start=tail_start, loudness_lufs=lufs,
        )

    samples, lufs = _decode_measured(path, sample_rate)
    if samples is None or samples.size < sample_rate * 4:
        return _fallback(duration or (0.0 if samples is None else samples.size / sample_rate))
    return _compose_off_loop(
        samples, samples, sample_rate, duration=samples.size / sample_rate, tail_start=0.0, loudness_lufs=lufs,
    )


def _combined_lufs(windows: list[tuple[float | None, float]]) -> float | None:
    """Integrated loudness of several measured windows, as one programme.

    Loudness adds as power, weighted by duration (BS.1770). This is the mean
    of the two windows a long mix is measured over, not of the whole mix.
    """
    measured = [(lufs, seconds) for lufs, seconds in windows if lufs is not None and seconds > 0]
    if not measured:
        return None
    seconds = sum(length for _, length in measured)
    power = sum(length * 10 ** ((lufs + 0.691) / 10) for lufs, length in measured)
    return -0.691 + 10 * math.log10(power / seconds)


def _compose_off_loop(tail, head, sample_rate: int, *, duration: float, tail_start: float,
                      loudness_lufs: float | None = None):
    # The daemon monkey-patches threading: its concurrent.futures workers are
    # greenlets, so NumPy on those workers otherwise stalls every HTTP request.
    # Offload only pure PCM computation. SQLite and cooperative subprocess I/O
    # stay on their owning thread; the two analysis jobs still bound concurrency.
    args = (tail, head, sample_rate)
    kwargs = {"duration": duration, "tail_start": tail_start, "loudness_lufs": loudness_lufs}
    # Plain CLI/desktop analyses do not need to initialize gevent at all.
    monkey = sys.modules.get("gevent.monkey")
    if monkey is not None and monkey.is_module_patched("threading"):
        from gevent import get_hub

        return get_hub().threadpool.apply(_compose, args, kwargs)
    return _compose(*args, **kwargs)


def _compose(
    tail,
    head,
    sample_rate: int,
    *,
    duration: float,
    tail_start: float,
    loudness_lufs: float | None = None,
) -> dict[str, Any]:
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
    intro_local = head_features["intro"] if head_features is not None else 0.0

    def window_grid(window_features: Mapping[str, Any], offset: float) -> tuple[list[float], list[float]]:
        beats = [offset + float(value) for value in window_features["beats"]]
        return beats, beats[int(window_features["downbeat_phase"]):][::4]

    beats, downbeats = window_grid(features, tail_start)
    if tail_start and head_features is not None:
        head_beats, head_downbeats = window_grid(head_features, 0.0)
        # The windows are measured apart; neither grid is extended across the gap.
        beats = [value for value in head_beats if value < tail_start] + beats
        downbeats = [value for value in head_downbeats if value < tail_start] + downbeats
    beats = [value for value in beats if 0 <= value <= duration]
    downbeats = [value for value in downbeats if 0 <= value <= duration]

    # Eight bars is a useful phrase prior, but the additional section starts
    # below are derived from changes in measured bar energy and onset density.
    boundaries = list(downbeats[::8])
    sections = _sections_from_features(features, tail_start, duration, downbeats)
    if tail_start and head_features is not None:
        sections = _sections_from_features(head_features, 0.0, duration, downbeats) + sections
    boundaries.extend(float(section["start"]) for section in sections)
    boundaries = sorted({round(value, 3) for value in boundaries if 0 <= value < duration})
    beat_offset = beats[0] if beats else 0.0
    last_active = tail_start + features["last_active"]
    outro_limit = min(last_active, duration - period * 4)
    desired_outro = max(0.0, outro_limit - 64 * period)
    outro_candidates = [value for value in boundaries if desired_outro <= value <= outro_limit]
    outro = outro_candidates[0] if outro_candidates else max(0.0, duration - 32 * period)

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
        "intro_cue": round(max(0.0, min(intro_local, duration * 0.25)), 3),
        "outro_cue": round(max(0.0, min(outro, duration - period * 4)), 3),
        # Tenths of a millisecond: the mixers align these points to the sample.
        "beat_grid": [round(float(value), 4) for value in beats],
        "downbeats": [round(float(value), 4) for value in downbeats],
        "phrase_boundaries": boundaries,
        "sections": sections,
        "tempo_confidence": round(tempo_confidence, 3),
        "confidence": round(confidence, 3),
        "analysed": True,
    }


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
    # The grid reaches the last sample; the frames stop one frame short of it.
    starts = [start for start in starts if int((start - offset) / hop_seconds) < min(len(frame_energy), len(flux))]
    if not starts:
        return []
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
            # Mean frame level against the song's loud level, not between songs.
            "level": round(max(0.0, min(1.5, energy)), 3),
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
    # Only the mean spectrum and adjacent-frame flux survive this calculation.
    # Keep a small FFT working set instead of several full-song matrices (over
    # 400 MiB for an eight-minute track, multiplied by concurrent analyses).
    frequencies = np.fft.rfftfreq(frame, 1 / sample_rate)
    band = np.searchsorted(frequencies, _FLATNESS_BAND)
    rms, mean_spectrum, flux, flatness = _spectral_features(frames, flatness_bins=slice(int(band[0]), int(band[1])))
    loud_level = float(np.percentile(rms, 95))
    # Level against the song's own loud level: where it starts and how its
    # sections rise and fall. Not comparable between songs.
    energy = rms / max(loud_level, 1e-7)
    loud = rms >= loud_level * _LOUD_FRAME_RATIO if loud_level >= _SILENT_RMS else np.zeros(rms.size, dtype=bool)
    loud_weights = rms[loud].astype(float) ** 2
    note_count, sounding_seconds = _note_onsets(samples, sample_rate)
    flux /= max(float(np.percentile(flux, 95)), 1e-7)
    rhythm = _rhythm(samples, sample_rate)

    # A compact chroma estimator.  It is deliberately confidence-gated: the
    # route planner treats uncertain keys as neutral rather than inventing a
    # harmonic incompatibility.
    chroma = np.zeros(12, dtype=float)
    valid = frequencies > 55
    midi = np.rint(69 + 12 * np.log2(np.maximum(frequencies[valid], 1e-6) / 440)).astype(int)
    bins = np.mod(midi, 12)
    mean_spectrum = mean_spectrum[valid]
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

    return {
        # Without a measurable pulse (silence, a drone) the tempo is reported
        # as unknown, 0 BPM, like an unmeasured song's; no grid is invented.
        # The structural cues below still need a beat length: 120 BPM is
        # only a unit there.
        "bpm": rhythm["bpm"] if rhythm else 0.0,
        "period": rhythm["period"] if rhythm else 0.5,
        "beats": rhythm["beats"] if rhythm else [],
        "downbeat_phase": rhythm["downbeat_phase"] if rhythm else 0,
        "tempo_confidence": rhythm["tempo_confidence"] if rhythm else 0.0,
        "key": _KEY_NAMES[tonic],
        "mode": mode,
        "key_margin": key_margin,
        "note_count": note_count,
        "sounding_seconds": sounding_seconds,
        "flatness_power": float(np.dot(flatness[loud], loud_weights)),
        "loud_power": float(loud_weights.sum()),
        "intro": intro,
        "last_active": last_active,
        "hop_seconds": hop / sample_rate,
        "window_seconds": window_seconds,
        "frame_energy": energy.tolist(),
        "flux": flux.tolist(),
    }


def _spectral_features(frames, *, flatness_bins: slice = slice(1, None)):
    """Same per-frame measures as a whole-matrix FFT, with bounded scratch space.

    Returns per-frame RMS, the mean magnitude spectrum, the positive spectral
    flux between frames, and per-frame spectral flatness (geometric over
    arithmetic mean of the power) across `flatness_bins`.
    """
    import numpy as np

    count, frame_size = frames.shape
    rms = np.empty(count, dtype=frames.dtype if frames.dtype.kind == "f" else float)
    flux = np.empty(max(0, count - 1), dtype=float)
    flatness = np.empty(count, dtype=float)
    spectrum_sum = np.zeros(frame_size // 2 + 1, dtype=float)
    window = np.hanning(frame_size)
    previous = None
    for start in range(0, count, 256):
        block = frames[start:start + 256]
        end = start + len(block)
        rms[start:end] = np.sqrt(np.mean(block * block, axis=1) + 1e-12)
        spectrum = np.abs(np.fft.rfft(block * window, axis=1))
        spectrum_sum += spectrum.sum(axis=0)
        power = spectrum[:, flatness_bins] ** 2 + 1e-12
        flatness[start:end] = np.exp(np.log(power).mean(axis=1)) / power.mean(axis=1)
        if previous is not None:
            flux[start - 1] = np.maximum(0.0, spectrum[0] - previous).sum()
        flux[start:end - 1] = np.maximum(0.0, np.diff(spectrum, axis=0)).sum(axis=1)
        previous = spectrum[-1].copy()
    return rms, spectrum_sum / count, flux, flatness


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


def _rhythm(samples, sample_rate: int) -> dict[str, Any] | None:
    """Tempo, beat grid and bar phase of one window, in window-relative seconds."""
    import numpy as np

    measured = _rhythm_stft(samples, sample_rate)
    if measured is None:
        return None
    onset, chroma, centre = measured
    frame_rate = sample_rate / _RHYTHM_HOP
    lag = _tempo_lag(onset, frame_rate)
    if lag is None:
        return None
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
    return {
        "bpm": 60.0 / beat,
        "period": beat,
        "beats": grid.tolist(),
        "downbeat_phase": _downbeat_phase(samples, sample_rate, grid, chroma, centre),
        "tempo_confidence": float(np.clip((reliability - 0.4) / 0.5, 0.0, 1.0)),
        "grid": "constant" if constant else "local",
    }


def _rhythm_stft(samples, sample_rate: int):
    """Onset strength and chroma from one bounded float32 STFT pass.

    `onset[k]` is the mean rise of log energy in 24 log-spaced bands into frame
    `k`; every band counts alike, so a quiet hi-hat and a loud bass note mark
    time equally. Returns (onset, chroma, offset of a frame's centre).
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
    return onset, chroma, _RHYTHM_FRAME / 2


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
    # Binary metre: the beat also repeats at the half bar and the bar. Integer
    # multiples of an integer lag miss those sharp peaks, so take the strongest
    # value within three frames.
    reach = np.lib.stride_tricks.sliding_window_view(np.pad(acf, 3, constant_values=-1.0), 7).max(axis=1)
    bpm = 60 * frame_rate / lags
    prior = np.exp(-0.5 * (np.log2(bpm / 120.0) / 0.9) ** 2)
    score = (acf[lags] + 0.5 * reach[2 * lags] + 0.25 * reach[4 * lags]) * prior
    best = int(np.argmax(score))
    lag = float(lags[best])
    if 0 < best < lags.size - 1:
        left, centre, right = score[best - 1], score[best], score[best + 1]
        curvature = left - 2 * centre + right
        if curvature < 0:
            lag += 0.5 * (left - right) / curvature
    return lag


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


def _downbeat_phase(samples, sample_rate: int, grid, chroma, centre: float) -> int:
    """Which of every four beats starts the bar.

    Bars start where the harmony changes and where the loudest hits land; on
    songs whose beat grid was confirmed independently this chose the reference
    downbeat almost twice as often as onset strength alone.
    """
    import numpy as np

    if grid.size < 8:
        return 0
    offsets, rows, usable = _attack_curves(
        samples, sample_rate, grid, _attack_floor(samples, 0.0), emphasis=0.0, window=0.015,
    )
    strength = np.zeros(grid.size)
    if rows.size:
        strength[usable] = rows.max(axis=1)
    frames = np.clip(np.rint((grid * sample_rate - centre) / _RHYTHM_HOP).astype(int), 0, chroma.shape[0] - 1)
    cumulative = np.vstack([np.zeros((1, 12)), np.cumsum(chroma, axis=0, dtype=np.float64)])
    before = cumulative[frames[2:-2]] - cumulative[frames[:-4]]
    after = cumulative[frames[4:]] - cumulative[frames[2:-2]]
    norms = np.linalg.norm(before, axis=1) * np.linalg.norm(after, axis=1)
    novelty = np.zeros(grid.size)
    novelty[2:-2] = np.where(norms > 0, 1 - (before * after).sum(axis=1) / np.where(norms > 0, norms, 1.0), 0.0)

    def standard(values):
        spread = float(np.std(values))
        return (values - float(np.mean(values))) / spread if spread > 0 else np.zeros_like(values)

    score = standard(novelty) + standard(strength)
    return int(max(range(4), key=lambda phase: float(np.mean(score[phase::4]))))


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


def _local_period(analysis: Mapping[str, Any], cue: float, span: float = 0.0) -> float:
    """Seconds per beat across [cue, cue + span], from a line through the grid there.

    The median of neighbouring intervals cannot resolve a tempo difference
    smaller than the grid's rounding; a line through a few dozen beats can, and
    it follows a drifting performance over the stretch actually being mixed.
    """
    bpm = float(analysis.get("bpm") or 0)
    coarse = 60 / bpm if bpm > 0 else max(0.25, float(analysis.get("bar_seconds") or 2) / 4)
    grid = analysis.get("beat_grid") or []
    lo = bisect.bisect_left(grid, cue - 2 * coarse)
    hi = bisect.bisect_right(grid, cue + max(span, 16 * coarse) + 2 * coarse)
    points = [float(value) for value in grid[lo:hi]]
    if len(points) < 4:
        return coarse
    numbers = [0]
    for left, right in zip(points, points[1:]):
        numbers.append(numbers[-1] + max(1, round((right - left) / coarse)))
    mean_x = sum(numbers) / len(numbers)
    mean_y = sum(points) / len(points)
    variance = sum((x - mean_x) ** 2 for x in numbers)
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(numbers, points)) / variance if variance else 0.0
    return slope if slope > 0 else coarse


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
    # Both players start their blend no later than one second before
    # `duration - overlap`, and move a later cue (`resolveTransition`,
    # `ProgramDjPlan.resolve`). The extra half second absorbs the difference
    # between this measured duration and the one the player loaded, so a
    # measured downbeat reaches the mix unmoved.
    latest = max(0.0, duration - overlap - _OUT_CUE_MARGIN)
    if outro is None and not duration:
        out_cue = None
    else:
        proposed_out = float(outro if outro is not None else max(0.0, duration - overlap))
        out_cue = min(proposed_out, latest) if duration else proposed_out
    if out_cue is not None and outgoing.get("analysed"):
        out_cue = _nearest_grid_point(outgoing, float(out_cue))
        if duration and out_cue > latest:
            out_cue = _grid_point_at_or_before(outgoing, latest)
    in_cue = float(incoming.get("intro_cue") or 0)
    if incoming.get("analysed"):
        in_cue = _nearest_grid_point(incoming, in_cue)

    # The tempo across the stretch that is actually mixed, not at one point.
    out_period = _local_period(outgoing, float(out_cue or 0), overlap)
    in_period = _local_period(incoming, in_cue, overlap)
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
        "out_cue": round(out_cue, 4) if out_cue is not None else None,
        "in_cue": round(in_cue, 4),
        "overlap_seconds": round(overlap, 3),
        "overlap_bars": bars,
        # Over a 48 s overlap, 1e-6 of rate error is 0.05 ms of drift.
        "playback_rate": round(playback_rate, 6),
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
