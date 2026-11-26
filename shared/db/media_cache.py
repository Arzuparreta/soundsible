"""Shared caches: stream URLs, YouTube resolutions and related mixes.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import json
import logging
import time
from typing import Dict, Any, Optional, Iterable
from shared.url_utils import validate_youtube_video_id


logger = logging.getLogger(__name__)


class MediaCache:

    # Note: Resolved stream URL cache

    def get_cached_stream_url(self, video_id: str, egress: str) -> Optional[Dict[str, Any]]:
        """Return a live cached stream URL for this video and egress, or None.

        Expired rows are reported as a miss and left for `prune_stream_urls` to
        clear; a read path should not pay for a write.
        """
        if not video_id or not egress:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT url, egress, resolved_at, expires_at
                FROM stream_url_cache
                WHERE video_id = ? AND egress = ? AND expires_at > ?
            """, (video_id, egress, time.time())).fetchone()
            return dict(row) if row else None

    def set_cached_stream_url(
        self,
        video_id: str,
        url: str,
        egress: str,
        resolved_at: float,
        expires_at: float,
    ) -> None:
        """Remember a resolved stream URL until its own signature expires."""
        if not video_id or not url or not egress:
            return
        if expires_at <= time.time():
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("""
                    INSERT INTO stream_url_cache (video_id, url, egress, resolved_at, expires_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(video_id) DO UPDATE SET
                        url=excluded.url,
                        egress=excluded.egress,
                        resolved_at=excluded.resolved_at,
                        expires_at=excluded.expires_at
                """, (video_id, url, egress, resolved_at, expires_at))
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def invalidate_cached_stream_url(self, video_id: str) -> None:
        """Drop a stream URL the CDN has started rejecting."""
        if not video_id:
            return
        with self._get_connection() as conn:
            conn.execute("DELETE FROM stream_url_cache WHERE video_id = ?", (video_id,))

    def prune_stream_urls(self) -> int:
        """Delete expired rows. Returns how many went."""
        with self._get_connection() as conn:
            cursor = conn.execute("DELETE FROM stream_url_cache WHERE expires_at <= ?", (time.time(),))
            return cursor.rowcount or 0

    # Note: Youtube resolution cache

    def get_cached_resolution(self, artist: str, title: str) -> Optional[Dict[str, Any]]:
        """Fetch a cached YouTube resolution by artist and title."""
        if not artist or not title:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT youtube_id as id, duration, thumbnail, webpage_url, channel, artist, title,
                       confidence, confidence_reason, candidates_json, failure_state, verified_at,
                       requested_duration
                FROM youtube_resolution_cache
                WHERE artist = ? AND title = ?
            """, (artist, title)).fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("candidates_json"):
                try:
                    import json as _json
                    d["candidates"] = _json.loads(d["candidates_json"])
                except Exception:
                    d["candidates"] = []
            else:
                d["candidates"] = []
            return d

    def set_cached_resolution(self, artist: str, title: str, result: Dict[str, Any]):
        """Save a YouTube resolution to the cache. Allows empty id for failure states."""
        if not artist or not title or not result:
            return
        # Require a video id unless this is explicitly a failure state record
        if not result.get("id") and not result.get("failure_state"):
            return
        import json as _json
        candidates = result.get("candidates") or []
        candidates_json = _json.dumps(candidates) if candidates else None
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("""
                    INSERT INTO youtube_resolution_cache
                    (artist, title, youtube_id, duration, thumbnail, webpage_url, channel,
                     confidence, confidence_reason, candidates_json, failure_state, requested_duration,
                     verified_at, last_updated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT(artist, title) DO UPDATE SET
                    youtube_id=excluded.youtube_id,
                    duration=excluded.duration,
                    thumbnail=excluded.thumbnail,
                    webpage_url=excluded.webpage_url,
                    channel=excluded.channel,
                    confidence=excluded.confidence,
                    confidence_reason=excluded.confidence_reason,
                    candidates_json=excluded.candidates_json,
                    failure_state=excluded.failure_state,
                    requested_duration=excluded.requested_duration,
                    verified_at=excluded.verified_at,
                    last_updated=CURRENT_TIMESTAMP
                """, (
                    artist,
                    title,
                    result.get("id"),
                    result.get("duration") or 0,
                    result.get("thumbnail") or "",
                    result.get("webpage_url") or "",
                    result.get("channel") or "",
                    result.get("confidence"),
                    result.get("confidence_reason"),
                    candidates_json,
                    result.get("failure_state"),
                    result.get("requested_duration"),
                ))
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                logger.warning("Error caching YouTube resolution: %s", e)

    # Note: Related/mix expansion cache (discover node engine)

    _RELATED_MIX_TTL_SEC = 7 * 24 * 3600
    _RELATED_MIX_EMPTY_TTL_SEC = 15 * 60

    def get_related_mix(self, video_id: str) -> Optional[list]:
        """Return cached related-mix results for a seed video id, or None if
        missing or expired (15 minutes for empty results, 7 days otherwise). Results are returned as a parsed
        list (the same shape `get_related_videos` produces). The TTL check is
        done in SQL so it works with SQLite's text CURRENT_TIMESTAMP format."""
        if not video_id:
            return None
        cutoff = int(self._RELATED_MIX_TTL_SEC)
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT results_json FROM related_mix_cache
                WHERE video_id = ?
                  AND last_updated >= datetime('now', (CASE WHEN results_json = '[]' THEN ? ELSE ? END) || ' seconds')
                """,
                (video_id, -self._RELATED_MIX_EMPTY_TTL_SEC, -cutoff),
            ).fetchone()
            if not row:
                return None
            try:
                return json.loads(row["results_json"])
            except Exception:
                return None

    def get_related_mixes(self, video_ids: Iterable[str]) -> Dict[str, list]:
        """Cached related mixes for several seeds, in one query.

        The feed and the Auto Mode planner both look up a handful of seeds in a
        loop; one round trip serves them all. Seeds that are missing or past the
        TTL are simply absent from the result, so callers can treat a missing
        key exactly like `get_related_mix` returning None.
        """
        wanted = [str(v) for v in video_ids if v]
        if not wanted:
            return {}
        cutoff = int(self._RELATED_MIX_TTL_SEC)
        found: Dict[str, list] = {}
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            for offset in range(0, len(wanted), 500):
                batch = wanted[offset:offset + 500]
                placeholders = ",".join("?" * len(batch))
                rows = conn.execute(
                    f"""
                    SELECT video_id, results_json FROM related_mix_cache
                    WHERE video_id IN ({placeholders})
                      AND last_updated >= datetime('now', (CASE WHEN results_json = '[]' THEN ? ELSE ? END) || ' seconds')
                    """,
                    (*batch, -self._RELATED_MIX_EMPTY_TTL_SEC, -cutoff),
                ).fetchall()
                for row in rows:
                    try:
                        found[row["video_id"]] = json.loads(row["results_json"])
                    except Exception:
                        continue
        return found

    def set_related_mix(self, video_id: str, results: list) -> None:
        """Persist related-mix results for a seed video id (upsert). Empty
        results expire after 15 minutes so transient provider failures recover."""
        if not validate_youtube_video_id(video_id) or not isinstance(results, list):
            return
        payload = json.dumps(results)
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    INSERT INTO related_mix_cache (video_id, results_json, last_updated)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(video_id) DO UPDATE SET
                        results_json=excluded.results_json,
                        last_updated=CURRENT_TIMESTAMP
                    """,
                    (video_id, payload),
                )
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                logger.warning("Error caching related mix: %s", e)
