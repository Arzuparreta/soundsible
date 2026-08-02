"""Durable cache of per-file loudness measurements.

Keyed by content identity, so a file measured once serves every account on the
instance. Lives in the config directory rather than the cache directory on
purpose: a full sweep of a large library costs about an hour of CPU, and that
must survive somebody clearing caches.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from collections.abc import Sequence
from pathlib import Path

from shared.database import BUSY_TIMEOUT_MS
from shared.runtime import get_config_dir

from .measure import LOUDNESS_VERSION, LoudnessMeasurement

logger = logging.getLogger(__name__)

#: Retry schedule for files that failed to measure. A file that is simply
#: broken must not be retried forever, and a file that failed because the disk
#: was busy deserves another look tomorrow.
RETRY_BACKOFF_SEC = (3600, 6 * 3600, 24 * 3600)
MAX_ATTEMPTS = len(RETRY_BACKOFF_SEC)

STATUS_OK = "ok"
STATUS_UNMEASURABLE = "unmeasurable"
STATUS_FAILED = "failed"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS track_loudness (
    identity        TEXT NOT NULL,
    version         INTEGER NOT NULL,
    source_stamp    TEXT NOT NULL,
    lufs            REAL,
    peak_dbtp       REAL,
    lra             REAL,
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (identity, version)
)
"""

_CONNECTIONS = threading.local()


def loudness_db_path() -> Path:
    return get_config_dir() / "loudness.sqlite3"


def source_stamp(path: Path) -> str:
    """What makes a stored measurement belong to the bytes on disk right now."""
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def identity_for(track) -> str:
    """The content key a measurement is filed under.

    `file_hash` first: a lossless upgrade rewrites the audio under the same
    track id, and the hash is what actually tracks the bytes.
    """
    return str(getattr(track, "file_hash", None) or getattr(track, "id", "") or "")


def _connect() -> sqlite3.Connection:
    """This thread's connection.

    Thread-local and reused, following `shared/dj_engine.py`: the sweep, the
    request path and the download hook all reach this store, and opening a
    connection costs a file open plus three PRAGMA round trips. `busy_timeout`
    is set first because it is per-connection and always succeeds, whereas the
    `journal_mode` switch below needs a lock no reader will yield without it.
    """
    path = loudness_db_path()
    existing = getattr(_CONNECTIONS, "conn", None)
    if existing is not None and getattr(_CONNECTIONS, "path", None) == path:
        return existing
    if existing is not None:
        existing.close()

    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        # WAL is a property of the file: another connection already set it.
        pass
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(_SCHEMA)
    conn.commit()
    _CONNECTIONS.conn = conn
    _CONNECTIONS.path = path
    return conn


def reset_connections() -> None:
    """Drop this thread's handle — for tests that move the config directory."""
    existing = getattr(_CONNECTIONS, "conn", None)
    if existing is not None:
        try:
            existing.close()
        except sqlite3.Error:
            pass
    _CONNECTIONS.conn = None
    _CONNECTIONS.path = None


class LoudnessStore:
    """Measurements, and the bookkeeping for the ones still to be taken."""

    def measured(self) -> dict[str, tuple[float, float]]:
        """Every usable reading, as ``identity -> (lufs, peak_dbtp)``.

        Fetched whole rather than by `IN (…)`: at five thousand tracks the table
        is a couple of hundred kilobytes, which is smaller than the library
        payload it decorates by more than an order of magnitude, and pulling it
        in one query removes all the chunking.
        """
        rows = _connect().execute(
            "SELECT identity, lufs, peak_dbtp FROM track_loudness "
            "WHERE version = ? AND status = ? AND lufs IS NOT NULL AND peak_dbtp IS NOT NULL",
            (LOUDNESS_VERSION, STATUS_OK),
        ).fetchall()
        return {row["identity"]: (row["lufs"], row["peak_dbtp"]) for row in rows}

    def get(self, identity: str) -> sqlite3.Row | None:
        return _connect().execute(
            "SELECT * FROM track_loudness WHERE identity = ? AND version = ?",
            (identity, LOUDNESS_VERSION),
        ).fetchone()

    def is_current(self, identity: str, stamp: str) -> bool:
        """Whether this exact file already has a verdict we can stand behind."""
        row = self.get(identity)
        if row is None or row["source_stamp"] != stamp:
            return False
        if row["status"] in (STATUS_OK, STATUS_UNMEASURABLE):
            return True
        return row["attempts"] >= MAX_ATTEMPTS or row["next_attempt_at"] > time.time()

    def put(self, identity: str, stamp: str, measurement: LoudnessMeasurement | None) -> None:
        """Record a completed pass.

        A `None` measurement is a *verdict*, not an error: the file was read and
        has no usable programme loudness (silence, a fragment shorter than one
        gating block). It is stored so the sweep does not keep reopening it.
        """
        now = int(time.time())
        if measurement is None:
            values = (identity, LOUDNESS_VERSION, stamp, None, None, None, STATUS_UNMEASURABLE, 0, 0, now)
        else:
            values = (
                identity, LOUDNESS_VERSION, stamp,
                measurement.lufs, measurement.peak_dbtp, measurement.lra,
                STATUS_OK, 0, 0, now,
            )
        _connect().execute(
            "INSERT OR REPLACE INTO track_loudness "
            "(identity, version, source_stamp, lufs, peak_dbtp, lra, status, attempts, next_attempt_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            values,
        )
        _connect().commit()

    def mark_failed(self, identity: str, stamp: str) -> None:
        """Record a pass that could not complete, and schedule the retry."""
        row = self.get(identity)
        attempts = (row["attempts"] if row and row["source_stamp"] == stamp else 0) + 1
        backoff = RETRY_BACKOFF_SEC[min(attempts, MAX_ATTEMPTS) - 1]
        now = int(time.time())
        _connect().execute(
            "INSERT OR REPLACE INTO track_loudness "
            "(identity, version, source_stamp, lufs, peak_dbtp, lra, status, attempts, next_attempt_at, updated_at) "
            "VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)",
            (identity, LOUDNESS_VERSION, stamp, STATUS_FAILED, attempts, now + backoff, now),
        )
        _connect().commit()

    def forget(self, identity: str) -> None:
        """Drop every verdict for this content — the file behind it changed."""
        if not identity:
            return
        _connect().execute("DELETE FROM track_loudness WHERE identity = ?", (identity,))
        _connect().commit()

    def pending(self, candidates: Sequence[tuple[str, str]]) -> list[str]:
        """Which of ``(identity, stamp)`` still need a pass, order preserved.

        The caller supplies candidates already in the order it wants them
        measured, and that order is what makes the feature feel immediate: the
        music somebody actually plays gets levelled in the first minutes rather
        than after the whole library has been swept.
        """
        return [
            identity for identity, stamp in candidates
            if identity and not self.is_current(identity, stamp)
        ]

    def coverage(self) -> dict[str, int]:
        rows = _connect().execute(
            "SELECT status, COUNT(*) AS n FROM track_loudness WHERE version = ? GROUP BY status",
            (LOUDNESS_VERSION,),
        ).fetchall()
        counts = {row["status"]: row["n"] for row in rows}
        return {
            "measured": counts.get(STATUS_OK, 0),
            "unmeasurable": counts.get(STATUS_UNMEASURABLE, 0),
            "failed": counts.get(STATUS_FAILED, 0),
        }
