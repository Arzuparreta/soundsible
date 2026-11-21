"""Per-track listener state: ratings and plays.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import logging
from typing import List, Dict, Any, Optional


logger = logging.getLogger(__name__)


class TrackUserState:

    def get_track_user_state(self, track_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            from shared.collection import item_for_keys
            item_id = item_for_keys(conn, [f'item:{track_id}', f'lib:{track_id}'])
            if item_id:
                row = conn.execute('SELECT play_count,rating,last_played_at FROM collection_user_state WHERE item_id=?', (item_id,)).fetchone()
                return dict(row) if row else {'play_count': 0, 'rating': None, 'last_played_at': None}
            exists = conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone()
            if exists is None:
                return None
            row = conn.execute("""
                SELECT play_count, rating, last_played_at
                FROM track_user_state WHERE track_id = ?
            """, (track_id,)).fetchone()
            return dict(row) if row else {"play_count": 0, "rating": None, "last_played_at": None}

    def get_track_user_states(self, track_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        """Play count, rating and last-played for a whole list, in one query.

        Serializing a page of songs asks for this per track; one round trip per
        row is what turns a fifty-song album into fifty queries.
        """
        if not track_ids:
            return {}
        found: Dict[str, Dict[str, Any]] = {}
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            for offset in range(0, len(track_ids), 500):
                batch = track_ids[offset:offset + 500]
                placeholders = ",".join("?" for _ in batch)
                rows = conn.execute(f"""
                    SELECT track_id, play_count, rating, last_played_at
                    FROM track_user_state WHERE track_id IN ({placeholders})
                """, tuple(batch)).fetchall()
                for row in rows:
                    found[str(row["track_id"])] = dict(row)
        return {
            track_id: found.get(track_id, {"play_count": 0, "rating": None, "last_played_at": None})
            for track_id in track_ids
        }

    def get_all_track_user_states(self) -> Dict[str, Dict[str, Any]]:
        """Play count, rating and last-played for every track with recorded state."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT track_id, play_count, rating, last_played_at
                FROM track_user_state
            """).fetchall()
            return {str(row["track_id"]): dict(row) for row in rows}

    def set_track_rating(self, track_id: str, rating: Optional[int]) -> bool:
        if rating is not None and (not isinstance(rating, int) or isinstance(rating, bool) or not 1 <= rating <= 5):
            raise ValueError("rating must be null or an integer from 1 to 5")
        with self._get_connection() as conn:
            from shared.collection import item_for_keys, project_user_state
            item_id = item_for_keys(conn, [f'item:{track_id}', f'lib:{track_id}'])
            if item_id:
                conn.execute('INSERT INTO collection_user_state(item_id,rating) VALUES (?,?) '
                             'ON CONFLICT(item_id) DO UPDATE SET rating=excluded.rating', (item_id, rating))
                project_user_state(conn, item_id)
                return True
            if conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone() is None:
                return False
            conn.execute("""
                INSERT INTO track_user_state (track_id, rating)
                VALUES (?, ?)
                ON CONFLICT(track_id) DO UPDATE SET
                    rating=excluded.rating,
                    updated_at=CURRENT_TIMESTAMP
            """, (track_id, rating))
            return True

    def record_track_play(self, track_id: str, played_at: int) -> bool:
        if not isinstance(played_at, int) or isinstance(played_at, bool) or played_at < 0:
            raise ValueError("played_at must be a non-negative Unix timestamp")
        with self._get_connection() as conn:
            from shared.collection import item_for_keys, project_user_state
            item_id = item_for_keys(conn, [f'item:{track_id}', f'lib:{track_id}', f'yt:{track_id}'])
            if item_id:
                conn.execute('''INSERT INTO collection_user_state(item_id,play_count,last_played_at) VALUES (?,1,?)
                    ON CONFLICT(item_id) DO UPDATE SET play_count=play_count+1,
                    last_played_at=MAX(COALESCE(last_played_at,0),excluded.last_played_at)''', (item_id, played_at))
                project_user_state(conn, item_id)
                return True
            if conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone() is None:
                return False
            conn.execute("""
                INSERT INTO track_user_state (track_id, play_count, last_played_at)
                VALUES (?, 1, ?)
                ON CONFLICT(track_id) DO UPDATE SET
                    play_count=track_user_state.play_count + 1,
                    last_played_at=MAX(COALESCE(track_user_state.last_played_at, 0), excluded.last_played_at),
                    updated_at=CURRENT_TIMESTAMP
            """, (track_id, played_at))
            return True
