"""Smart TV device authorization requests. Lives in the instance database.

One part of ``shared.database.DatabaseManager``; every method runs on the
manager and reaches SQLite through ``self._get_connection()``.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, Optional


class TvAuthStore:
    """Persistence for short-lived Smart TV sign-in authorization requests."""

    def _expire_stale_tv_auth_requests(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            UPDATE tv_auth_requests
            SET status = 'expired',
                updated_at = CURRENT_TIMESTAMP
            WHERE status IN ('pending', 'approved')
              AND expires_at <= CURRENT_TIMESTAMP
            """
        )

    def create_tv_auth_request(
        self,
        request_id: str,
        *,
        code_hash: str,
        handle_hash: str,
        device_name: str,
        expires_at: str,
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            # Sweep stale unredeemed requests after 1 day, and remove redeemed
            # rows only once their minted session token is missing, revoked, or expired
            # so active TV sessions remain manageable in /api/paired-devices.
            conn.execute(
                """
                DELETE FROM tv_auth_requests
                WHERE (
                    status != 'redeemed'
                    AND expires_at <= datetime('now', '-1 day')
                )
                OR (
                    status = 'redeemed'
                    AND expires_at <= datetime('now', '-1 day')
                    AND (
                        auth_token_id IS NULL
                        OR NOT EXISTS (
                            SELECT 1
                            FROM auth_tokens t
                            WHERE t.id = tv_auth_requests.auth_token_id
                              AND t.revoked_at IS NULL
                              AND (t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP)
                        )
                    )
                )
                """
            )
            conn.execute(
                """
                INSERT INTO tv_auth_requests (
                    id, code_hash, handle_hash, device_name, status, expires_at
                )
                VALUES (?, ?, ?, ?, 'pending', ?)
                """,
                (request_id, code_hash, handle_hash, device_name, expires_at),
            )
            row = conn.execute(
                "SELECT * FROM tv_auth_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
            return dict(row) if row else {}

    def get_tv_auth_request_by_handle_hash(self, handle_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            self._expire_stale_tv_auth_requests(conn)
            row = conn.execute(
                "SELECT * FROM tv_auth_requests WHERE handle_hash = ?",
                (handle_hash,),
            ).fetchone()
            return dict(row) if row else None

    def get_tv_auth_request_by_code_hash(self, code_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            self._expire_stale_tv_auth_requests(conn)
            row = conn.execute(
                "SELECT * FROM tv_auth_requests WHERE code_hash = ?",
                (code_hash,),
            ).fetchone()
            return dict(row) if row else None

    def approve_tv_auth_request_by_code_hash(
        self,
        code_hash: str,
        *,
        user_id: str,
    ) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            self._expire_stale_tv_auth_requests(conn)
            cursor = conn.execute(
                """
                UPDATE tv_auth_requests
                SET status = 'approved',
                    approved_user_id = ?,
                    approved_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE code_hash = ?
                  AND status = 'pending'
                  AND expires_at > CURRENT_TIMESTAMP
                """,
                (user_id, code_hash),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute(
                "SELECT * FROM tv_auth_requests WHERE code_hash = ?",
                (code_hash,),
            ).fetchone()
            return dict(row) if row else None

    def deny_tv_auth_request_by_code_hash(self, code_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            self._expire_stale_tv_auth_requests(conn)
            cursor = conn.execute(
                """
                UPDATE tv_auth_requests
                SET status = 'denied',
                    updated_at = CURRENT_TIMESTAMP
                WHERE code_hash = ?
                  AND status = 'pending'
                  AND expires_at > CURRENT_TIMESTAMP
                """,
                (code_hash,),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute(
                "SELECT * FROM tv_auth_requests WHERE code_hash = ?",
                (code_hash,),
            ).fetchone()
            return dict(row) if row else None

    def consume_tv_auth_request_by_handle_hash(self, handle_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            self._expire_stale_tv_auth_requests(conn)
            cursor = conn.execute(
                """
                UPDATE tv_auth_requests
                SET status = 'redeemed',
                    redeemed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE handle_hash = ?
                  AND status = 'approved'
                  AND expires_at > CURRENT_TIMESTAMP
                """,
                (handle_hash,),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute(
                "SELECT * FROM tv_auth_requests WHERE handle_hash = ?",
                (handle_hash,),
            ).fetchone()
            return dict(row) if row else None

    def attach_tv_auth_token(self, request_id: str, auth_token_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                UPDATE tv_auth_requests
                SET auth_token_id = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (auth_token_id, request_id),
            )

    def mark_tv_auth_cancelled(self, request_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                UPDATE tv_auth_requests
                SET status = 'cancelled',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (request_id,),
            )

    def cancel_tv_auth_request_by_handle_hash(self, handle_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            self._expire_stale_tv_auth_requests(conn)
            cursor = conn.execute(
                """
                UPDATE tv_auth_requests
                SET status = 'cancelled',
                    updated_at = CURRENT_TIMESTAMP
                WHERE handle_hash = ?
                  AND status IN ('pending', 'approved')
                  AND expires_at > CURRENT_TIMESTAMP
                """,
                (handle_hash,),
            )
            if cursor.rowcount != 1:
                return None
            row = conn.execute(
                "SELECT * FROM tv_auth_requests WHERE handle_hash = ?",
                (handle_hash,),
            ).fetchone()
            return dict(row) if row else None

    def list_tv_auth_session_ids(self, user_id: Optional[str]) -> set[str]:
        if not user_id:
            return set()
        with self._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT auth_token_id
                FROM tv_auth_requests
                WHERE approved_user_id = ?
                  AND status = 'redeemed'
                  AND auth_token_id IS NOT NULL
                """,
                (user_id,),
            ).fetchall()
            return {str(row[0]) for row in rows if row[0]}
