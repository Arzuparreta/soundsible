from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from shared.database import BUSY_TIMEOUT_MS, INSTANCE_DB_FILENAME
from shared.runtime import get_config_dir


class LosslessStore:
    def __init__(self, db_path: str | Path | None = None):
        self.db_path = Path(db_path) if db_path else get_config_dir() / INSTANCE_DB_FILENAME
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=BUSY_TIMEOUT_MS / 1000)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        return conn

    def _init(self) -> None:
        with self._connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS lossless_upgrade_jobs (
                    track_id TEXT PRIMARY KEY,
                    youtube_id TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at INTEGER NOT NULL DEFAULT 0,
                    provider TEXT,
                    candidate_json TEXT,
                    old_snapshot_json TEXT,
                    new_snapshot_json TEXT,
                    old_path TEXT,
                    new_path TEXT,
                    last_error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_lossless_jobs_ready
                    ON lossless_upgrade_jobs(status, next_attempt_at, updated_at);

                CREATE TABLE IF NOT EXISTS lossless_provider_cache (
                    track_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(track_id, provider)
                );

                CREATE TABLE IF NOT EXISTS lossless_daily_budget (
                    day TEXT PRIMARY KEY,
                    tracks_examined INTEGER NOT NULL DEFAULT 0,
                    bytes_downloaded INTEGER NOT NULL DEFAULT 0
                );
                """
            )

    def enqueue(self, track_id: str, youtube_id: str | None) -> bool:
        now = int(time.time())
        with self._connection() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO lossless_upgrade_jobs
                    (track_id, youtube_id, status, created_at, updated_at)
                VALUES (?, ?, 'pending', ?, ?)
                """,
                (track_id, youtube_id, now, now),
            )
            return cursor.rowcount > 0

    def next_ready(self, now: int | None = None) -> dict[str, Any] | None:
        current = int(now or time.time())
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT * FROM lossless_upgrade_jobs
                WHERE status IN ('pending', 'retry', 'no_match', 'committing')
                  AND next_attempt_at <= ?
                ORDER BY created_at, track_id
                LIMIT 1
                """,
                (current,),
            ).fetchone()
            return self._decode(row) if row else None

    def ready_count(self, now: int | None = None) -> int:
        current = int(now or time.time())
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count FROM lossless_upgrade_jobs
                WHERE status IN ('pending', 'retry', 'no_match', 'committing')
                  AND next_attempt_at <= ?
                """,
                (current,),
            ).fetchone()
            return int(row["count"]) if row else 0

    def requeue_all(self) -> int:
        """Put unmatched and back-off jobs back in line, right now.

        Provider answers are cached for as long as the no-match cooldown, so
        clearing the cache is what makes a re-check actually re-ask instead of
        replaying the same verdict.
        """
        now = int(time.time())
        with self._connection() as conn:
            cursor = conn.execute(
                """
                UPDATE lossless_upgrade_jobs
                SET status = 'pending', next_attempt_at = 0, attempts = 0,
                    last_error = NULL, updated_at = ?
                WHERE status IN ('no_match', 'retry')
                """,
                (now,),
            )
            conn.execute("DELETE FROM lossless_provider_cache")
            return cursor.rowcount

    def recover_interrupted(self) -> int:
        now = int(time.time())
        with self._connection() as conn:
            cursor = conn.execute(
                """
                UPDATE lossless_upgrade_jobs
                SET status = CASE WHEN status = 'committing' THEN 'committing' ELSE 'retry' END,
                    next_attempt_at = CASE WHEN status = 'committing' THEN next_attempt_at ELSE ? END,
                    updated_at = ?
                WHERE status IN ('searching', 'downloading', 'verifying', 'committing')
                """,
                (now, now),
            )
            return cursor.rowcount

    def update(self, track_id: str, status: str, **values: Any) -> None:
        allowed = {
            "attempts",
            "next_attempt_at",
            "provider",
            "candidate_json",
            "old_snapshot_json",
            "new_snapshot_json",
            "old_path",
            "new_path",
            "last_error",
        }
        assignments = ["status = ?", "updated_at = ?"]
        params: list[Any] = [status, int(time.time())]
        for key, value in values.items():
            if key not in allowed:
                continue
            if key.endswith("_json") and value is not None and not isinstance(value, str):
                value = json.dumps(value, ensure_ascii=False, sort_keys=True)
            assignments.append(f"{key} = ?")
            params.append(value)
        params.append(track_id)
        with self._connection() as conn:
            conn.execute(
                f"UPDATE lossless_upgrade_jobs SET {', '.join(assignments)} WHERE track_id = ?",
                params,
            )

    def get(self, track_id: str) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM lossless_upgrade_jobs WHERE track_id = ?",
                (track_id,),
            ).fetchone()
            return self._decode(row) if row else None

    def cache_get(self, track_id: str, provider: str, now: int | None = None) -> Any | None:
        current = int(now or time.time())
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT result_json FROM lossless_provider_cache
                WHERE track_id = ? AND provider = ? AND expires_at > ?
                """,
                (track_id, provider, current),
            ).fetchone()
            return json.loads(row["result_json"]) if row else None

    def cache_put(self, track_id: str, provider: str, value: Any, ttl_sec: int) -> None:
        now = int(time.time())
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO lossless_provider_cache
                    (track_id, provider, result_json, expires_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(track_id, provider) DO UPDATE SET
                    result_json = excluded.result_json,
                    expires_at = excluded.expires_at,
                    updated_at = excluded.updated_at
                """,
                (track_id, provider, json.dumps(value, ensure_ascii=False), now + ttl_sec, now),
            )

    def budget(self, day: str) -> dict[str, int]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT tracks_examined, bytes_downloaded FROM lossless_daily_budget WHERE day = ?",
                (day,),
            ).fetchone()
            if not row:
                return {"tracks_examined": 0, "bytes_downloaded": 0}
            return {
                "tracks_examined": int(row["tracks_examined"]),
                "bytes_downloaded": int(row["bytes_downloaded"]),
            }

    def add_budget(self, day: str, *, tracks: int = 0, bytes_downloaded: int = 0) -> None:
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO lossless_daily_budget(day, tracks_examined, bytes_downloaded)
                VALUES (?, ?, ?)
                ON CONFLICT(day) DO UPDATE SET
                    tracks_examined = tracks_examined + excluded.tracks_examined,
                    bytes_downloaded = bytes_downloaded + excluded.bytes_downloaded
                """,
                (day, tracks, bytes_downloaded),
            )

    def summary(self) -> dict[str, Any]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS count FROM lossless_upgrade_jobs GROUP BY status"
            ).fetchall()
            counts = {str(row["status"]): int(row["count"]) for row in rows}
            recent = conn.execute(
                """
                SELECT track_id, status, provider, last_error, updated_at
                FROM lossless_upgrade_jobs ORDER BY updated_at DESC LIMIT 1
                """
            ).fetchone()
        return {"counts": counts, "latest": dict(recent) if recent else None}

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        for key in ("candidate_json", "old_snapshot_json", "new_snapshot_json"):
            if value.get(key):
                try:
                    value[key] = json.loads(value[key])
                except (TypeError, ValueError):
                    value[key] = None
        return value
