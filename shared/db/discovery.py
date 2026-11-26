"""Discovery signals and events: what the listener told the recommender.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import json
import logging
import time
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
        aliases: Iterable[str] = (),
    ) -> None:
        """Atomically append an event and fold it into the current profile."""
        alias_set = {str(alias) for alias in aliases if alias}
        if identity:
            alias_set.add(identity)
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
            if alias_set:
                conn.executemany(
                    "INSERT OR IGNORE INTO discovery_signal_aliases (alias, identity) VALUES (?, ?)",
                    [(alias, identity) for alias in alias_set],
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

    def get_discovery_signal_aliases(self) -> List[tuple[str, str]]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT alias, identity FROM discovery_signal_aliases"
            ).fetchall()
            return [(str(row[0] or ""), str(row[1] or "")) for row in rows if row[0] and row[1]]

    def replace_discovery_signals(
        self,
        aggregates: Iterable[Dict[str, Any]],
        event_deltas: Dict[str, tuple[float, float]],
        *,
        policy_version: str,
        aliases: Iterable[tuple[str, str]] = (),
    ) -> None:
        """Atomically rebuild derived recommendation weights, preserving audit rows."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM discovery_signals")
            conn.execute("DELETE FROM discovery_signal_aliases")
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
            alias_pairs = [(str(alias), str(identity)) for alias, identity in aliases if alias and identity]
            if alias_pairs:
                conn.executemany(
                    "INSERT OR IGNORE INTO discovery_signal_aliases (alias, identity) VALUES (?, ?)",
                    alias_pairs,
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
            conn.execute("DELETE FROM discovery_signal_aliases")
            conn.execute("DELETE FROM discovery_artist_profile")
            conn.execute("DELETE FROM discovery_impressions")
            conn.execute("COMMIT")

    def replace_discovery_artist_profile(self, rows: Iterable[Dict[str, Any]]) -> None:
        """Persist the derived per-user artist taste profile snapshot."""
        payload = [
            (
                str(row.get("artist_key") or ""),
                str(row.get("literal_key") or ""),
                str(row.get("display_name") or "")[:220],
                str(row.get("deezer_artist_id") or "")[:64],
                float(row.get("short_term_score") or 0.0),
                float(row.get("long_term_score") or 0.0),
                float(row.get("library_prior") or 0.0),
                float(row.get("effective_score") or 0.0),
                int(row.get("distinct_days") or 0),
                int(row.get("distinct_tracks") or 0),
                float(row.get("active_plays") or 0.0),
                float(row.get("passive_plays") or 0.0),
                float(row.get("early_skips") or 0.0),
                int(row.get("last_listened_at") or 0),
                int(row.get("updated_at") or 0),
            )
            for row in rows
            if row.get("artist_key")
        ]
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM discovery_artist_profile")
            if payload:
                conn.executemany(
                    """
                    INSERT INTO discovery_artist_profile (
                        artist_key, literal_key, display_name, deezer_artist_id,
                        short_term_score, long_term_score, library_prior, effective_score,
                        distinct_days, distinct_tracks, active_plays, passive_plays,
                        early_skips, last_listened_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    payload,
                )
            conn.execute("COMMIT")

    def get_discovery_artist_profile(self, limit: int | None = None) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            sql = "SELECT * FROM discovery_artist_profile ORDER BY effective_score DESC, artist_key ASC"
            if limit is not None and limit > 0:
                rows = conn.execute(f"{sql} LIMIT ?", (int(limit),)).fetchall()
            else:
                rows = conn.execute(sql).fetchall()
            return [dict(row) for row in rows]

    def update_artist_profile_deezer_ids(self, mapping: Dict[str, str]) -> None:
        """Persist resolved Deezer artist IDs back onto cached taste profile rows."""
        updates = [
            (str(did).strip(), str(key).strip())
            for key, did in (mapping or {}).items()
            if str(key).strip() and str(did).strip().isdigit()
        ]
        if not updates:
            return
        now_ts = int(time.time())
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                """
                UPDATE discovery_artist_profile
                SET deezer_artist_id = ?, updated_at = ?
                WHERE artist_key = ? AND (deezer_artist_id = '' OR deezer_artist_id != ?)
                """,
                [(did, now_ts, key, did) for did, key in updates],
            )
            conn.execute("COMMIT")

    def record_discovery_impressions(
        self,
        entries: Iterable[tuple[str, str]],
        *,
        now: int | None = None,
        debounce_sec: int = 6 * 3600,
        force: bool = False,
    ) -> None:
        """Record candidate impressions with debounce to avoid burning the pool on tab switches."""
        cleaned = [
            (str(identity)[:240], str(entity_type)[:40])
            for identity, entity_type in entries
            if identity and entity_type
        ]
        if not cleaned:
            return
        deduped: list[tuple[str, str]] = []
        seen: set[str] = set()
        for identity, entity_type in cleaned:
            if identity not in seen:
                seen.add(identity)
                deduped.append((identity, entity_type))
        ts = int(now if now is not None else time.time())
        cutoff = ts - max(0, int(debounce_sec))
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for identity, entity_type in deduped:
                if force:
                    conn.execute(
                        """
                        INSERT INTO discovery_impressions (
                            identity, entity_type, first_shown_at, last_shown_at, shown_count, last_interacted_at
                        ) VALUES (?, ?, ?, ?, 1, 0)
                        ON CONFLICT(identity) DO UPDATE SET
                            entity_type = excluded.entity_type,
                            last_shown_at = excluded.last_shown_at,
                            shown_count = discovery_impressions.shown_count + 1
                        """,
                        (identity, entity_type, ts, ts),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO discovery_impressions (
                            identity, entity_type, first_shown_at, last_shown_at, shown_count, last_interacted_at
                        ) VALUES (?, ?, ?, ?, 1, 0)
                        ON CONFLICT(identity) DO UPDATE SET
                            entity_type = excluded.entity_type,
                            shown_count = CASE
                                WHEN discovery_impressions.last_shown_at <= ?
                                THEN discovery_impressions.shown_count + 1
                                ELSE discovery_impressions.shown_count
                            END,
                            last_shown_at = CASE
                                WHEN discovery_impressions.last_shown_at <= ?
                                THEN excluded.last_shown_at
                                ELSE discovery_impressions.last_shown_at
                            END
                        """,
                        (identity, entity_type, ts, ts, cutoff, cutoff),
                    )
            conn.execute("COMMIT")

    def mark_discovery_impression_interacted(
        self,
        identities: Iterable[str],
        *,
        now: int | None = None,
    ) -> None:
        cleaned = [str(identity)[:240] for identity in identities if identity]
        if not cleaned:
            return
        ts = int(now if now is not None else time.time())
        placeholders = ",".join("?" for _ in cleaned)
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                f"""
                UPDATE discovery_impressions
                SET last_interacted_at = MAX(last_interacted_at, ?)
                WHERE identity IN ({placeholders})
                """,
                (ts, *cleaned),
            )
            conn.execute("COMMIT")

    def get_discovery_impressions(
        self,
        identities: Iterable[str] | None = None,
    ) -> Dict[str, Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if identities is None:
                rows = conn.execute("SELECT * FROM discovery_impressions").fetchall()
            else:
                wanted = [str(identity)[:240] for identity in identities if identity]
                if not wanted:
                    return {}
                out: Dict[str, Dict[str, Any]] = {}
                for offset in range(0, len(wanted), 500):
                    batch = wanted[offset:offset + 500]
                    placeholders = ",".join("?" for _ in batch)
                    rows = conn.execute(
                        f"SELECT * FROM discovery_impressions WHERE identity IN ({placeholders})",
                        tuple(batch),
                    ).fetchall()
                    for row in rows:
                        out[str(row["identity"])] = dict(row)
                return out
            return {str(row["identity"]): dict(row) for row in rows}
