"""
Background metadata migration for canonicalization with audit/rollback.
"""

import json
import threading
import uuid
from datetime import datetime
from typing import Dict, Any, Optional

from shared.models import Track
from odst_tool.metadata_harmonizer import MetadataHarmonizer


class MetadataMigrationManager:
    def __init__(self, library_manager, log_callback=None):
        self.library_manager = library_manager
        self.log_callback = log_callback or (lambda _msg: None)
        self._lock = threading.RLock()
        self.current_job_id: Optional[str] = None
        self.is_running = False
        self._pause_requested = False
        self._cancel_requested = False

    def _log(self, msg: str):
        self.log_callback(msg)

    def _db_exec(self, query: str, params: tuple = ()):
        with self.library_manager.db._get_connection() as conn:
            conn.execute(query, params)

    def _db_fetchone(self, query: str, params: tuple = ()) -> Optional[tuple]:
        with self.library_manager.db._get_connection() as conn:
            cur = conn.execute(query, params)
            return cur.fetchone()

    def start(self, dry_run: bool = True) -> Optional[str]:
        with self._lock:
            if self.is_running:
                return None
            self.is_running = True
            self._pause_requested = False
            self._cancel_requested = False
            self.current_job_id = uuid.uuid4().hex
            threading.Thread(target=self._run_job, args=(self.current_job_id, dry_run), daemon=True).start()
            return self.current_job_id

    def _run_job(self, job_id: str, dry_run: bool):
        created_at = datetime.utcnow().isoformat() + "Z"
        self._db_exec(
            """
            INSERT INTO metadata_migration_jobs
            (id, status, total_tracks, processed_tracks, applied_tracks, failed_tracks, dry_run, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (job_id, "running", 0, 0, 0, 0, 1 if dry_run else 0, created_at, created_at),
        )
        try:
            lib = self.library_manager
            if not lib.metadata:
                lib.sync_library(silent=True)
            tracks = list(lib.metadata.tracks if lib.metadata else [])
            total = len(tracks)
            self._db_exec(
                "UPDATE metadata_migration_jobs SET total_tracks=?, updated_at=? WHERE id=?",
                (total, datetime.utcnow().isoformat() + "Z", job_id),
            )
            applied = 0
            failed = 0
            for idx, track in enumerate(tracks, start=1):
                while self._pause_requested and not self._cancel_requested:
                    self._db_exec(
                        "UPDATE metadata_migration_jobs SET status=?, updated_at=? WHERE id=?",
                        ("paused", datetime.utcnow().isoformat() + "Z", job_id),
                    )
                    self._log(f"Metadata migration paused (job={job_id})")
                    import time
                    time.sleep(0.5)
                if self._cancel_requested:
                    self._db_exec(
                        "UPDATE metadata_migration_jobs SET status=?, updated_at=? WHERE id=?",
                        ("cancelled", datetime.utcnow().isoformat() + "Z", job_id),
                    )
                    self._log(f"Metadata migration cancelled (job={job_id})")
                    return
                old_payload = track.to_dict()
                try:
                    harmonized = MetadataHarmonizer.harmonize(track.to_dict(), source="migration")
                    confidence = float(harmonized.get("metadata_confidence") or 0.0)
                    metadata_state = harmonized.get("metadata_state") or "fallback_youtube"
                    new_payload = {
                        "title": harmonized.get("title") or track.title,
                        "artist": harmonized.get("artist") or track.artist,
                        "album": harmonized.get("album") or track.album,
                        "album_artist": harmonized.get("album_artist") or track.album_artist,
                        "year": harmonized.get("year") or track.year,
                        "track_number": harmonized.get("track_number") or track.track_number,
                        "musicbrainz_id": harmonized.get("musicbrainz_id") or track.musicbrainz_id,
                        "isrc": harmonized.get("isrc") or track.isrc,
                        "metadata_source_authority": harmonized.get("metadata_source_authority"),
                        "metadata_confidence": harmonized.get("metadata_confidence"),
                        "metadata_decision_id": harmonized.get("metadata_decision_id"),
                        "metadata_state": metadata_state,
                        "metadata_query_fingerprint": harmonized.get("metadata_query_fingerprint"),
                    }

                    status = "skipped_low_confidence"
                    if metadata_state == "auto_resolved" and confidence >= 0.9 and not dry_run:
                        # Update in-memory track and persist.
                        track.title = new_payload["title"]
                        track.artist = new_payload["artist"]
                        track.album = new_payload["album"]
                        track.album_artist = new_payload["album_artist"]
                        track.year = new_payload["year"]
                        track.track_number = new_payload["track_number"]
                        track.musicbrainz_id = new_payload["musicbrainz_id"]
                        track.isrc = new_payload["isrc"]
                        track.metadata_source_authority = new_payload["metadata_source_authority"]
                        track.metadata_confidence = new_payload["metadata_confidence"]
                        track.metadata_decision_id = new_payload["metadata_decision_id"]
                        track.metadata_state = new_payload["metadata_state"]
                        track.metadata_query_fingerprint = new_payload["metadata_query_fingerprint"]
                        status = "applied"
                        applied += 1
                    elif metadata_state == "auto_resolved" and confidence >= 0.9 and dry_run:
                        status = "would_apply"
                    elif metadata_state == "pending_review":
                        status = "pending_review"
                        self._db_exec(
                            """
                            INSERT INTO metadata_review_queue
                            (id, queue_item_id, track_id, source_type, song_str, metadata_state, confidence, fingerprint, candidates_json, proposed_json, status, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                uuid.uuid4().hex,
                                None,
                                track.id,
                                "migration",
                                f"{track.artist} - {track.title}",
                                metadata_state,
                                confidence,
                                harmonized.get("metadata_query_fingerprint"),
                                json.dumps(harmonized.get("review_candidates") or {}),
                                json.dumps(new_payload),
                                "pending_review",
                                datetime.utcnow().isoformat() + "Z",
                                datetime.utcnow().isoformat() + "Z",
                            ),
                        )

                    self._db_exec(
                        """
                        INSERT INTO metadata_migration_audit
                        (job_id, track_id, status, confidence, old_metadata_json, new_metadata_json, error, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            job_id,
                            track.id,
                            status,
                            confidence,
                            json.dumps(old_payload),
                            json.dumps(new_payload),
                            None,
                            datetime.utcnow().isoformat() + "Z",
                        ),
                    )
                except Exception as e:
                    failed += 1
                    self._db_exec(
                        """
                        INSERT INTO metadata_migration_audit
                        (job_id, track_id, status, confidence, old_metadata_json, new_metadata_json, error, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            job_id,
                            track.id,
                            "failed",
                            0.0,
                            json.dumps(old_payload),
                            None,
                            str(e),
                            datetime.utcnow().isoformat() + "Z",
                        ),
                    )
                self._db_exec(
                    "UPDATE metadata_migration_jobs SET processed_tracks=?, applied_tracks=?, failed_tracks=?, updated_at=? WHERE id=?",
                    (idx, applied, failed, datetime.utcnow().isoformat() + "Z", job_id),
                )
            if not dry_run and lib.metadata:
                lib.metadata.version += 1
                lib._save_metadata()
            self._db_exec(
                "UPDATE metadata_migration_jobs SET status=?, updated_at=? WHERE id=?",
                ("completed", datetime.utcnow().isoformat() + "Z", job_id),
            )
            self._log(f"Metadata migration completed (job={job_id}, dry_run={dry_run}).")
        except Exception as e:
            self._db_exec(
                "UPDATE metadata_migration_jobs SET status=?, updated_at=? WHERE id=?",
                ("failed", datetime.utcnow().isoformat() + "Z", job_id),
            )
            self._log(f"Metadata migration failed: {e}")
        finally:
            with self._lock:
                self.is_running = False

    def pause(self):
        with self._lock:
            if self.is_running:
                self._pause_requested = True

    def resume(self):
        with self._lock:
            if self.is_running:
                self._pause_requested = False

    def cancel(self):
        with self._lock:
            if self.is_running:
                self._cancel_requested = True

    def status(self, job_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        target_id = job_id or self.current_job_id
        if not target_id:
            return None
        row = self._db_fetchone(
            """
            SELECT id, status, total_tracks, processed_tracks, applied_tracks, failed_tracks, dry_run, created_at, updated_at
            FROM metadata_migration_jobs WHERE id=?
            """,
            (target_id,),
        )
        if not row:
            return None
        return {
            "id": row[0],
            "status": row[1],
            "total_tracks": row[2],
            "processed_tracks": row[3],
            "applied_tracks": row[4],
            "failed_tracks": row[5],
            "dry_run": bool(row[6]),
            "created_at": row[7],
            "updated_at": row[8],
        }

    def rollback(self, job_id: str) -> Dict[str, Any]:
        lib = self.library_manager
        if not lib.metadata:
            lib.sync_library(silent=True)
        with lib.db._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT track_id, old_metadata_json
                FROM metadata_migration_audit
                WHERE job_id=? AND status IN ('applied', 'would_apply')
                """,
                (job_id,),
            ).fetchall()
        if not rows:
            return {"rolled_back": 0}
        updated = 0
        track_map = {t.id: t for t in (lib.metadata.tracks if lib.metadata else [])}
        for track_id, old_json in rows:
            old_data = json.loads(old_json)
            track = track_map.get(track_id)
            if not track:
                continue
            restored = Track.from_dict(old_data)
            track.title = restored.title
            track.artist = restored.artist
            track.album = restored.album
            track.album_artist = restored.album_artist
            track.year = restored.year
            track.track_number = restored.track_number
            track.musicbrainz_id = restored.musicbrainz_id
            track.isrc = restored.isrc
            track.metadata_source_authority = restored.metadata_source_authority
            track.metadata_confidence = restored.metadata_confidence
            track.metadata_decision_id = restored.metadata_decision_id
            track.metadata_state = restored.metadata_state
            track.metadata_query_fingerprint = restored.metadata_query_fingerprint
            updated += 1
        if updated and lib.metadata:
            lib.metadata.version += 1
            lib._save_metadata()
        return {"rolled_back": updated}
