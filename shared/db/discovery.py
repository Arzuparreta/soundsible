"""Discovery signals and events: what the listener told the recommender.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import json
import logging
from typing import List, Dict, Any, Iterable


logger = logging.getLogger(__name__)


class DiscoveryStore:

    def record_discovery_signal(
        self,
        *,
        event_id: str,
        event: str,
        identity: str,
        media_type: str,
        positive_delta: float,
        negative_delta: float,
        payload: Dict[str, Any],
        created_at: int,
    ) -> None:
        """Atomically append an event and fold it into the current profile."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                INSERT INTO discovery_events (
                    id, event, identity, media_type, positive_delta,
                    negative_delta, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    event,
                    identity,
                    media_type,
                    float(positive_delta),
                    float(negative_delta),
                    json.dumps(payload, sort_keys=True, ensure_ascii=False),
                    int(created_at),
                ),
            )
            conn.execute(
                """
                INSERT INTO discovery_signals (
                    identity, media_type, title, artist, show_title,
                    positive_weight, negative_count, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(identity) DO UPDATE SET
                    media_type=excluded.media_type,
                    title=COALESCE(NULLIF(excluded.title, ''), discovery_signals.title),
                    artist=COALESCE(NULLIF(excluded.artist, ''), discovery_signals.artist),
                    show_title=COALESCE(NULLIF(excluded.show_title, ''), discovery_signals.show_title),
                    positive_weight=MAX(0, discovery_signals.positive_weight + excluded.positive_weight),
                    negative_count=MAX(0, discovery_signals.negative_count + excluded.negative_count),
                    updated_at=excluded.updated_at
                """,
                (
                    identity,
                    media_type,
                    str(payload.get("title") or "")[:220],
                    str(payload.get("artist") or "")[:220],
                    str(payload.get("podcast_show_title") or "")[:220],
                    float(positive_delta),
                    float(negative_delta),
                    int(created_at),
                ),
            )
            conn.execute("COMMIT")

    def undo_discovery_signal(self, event_id: str, undone_at: int) -> bool:
        """Undo one event exactly once and reverse its aggregate deltas."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT identity, positive_delta, negative_delta
                FROM discovery_events
                WHERE id = ? AND undone_at IS NULL
                """,
                (event_id,),
            ).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                return False
            conn.execute(
                "UPDATE discovery_events SET undone_at = ? WHERE id = ?",
                (int(undone_at), event_id),
            )
            conn.execute(
                """
                UPDATE discovery_signals
                SET positive_weight=MAX(0, positive_weight - ?),
                    negative_count=MAX(0, negative_count - ?),
                    updated_at=?
                WHERE identity=?
                """,
                (
                    float(row["positive_delta"]),
                    float(row["negative_delta"]),
                    int(undone_at),
                    str(row["identity"]),
                ),
            )
            conn.execute("COMMIT")
            return True

    def discovery_profile_policy_version(self) -> str:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT value FROM library_info WHERE key = 'discovery_profile_policy'"
            ).fetchone()
            return str(row[0]) if row else ""

    def get_discovery_events(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM discovery_events ORDER BY created_at, id"
            ).fetchall()
            return [dict(row) for row in rows]

    def replace_discovery_signals(
        self,
        aggregates: Iterable[Dict[str, Any]],
        event_deltas: Dict[str, tuple[float, float]],
        *,
        policy_version: str,
    ) -> None:
        """Atomically rebuild derived recommendation weights, preserving audit rows."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM discovery_signals")
            for row in aggregates:
                conn.execute(
                    """
                    INSERT INTO discovery_signals (
                        identity, media_type, title, artist, show_title,
                        positive_weight, negative_count, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(row.get("identity") or ""),
                        str(row.get("media_type") or ""),
                        str(row.get("title") or "")[:220],
                        str(row.get("artist") or "")[:220],
                        str(row.get("show_title") or "")[:220],
                        float(row.get("positive_weight") or 0),
                        float(row.get("negative_weight") or 0),
                        int(row.get("updated_at") or 0),
                    ),
                )
            for event_id, (positive, negative) in event_deltas.items():
                conn.execute(
                    """
                    UPDATE discovery_events
                    SET positive_delta = ?, negative_delta = ?
                    WHERE id = ?
                    """,
                    (float(positive), float(negative), str(event_id)),
                )
            conn.execute(
                """
                INSERT OR REPLACE INTO library_info (key, value)
                VALUES ('discovery_profile_policy', ?)
                """,
                (str(policy_version),),
            )
            conn.execute("COMMIT")

    def get_discovery_signals(self) -> Dict[str, Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM discovery_signals").fetchall()
            return {str(row["identity"]): dict(row) for row in rows}

    def clear_discovery_signals(self) -> None:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM discovery_events")
            conn.execute("DELETE FROM discovery_signals")
            conn.execute("COMMIT")
