from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from shared.migration.models import MigrationManifest
from shared.user_context import user_data_dir


JOB_STATES = {
    "analyzed",
    "queued",
    "running",
    "paused",
    "needs_review",
    "completed",
    "partial",
    "cancelled",
    "failed",
}
TRACK_STATES = {
    "existing",
    "pending",
    "resolving",
    "downloading",
    "completed",
    "needs_review",
    "unavailable",
    "skipped",
    "failed",
}
TERMINAL_TRACK_STATES = {"existing", "completed", "unavailable", "skipped", "failed"}


def manifest_fingerprint(manifest: MigrationManifest) -> str:
    payload = json.dumps(manifest.to_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class MigrationStore:
    """Small user-scoped durable store for resumable migration jobs."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else user_data_dir() / "migration.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init_schema()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # A raw sqlite3.Connection's own __enter__/__exit__ only commits or
        # rolls back — it never closes. Every call site does
        # `with self._connect() as db:`, so without this wrapper each call
        # leaked one open connection/fd forever; this replicates the
        # commit/rollback behavior and then closes.
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _init_schema(self) -> None:
        with self._lock, self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS migration_jobs (
                    id TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    state TEXT NOT NULL,
                    manifest_json TEXT NOT NULL,
                    selection_json TEXT NOT NULL DEFAULT '{}',
                    playlist_names_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    error TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_migration_jobs_updated
                    ON migration_jobs(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_migration_jobs_fingerprint
                    ON migration_jobs(fingerprint);

                CREATE TABLE IF NOT EXISTS migration_tracks (
                    job_id TEXT NOT NULL,
                    source_key TEXT NOT NULL,
                    state TEXT NOT NULL,
                    matched_track_id TEXT,
                    confidence REAL NOT NULL DEFAULT 0,
                    candidates_json TEXT NOT NULL DEFAULT '[]',
                    selected_json TEXT,
                    error TEXT,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (job_id, source_key),
                    FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_migration_tracks_job_state
                    ON migration_tracks(job_id, state);
                """
            )

    def create_job(
        self,
        manifest: MigrationManifest,
        matches: Iterable[dict[str, Any]],
    ) -> tuple[dict[str, Any], bool]:
        fingerprint = manifest_fingerprint(manifest)
        now = int(time.time())
        with self._lock, self._connect() as db:
            existing = db.execute(
                """
                SELECT id FROM migration_jobs
                WHERE fingerprint = ? AND state != 'cancelled'
                ORDER BY created_at DESC LIMIT 1
                """,
                (fingerprint,),
            ).fetchone()
            if existing:
                return self.get_job(str(existing["id"])), False

            job_id = uuid.uuid4().hex
            db.execute(
                """
                INSERT INTO migration_jobs (
                    id, fingerprint, provider, source_name, state, manifest_json,
                    selection_json, playlist_names_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'analyzed', ?, '{}', '{}', ?, ?)
                """,
                (
                    job_id,
                    fingerprint,
                    manifest.provider,
                    manifest.source_name,
                    json.dumps(manifest.to_dict(), ensure_ascii=False, separators=(",", ":")),
                    now,
                    now,
                ),
            )
            rows = []
            for match in matches:
                matched_id = match.get("matched_track_id")
                confidence = float(match.get("confidence") or 0)
                state = "existing" if matched_id and match.get("auto_accept") else "needs_review" if matched_id else "pending"
                rows.append(
                    (
                        job_id,
                        str(match["source_key"]),
                        state,
                        matched_id,
                        confidence,
                        json.dumps(match.get("candidates") or [], ensure_ascii=False),
                        now,
                    )
                )
            db.executemany(
                """
                INSERT INTO migration_tracks (
                    job_id, source_key, state, matched_track_id, confidence,
                    candidates_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        return self.get_job(job_id), True

    def _job_row(self, job_id: str) -> sqlite3.Row:
        with self._connect() as db:
            row = db.execute("SELECT * FROM migration_jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        return row

    @staticmethod
    def _loads(value: str | None, fallback: Any) -> Any:
        try:
            return json.loads(value or "")
        except (TypeError, json.JSONDecodeError):
            return fallback

    def get_manifest(self, job_id: str) -> MigrationManifest:
        row = self._job_row(job_id)
        return MigrationManifest.from_dict(self._loads(row["manifest_json"], {}))

    def get_job(self, job_id: str, *, include_tracks: bool = True) -> dict[str, Any]:
        row = self._job_row(job_id)
        manifest = MigrationManifest.from_dict(self._loads(row["manifest_json"], {}))
        with self._connect() as db:
            track_rows = db.execute(
                "SELECT * FROM migration_tracks WHERE job_id = ? ORDER BY rowid",
                (job_id,),
            ).fetchall()
        state_counts: dict[str, int] = {}
        tracks = []
        for track_row in track_rows:
            state = str(track_row["state"])
            state_counts[state] = state_counts.get(state, 0) + 1
            if include_tracks:
                source_key = str(track_row["source_key"])
                source = manifest.tracks.get(source_key)
                tracks.append(
                    {
                        "source_key": source_key,
                        "source": source.to_dict() if source else None,
                        "state": state,
                        "matched_track_id": track_row["matched_track_id"],
                        "confidence": round(float(track_row["confidence"] or 0), 5),
                        "candidates": self._loads(track_row["candidates_json"], []),
                        "selected": self._loads(track_row["selected_json"], None),
                        "error": track_row["error"],
                    }
                )
        selection = self._loads(row["selection_json"], {})
        selected_keys = self.selected_track_keys(manifest, selection)
        selected_counts: dict[str, int] = {}
        for track in tracks:
            if track["source_key"] in selected_keys:
                state = track["state"]
                selected_counts[state] = selected_counts.get(state, 0) + 1
        duration = sum(manifest.tracks[key].duration for key in selected_keys if key in manifest.tracks)
        unknown_duration = sum(1 for key in selected_keys if key in manifest.tracks and not manifest.tracks[key].duration)
        estimate_bytes = int(duration * 192_000 / 8 + unknown_duration * 4 * 1024 * 1024)
        return {
            "id": str(row["id"]),
            "provider": str(row["provider"]),
            "source_name": str(row["source_name"]),
            "state": str(row["state"]),
            "manifest": {
                "track_count": len(manifest.tracks),
                "library_count": len(set(manifest.library_keys)),
                "favourite_count": len(set(manifest.favourite_keys)),
                "playlists": [
                    {
                        "source_id": playlist.source_id,
                        "name": playlist.name,
                        "track_count": len(playlist.track_keys),
                        "track_keys": playlist.track_keys,
                        "is_favourites": playlist.is_favourites,
                    }
                    for playlist in manifest.playlists
                ],
                "warnings": manifest.warnings,
            },
            "selection": selection,
            "playlist_names": self._loads(row["playlist_names_json"], {}),
            "counts": state_counts,
            "selected_counts": selected_counts,
            "selected_track_count": len(selected_keys),
            "estimated_download_bytes": estimate_bytes,
            "tracks": tracks if include_tracks else None,
            "created_at": int(row["created_at"]),
            "updated_at": int(row["updated_at"]),
            "error": row["error"],
        }

    def list_jobs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT id FROM migration_jobs ORDER BY updated_at DESC LIMIT ?",
                (max(1, min(int(limit), 100)),),
            ).fetchall()
        return [self.get_job(str(row["id"]), include_tracks=False) for row in rows]

    @staticmethod
    def selected_track_keys(manifest: MigrationManifest, selection: dict[str, Any]) -> set[str]:
        if not selection:
            return set(manifest.tracks)
        keys = set(manifest.library_keys if selection.get("include_library", True) else [])
        playlist_ids = set(selection.get("playlist_ids") or [])
        for playlist in manifest.playlists:
            if playlist.source_id in playlist_ids:
                keys.update(playlist.track_keys)
        return keys

    def configure(
        self,
        job_id: str,
        *,
        include_library: bool,
        playlist_ids: list[str],
        playlist_names: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        manifest = self.get_manifest(job_id)
        known_ids = {playlist.source_id for playlist in manifest.playlists}
        clean_ids = list(dict.fromkeys(str(value) for value in playlist_ids if str(value) in known_ids))
        selection = {"include_library": bool(include_library), "playlist_ids": clean_ids}
        if not self.selected_track_keys(manifest, selection):
            raise ValueError("Select the library or at least one non-empty playlist")
        names = {
            str(key): " ".join(str(value).strip().split())[:200]
            for key, value in (playlist_names or {}).items()
            if str(key) in known_ids and str(value).strip()
        }
        now = int(time.time())
        with self._lock, self._connect() as db:
            db.execute(
                """
                UPDATE migration_jobs
                SET selection_json = ?, playlist_names_json = ?, state = 'queued',
                    error = NULL, updated_at = ?
                WHERE id = ?
                """,
                (json.dumps(selection), json.dumps(names, ensure_ascii=False), now, job_id),
            )
        return self.get_job(job_id)

    def set_job_state(self, job_id: str, state: str, error: str | None = None) -> None:
        if state not in JOB_STATES:
            raise ValueError(f"Invalid migration job state: {state}")
        with self._lock, self._connect() as db:
            result = db.execute(
                "UPDATE migration_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?",
                (state, error[:2000] if error else None, int(time.time()), job_id),
            )
            if result.rowcount == 0:
                raise KeyError(job_id)

    def set_playlist_names(self, job_id: str, names: dict[str, str]) -> None:
        with self._lock, self._connect() as db:
            result = db.execute(
                "UPDATE migration_jobs SET playlist_names_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(names, ensure_ascii=False), int(time.time()), job_id),
            )
            if result.rowcount == 0:
                raise KeyError(job_id)

    def job_state(self, job_id: str) -> str:
        return str(self._job_row(job_id)["state"])

    def get_track(self, job_id: str, source_key: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM migration_tracks WHERE job_id = ? AND source_key = ?",
                (job_id, source_key),
            ).fetchone()
        if row is None:
            raise KeyError(source_key)
        return {
            "source_key": source_key,
            "state": str(row["state"]),
            "matched_track_id": row["matched_track_id"],
            "confidence": float(row["confidence"] or 0),
            "candidates": self._loads(row["candidates_json"], []),
            "selected": self._loads(row["selected_json"], None),
            "error": row["error"],
        }

    def update_track(
        self,
        job_id: str,
        source_key: str,
        *,
        state: str,
        matched_track_id: str | None = None,
        confidence: float | None = None,
        candidates: list[dict[str, Any]] | None = None,
        selected: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        if state not in TRACK_STATES:
            raise ValueError(f"Invalid migration track state: {state}")
        assignments = ["state = ?", "updated_at = ?", "error = ?"]
        values: list[Any] = [state, int(time.time()), error[:2000] if error else None]
        if matched_track_id is not None:
            assignments.append("matched_track_id = ?")
            values.append(matched_track_id)
        if confidence is not None:
            assignments.append("confidence = ?")
            values.append(max(0.0, min(float(confidence), 1.0)))
        if candidates is not None:
            assignments.append("candidates_json = ?")
            values.append(json.dumps(candidates, ensure_ascii=False))
        if selected is not None:
            assignments.append("selected_json = ?")
            values.append(json.dumps(selected, ensure_ascii=False))
        values.extend((job_id, source_key))
        with self._lock, self._connect() as db:
            result = db.execute(
                f"UPDATE migration_tracks SET {', '.join(assignments)} WHERE job_id = ? AND source_key = ?",
                values,
            )
            if result.rowcount == 0:
                raise KeyError(source_key)
            db.execute(
                "UPDATE migration_jobs SET updated_at = ? WHERE id = ?",
                (int(time.time()), job_id),
            )

    def reset_retryable(self, job_id: str) -> None:
        now = int(time.time())
        with self._lock, self._connect() as db:
            db.execute(
                """
                UPDATE migration_tracks
                SET state = 'pending', error = NULL, updated_at = ?
                WHERE job_id = ? AND state IN ('resolving', 'downloading', 'failed')
                """,
                (now, job_id),
            )
            db.execute(
                "UPDATE migration_jobs SET state = 'queued', error = NULL, updated_at = ? WHERE id = ?",
                (now, job_id),
            )
