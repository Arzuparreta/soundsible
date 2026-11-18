"""Lyrics and their per-track offsets.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import logging
from typing import Dict, Any, Optional


logger = logging.getLogger(__name__)


class LyricsStore:

    # Note: Lyrics cache

    _LYRICS_NEGATIVE_TTL_SEC = 7 * 24 * 3600

    def get_lyrics(self, track_id: str) -> Optional[Dict[str, Any]]:
        """Return the cached lyrics record for a track, or None if missing.
        A not-found record (no synced/plain, not instrumental) expires after
        7 days so the provider is retried; positive results never expire."""
        if not track_id:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT synced, plain, instrumental, source, synced_duration, checked_at FROM track_lyrics WHERE track_id = ?",
                (track_id,),
            ).fetchone()
            if not row:
                return None
            record = dict(row)
            record["instrumental"] = bool(record["instrumental"])
            if not record["synced"] and not record["plain"] and not record["instrumental"]:
                # A negative result is only valid for the matcher that produced
                # it. Algorithm upgrades must retry immediately instead of
                # preserving stale misses for the full TTL.
                from shared.lyrics import RESOLVER_SOURCE

                if record.get("source") != RESOLVER_SOURCE:
                    return None
                cutoff = int(self._LYRICS_NEGATIVE_TTL_SEC)
                fresh = conn.execute(
                    """
                    SELECT 1 FROM track_lyrics
                    WHERE track_id = ?
                      AND checked_at >= datetime('now', ? || ' seconds')
                    """,
                    (track_id, f"-{cutoff}"),
                ).fetchone()
                if not fresh:
                    return None
            return record

    def set_lyrics(
        self,
        track_id: str,
        *,
        synced: Optional[str] = None,
        plain: Optional[str] = None,
        instrumental: bool = False,
        source: Optional[str] = None,
        synced_duration: Optional[int] = None,
    ) -> None:
        """Upsert the lyrics record for a track (also used for negative caching)."""
        if not track_id:
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    INSERT INTO track_lyrics (track_id, synced, plain, instrumental, source, synced_duration, checked_at)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(track_id) DO UPDATE SET
                        synced=excluded.synced,
                        plain=excluded.plain,
                        instrumental=excluded.instrumental,
                        source=excluded.source,
                        synced_duration=excluded.synced_duration,
                        checked_at=CURRENT_TIMESTAMP
                    """,
                    (track_id, synced, plain, 1 if instrumental else 0, source, synced_duration),
                )
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                logger.warning("Error caching lyrics: %s", e)

    def get_lyrics_offset(self, audio_key: str) -> Optional[int]:
        """The listener's lyrics offset for this audio, in milliseconds."""
        if not audio_key:
            return None
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT offset_ms FROM lyrics_offsets WHERE audio_key = ?", (audio_key,)
            ).fetchone()
            return int(row[0]) if row else None

    def set_lyrics_offset(self, audio_key: str, offset_ms: Optional[int]) -> None:
        """Store an offset for this audio, or forget it with None."""
        if not audio_key:
            return
        with self._get_connection() as conn:
            if offset_ms is None:
                conn.execute("DELETE FROM lyrics_offsets WHERE audio_key = ?", (audio_key,))
            else:
                conn.execute(
                    """
                    INSERT INTO lyrics_offsets (audio_key, offset_ms, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(audio_key) DO UPDATE SET
                        offset_ms=excluded.offset_ms,
                        updated_at=CURRENT_TIMESTAMP
                    """,
                    (audio_key, int(offset_ms)),
                )
