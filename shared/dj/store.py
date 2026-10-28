"""Versioned analysis identity, SQLite, bounded decoding and background acquisition.

Inside the engine every measurement runs in the analysis process
(`worker`); this module keeps the cache, the identities and the queue. Tools
and tests that never start that process measure in their own.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import sqlite3
import subprocess
import threading
import time
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from shared.ffmpeg_runtime import ffmpeg_executable
from shared.runtime import get_cache_dir
from shared import work

from . import beat_model, weights
from .worker import AnalysisFailed, AnalysisProcess
from .analysis import _compose, decimate
from .contracts import ANALYSER_VERSION, Analysis, fallback_analysis as _fallback

logger = logging.getLogger(__name__)

# A normal song is decoded in full so the grid and the musical sections come
# from the recording, not from arithmetic projected from its first transient.
# Very long mixes remain bounded: their head and tail still provide everything
# needed for a safe hand-off without monopolising the background analyser.
WINDOWED_ABOVE_SECONDS = 480.0
HEAD_WINDOW_SECONDS = 90.0
TAIL_WINDOW_SECONDS = 120.0


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
    # Preview mtime is an LRU clock: serving a Range touches it. The commit's
    # revision identifies its bytes and also changes on a layout replacement.
    if path.parent == get_cache_dir() / "previews" and path.suffix == ".audio":
        try:
            meta = json.loads(path.with_suffix(".meta.json").read_text())
            if meta.get("revision"):
                return f"{stat.st_size}:{meta['revision']}"
        except (OSError, ValueError, AttributeError):
            pass
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def cached_analysis(path: str | Path, identity: str) -> Analysis | None:
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


def analyse_audio(path: str | Path, identity: str, *, duration_hint: float = 0.0) -> Analysis:
    """Analyse one local/cached audio source, returning cached data when valid."""
    source = Path(path)
    if not source.is_file():
        return _fallback(duration_hint)
    cached = cached_analysis(source, identity)
    if cached is not None:
        return cached
    stamp = _source_stamp(source)
    analysis = _measure_source(source, identity, duration_hint)
    if analysis is None:
        # No beat model yet (weights downloading or unavailable). Measuring
        # without it would cache a song as pulseless for this version.
        return _fallback(duration_hint)
    if _source_stamp(source) != stamp:
        return _fallback(duration_hint)
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


_process: AnalysisProcess | None = None
# identity -> source stamp of a file the analysis process could not measure.
# Not retried until the file changes or the engine restarts: a song that
# crashes or stalls the process would otherwise cost a full timeout on every
# library pass.
_unmeasurable: dict[str, str] = {}


def start_analysis_process() -> None:
    """Measure in a separate process from now on. The engine calls this at startup."""
    global _process
    if _process is None:
        _process = AnalysisProcess()


def stop_analysis_process() -> None:
    global _process
    process, _process = _process, None
    if process is not None:
        process.close()


def _measure_source(source: Path, identity: str, duration_hint: float) -> Analysis | None:
    process = _process
    if process is None:
        return _analyse_pcm(source, duration_hint=duration_hint)
    try:
        stamp = _source_stamp(source)
    except OSError:
        return None
    if _unmeasurable.get(identity) == stamp:
        return None
    try:
        job = work.current_job()
        with work.cancelling(lambda: process.cancel(job)):
            analysis = process.measure(source, duration_hint)
        work.check()
    except AnalysisFailed as exc:
        work.check()  # cancellation is not evidence of a broken recording
        _unmeasurable[identity] = stamp
        logger.warning("DJ analysis of %s failed: %s", source.name, exc)
        return None
    _unmeasurable.pop(identity, None)
    return analysis


_pending_lock = threading.Lock()


_pool: ThreadPoolExecutor | None = None
_pending: set[str] = set()
_jobs: work.Executor | None = None


def _analysis_pool() -> ThreadPoolExecutor:
    global _pool, _jobs
    with _pending_lock:
        if _pool is None:
            # One job: the analysis process measures one song at a time.
            _jobs = work.Executor("dj-analysis", 1)
            _pool = _jobs.pool
    return _pool


def requests_waiting() -> bool:
    """Whether songs a DJ session asked for are queued or being measured.

    The production engine only asks on behalf of live DJ sessions; a manual
    maintenance caller can use this to yield to their pending measurements.
    """
    with _pending_lock:
        return bool(_pending)


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
        if identity not in _pending and len(_pending) >= 64:
            return
        _pending.add(identity)

    def run() -> None:
        try:
            analyse_audio(source, identity, duration_hint=duration_hint)
        except work.WorkCancelled:
            raise
        except Exception:
            pass
        finally:
            with _pending_lock:
                _pending.discard(identity)

    try:
        _analysis_pool()
        future = _jobs.submit(identity, run)
        def finished(_):
            with _pending_lock:
                _pending.discard(identity)
        future.add_done_callback(finished)
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


def _analyse_pcm(path: Path, *, duration_hint: float) -> Analysis | None:
    """Decode once at the beat model's rate and measure; None without the model."""
    session = weights.session()
    if session is None:
        return None
    sample_rate = beat_model.SAMPLE_RATE
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
        events = (beat_model.events(session, tail),
                  beat_model.events(session, head) if head is not None and head.size >= sample_rate * 4 else None)
        return _measure(
            tail, head, sample_rate, duration=duration, tail_start=tail_start, loudness_lufs=lufs, events=events,
        )

    samples, lufs = _decode_measured(path, sample_rate)
    if samples is None or samples.size < sample_rate * 4:
        return _fallback(duration or (0.0 if samples is None else samples.size / sample_rate))
    window = beat_model.events(session, samples)
    return _measure(
        samples, samples, sample_rate, duration=samples.size / sample_rate, tail_start=0.0,
        loudness_lufs=lufs, events=(window, window),
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


def _measure(tail, head, sample_rate: int, **kwargs):
    """Decimate the decoded windows to the measures' 11025 Hz and compose."""
    if sample_rate == beat_model.SAMPLE_RATE:
        tail11 = decimate(tail)
        head11 = tail11 if head is tail else (decimate(head) if head is not None else None)
        tail, head, sample_rate = tail11, head11, sample_rate // 2
    return _compose(tail, head, sample_rate, **kwargs)


def analysis_identity(item: Mapping[str, object]) -> str:
    raw = (
        str(item.get("track_id") or "")
        or str(item.get("youtube_id") or item.get("id") or "")
        or f"{item.get('artist', '')}:{item.get('title', '')}"
    )
    return hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()
