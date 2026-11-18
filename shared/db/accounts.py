"""Accounts, invitations, auth and agent tokens, and Subsonic credentials. These
tables live in the instance database.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import json
import logging
from typing import List, Dict, Any, Optional


logger = logging.getLogger(__name__)


class AccountStore:

    # Note: Agent token storage

    def _decode_scopes(self, raw: Any) -> list[str]:
        if isinstance(raw, list):
            return [str(item) for item in raw if str(item).strip()]
        if not raw:
            return []
        try:
            decoded = json.loads(raw)
        except Exception:
            return []
        if not isinstance(decoded, list):
            return []
        return [str(item) for item in decoded if str(item).strip()]

    def create_auth_token(
        self,
        token_id: str,
        token_hash: str,
        *,
        kind: str,
        scopes: list[str],
        name: Optional[str] = None,
        device_type: Optional[str] = None,
        expires_at: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        encoded_scopes = json.dumps(sorted({scope for scope in scopes if scope}))
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO auth_tokens (id, name, token_hash, kind, device_type, scopes, expires_at, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                token_id,
                name or None,
                token_hash,
                kind,
                device_type or None,
                encoded_scopes,
                expires_at,
                user_id or None,
            ))
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, kind, device_type, scopes, user_id, created_at, last_used_at, expires_at, revoked_at
                FROM auth_tokens
                WHERE id = ?
            """, (token_id,)).fetchone()
            record = dict(row)
            record["scopes"] = self._decode_scopes(record.get("scopes"))
            return record

    def get_auth_token_by_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, token_hash, kind, device_type, scopes, user_id,
                       created_at, last_used_at, expires_at, revoked_at
                FROM auth_tokens
                WHERE token_hash = ?
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            """, (token_hash,)).fetchone()
            if not row:
                return None
            record = dict(row)
            record["scopes"] = self._decode_scopes(record.get("scopes"))
            return record

    def touch_auth_token(self, token_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE auth_tokens
                SET last_used_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL
            """, (token_id,))

    def revoke_auth_token(self, token_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE auth_tokens
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL
            """, (token_id,))

    def revoke_auth_tokens_by_kind(self, kind: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE auth_tokens
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE kind = ? AND revoked_at IS NULL
            """, (kind,))

    def list_auth_tokens(
        self,
        *,
        kind: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        columns = (
            "id, name, kind, device_type, scopes, user_id, "
            "created_at, last_used_at, expires_at, revoked_at"
        )
        filters = []
        params: list[Any] = []
        if kind:
            filters.append("kind = ?")
            params.append(kind)
        if user_id:
            filters.append("user_id = ?")
            params.append(user_id)
        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT {columns} FROM auth_tokens {where} ORDER BY created_at DESC",
                tuple(params),
            ).fetchall()
            records = [dict(row) for row in rows]
            for record in records:
                record["scopes"] = self._decode_scopes(record.get("scopes"))
            return records

    def get_auth_token(self, token_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, kind, device_type, scopes, user_id,
                       created_at, last_used_at, expires_at, revoked_at
                FROM auth_tokens
                WHERE id = ?
            """, (token_id,)).fetchone()
            if not row:
                return None
            record = dict(row)
            record["scopes"] = self._decode_scopes(record.get("scopes"))
            return record

    # Note: Subsonic credentials (instance database)

    def set_subsonic_credential(self, user_id: str, secret_enc: str) -> Dict[str, Any]:
        """Store (or replace) one account's Subsonic credential."""
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO subsonic_credentials (user_id, secret_enc)
                VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    secret_enc=excluded.secret_enc,
                    created_at=CURRENT_TIMESTAMP,
                    last_used_at=NULL,
                    last_client=NULL
            """, (user_id, secret_enc))
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT user_id, created_at, last_used_at, last_client FROM subsonic_credentials WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return dict(row)

    def get_subsonic_credential(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT user_id, secret_enc, created_at, last_used_at, last_client
                FROM subsonic_credentials WHERE user_id = ?
            """, (user_id,)).fetchone()
            return dict(row) if row else None

    def touch_subsonic_credential(self, user_id: str, client: Optional[str] = None) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE subsonic_credentials
                SET last_used_at = CURRENT_TIMESTAMP,
                    last_client = COALESCE(?, last_client)
                WHERE user_id = ?
            """, (client or None, user_id))

    def delete_subsonic_credential(self, user_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute("DELETE FROM subsonic_credentials WHERE user_id = ?", (user_id,))
            return bool(cursor.rowcount)

    def create_agent_token(self, token_id: str, token_hash: str, name: Optional[str] = None) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO agent_tokens (id, name, token_hash)
                VALUES (?, ?, ?)
            """, (token_id, name or None, token_hash))
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, created_at, last_used_at, revoked_at
                FROM agent_tokens
                WHERE id = ?
            """, (token_id,)).fetchone()
            return dict(row)

    def get_agent_token_by_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, token_hash, created_at, last_used_at, revoked_at
                FROM agent_tokens
                WHERE token_hash = ? AND revoked_at IS NULL
            """, (token_hash,)).fetchone()
            return dict(row) if row else None

    def touch_agent_token(self, token_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE agent_tokens
                SET last_used_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL
            """, (token_id,))

    # Note: Accounts (instance database only)

    _USER_COLUMNS = (
        "id, username, username_folded, display_name, avatar_color, password_hash, "
        "role, created_at, updated_at, disabled_at"
    )

    def create_user_row(
        self,
        user_id: str,
        *,
        username: str,
        display_name: Optional[str] = None,
        avatar_color: Optional[str] = None,
        password_hash: Optional[str] = None,
        role: str = "member",
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO users (id, username, username_folded, display_name, avatar_color, password_hash, role)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                user_id,
                username,
                username.casefold(),
                display_name or username,
                avatar_color or None,
                password_hash or None,
                role,
            ))
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            return dict(row)

    def get_user_row(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_user_row_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users WHERE username_folded = ?",
                (str(username or "").casefold(),),
            ).fetchone()
            return dict(row) if row else None

    def list_user_rows(self, *, include_disabled: bool = True) -> List[Dict[str, Any]]:
        clause = "" if include_disabled else "WHERE disabled_at IS NULL"
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users {clause} ORDER BY created_at ASC"
            ).fetchall()
            return [dict(row) for row in rows]

    def update_user_row(self, user_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
        """Patch a user row. Only known columns are accepted."""
        allowed = {"username", "display_name", "avatar_color", "password_hash", "role", "disabled_at"}
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self.get_user_row(user_id)
        if "username" in updates:
            updates["username_folded"] = str(updates["username"]).casefold()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with self._get_connection() as conn:
            conn.execute(
                f"UPDATE users SET {assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (*updates.values(), user_id),
            )
        return self.get_user_row(user_id)

    def delete_user_row(self, user_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            conn.execute("""
                UPDATE auth_tokens
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND revoked_at IS NULL
            """, (user_id,))
            return cursor.rowcount > 0

    # Note: Invitations (instance database only)

    _INVITE_COLUMNS = (
        "id, display_name, role, created_by, created_at, expires_at, used_at, "
        "created_user_id, revoked_at"
    )

    def create_invite_row(
        self,
        invite_id: str,
        token_hash: str,
        *,
        expires_at: str,
        display_name: Optional[str] = None,
        role: str = "member",
        created_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO invites (id, token_hash, display_name, role, created_by, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (invite_id, token_hash, display_name or None, role, created_by, expires_at))
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._INVITE_COLUMNS} FROM invites WHERE id = ?", (invite_id,)
            ).fetchone()
            return dict(row)

    def get_invite_by_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        """Return a still-redeemable invite, or ``None``."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(f"""
                SELECT {self._INVITE_COLUMNS}
                FROM invites
                WHERE token_hash = ?
                  AND used_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > CURRENT_TIMESTAMP
            """, (token_hash,)).fetchone()
            return dict(row) if row else None

    def consume_invite(self, invite_id: str, *, created_user_id: str) -> bool:
        """Mark an invite used. Returns False if somebody got there first."""
        with self._get_connection() as conn:
            cursor = conn.execute("""
                UPDATE invites
                SET used_at = CURRENT_TIMESTAMP, created_user_id = ?
                WHERE id = ?
                  AND used_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > CURRENT_TIMESTAMP
            """, (created_user_id, invite_id))
            return cursor.rowcount > 0

    def list_invite_rows(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT {self._INVITE_COLUMNS} FROM invites ORDER BY created_at DESC"
            ).fetchall()
            return [dict(row) for row in rows]

    def revoke_invite(self, invite_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute("""
                UPDATE invites
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL
            """, (invite_id,))
            return cursor.rowcount > 0

    def count_users(self, *, include_disabled: bool = False) -> int:
        clause = "" if include_disabled else "WHERE disabled_at IS NULL"
        with self._get_connection() as conn:
            return int(conn.execute(f"SELECT COUNT(*) FROM users {clause}").fetchone()[0])
