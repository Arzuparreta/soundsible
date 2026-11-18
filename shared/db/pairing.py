"""Device pairing sessions. These tables live in the instance database.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import json
import logging
from typing import List, Dict, Any, Optional


logger = logging.getLogger(__name__)


class PairingStore:

    def _decode_pairing_record(self, record: Dict[str, Any]) -> Dict[str, Any]:
        record["requested_scopes"] = self._decode_scopes(record.get("requested_scopes"))
        record["granted_scopes"] = self._decode_scopes(record.get("granted_scopes"))
        record["auto_confirm"] = bool(record.get("auto_confirm"))
        record["display_active"] = bool(record.get("display_active"))
        return record

    def create_pairing_session(
        self,
        session_id: str,
        *,
        code: str,
        requested_scopes: list[str],
        granted_scopes: list[str],
        expires_at: str,
        auto_confirm: bool = False,
        display_active: bool = False,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                INSERT INTO pairing_sessions (id, code, status, requested_scopes, granted_scopes, auto_confirm, display_active, expires_at, user_id)
                VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
            """, (
                session_id,
                code,
                json.dumps(sorted({scope for scope in requested_scopes if scope})),
                json.dumps(sorted({scope for scope in granted_scopes if scope})),
                1 if auto_confirm else 0,
                1 if display_active else 0,
                expires_at,
                user_id,
            ))
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else {}

    def get_pairing_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            if not row:
                return None
            return self._decode_pairing_record(dict(row))

    def get_pairing_session_by_code(self, code: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE code = ?
                  AND expires_at > CURRENT_TIMESTAMP
            """, (code,)).fetchone()
            if not row:
                return None
            return self._decode_pairing_record(dict(row))

    def list_pairing_sessions(self, *, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if user_id:
                rows = conn.execute("""
                    SELECT *
                    FROM pairing_sessions
                    WHERE user_id = ?
                    ORDER BY created_at DESC
                """, (user_id,)).fetchall()
            else:
                rows = conn.execute("""
                    SELECT *
                    FROM pairing_sessions
                    ORDER BY created_at DESC
                """).fetchall()
            records = [dict(row) for row in rows]
            for record in records:
                self._decode_pairing_record(record)
            return records

    def claim_pairing_session(self, session_id: str, *, device_name: str, device_type: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                UPDATE pairing_sessions
                SET status = 'claimed',
                    device_name = ?,
                    device_type = ?,
                    claimed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND status = 'pending'
                  AND expires_at > CURRENT_TIMESTAMP
            """, (device_name, device_type, session_id))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None

    def confirm_pairing_session(self, session_id: str, *, auth_token_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                UPDATE pairing_sessions
                SET status = 'completed',
                    auth_token_id = ?,
                    owner_confirmed_at = CURRENT_TIMESTAMP,
                    completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND status = 'claimed'
                  AND expires_at > CURRENT_TIMESTAMP
            """, (auth_token_id, session_id))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None

    def cancel_pairing_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                UPDATE pairing_sessions
                SET status = 'cancelled',
                    display_active = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND status IN ('pending', 'claimed')
            """, (session_id,))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None

    def set_pairing_session_display_state(
        self,
        session_id: str,
        *,
        display_active: bool,
        auto_confirm: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if auto_confirm is None:
                conn.execute("""
                    UPDATE pairing_sessions
                    SET display_active = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                      AND status IN ('pending', 'claimed')
                """, (1 if display_active else 0, session_id))
            else:
                conn.execute("""
                    UPDATE pairing_sessions
                    SET display_active = ?,
                        auto_confirm = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                      AND status IN ('pending', 'claimed')
                """, (1 if display_active else 0, 1 if auto_confirm else 0, session_id))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None
