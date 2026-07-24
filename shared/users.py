"""
Accounts and sessions for a multi-user Soundsible instance.

Policy lives here; raw rows live in :mod:`shared.database` (``instance.db``).

The instance starts in a deliberately frictionless state: one account, no
password, no login screen — exactly how a single-user install behaves today.
:func:`instance_requires_login` flips to ``True`` the moment that stops being
true (a second account exists, or the only account has a password), and from
then on every API call needs a session.

Sessions are opaque 32-byte tokens stored only as SHA-256 hashes in
``auth_tokens`` with ``kind='session'``, handed to the browser in an HttpOnly
cookie. That keeps them revocable from the admin panel and makes Socket.IO
authentication free — the cookie rides along with the handshake.
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from werkzeug.security import check_password_hash, generate_password_hash

from shared.database import instance_db
from shared.hardening import (
    SCOPE_ADMIN_CONFIG,
    SCOPE_ADMIN_DANGEROUS,
    SCOPE_ADMIN_INSTANCE,
    SCOPE_DOWNLOAD_ADD,
    SCOPE_LIBRARY_READ,
    SCOPE_LIBRARY_WRITE,
    SCOPE_PLAYBACK_CONTROL,
)

logger = logging.getLogger(__name__)

ROLE_ADMIN = "admin"
ROLE_MEMBER = "member"

SESSION_KIND = "session"
SESSION_COOKIE_NAME = "sb_session"
SESSION_TTL_DAYS = 90

USERNAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$")

# Palette reused for generated avatars so a fresh account already looks placed
# rather than grey. Matches the accent range in DESIGN.md.
AVATAR_COLORS = ("#E0BC00", "#4F9DDE", "#E0685A", "#5FBF87", "#A97BD6", "#E09B4F")

MEMBER_SCOPES = (
    SCOPE_LIBRARY_READ,
    SCOPE_LIBRARY_WRITE,
    SCOPE_PLAYBACK_CONTROL,
    SCOPE_DOWNLOAD_ADD,
    SCOPE_ADMIN_CONFIG,
)

ADMIN_SCOPES = MEMBER_SCOPES + (SCOPE_ADMIN_INSTANCE, SCOPE_ADMIN_DANGEROUS)


class UserError(ValueError):
    """A user-facing problem with an account operation (bad name, duplicate, …)."""


def scopes_for_role(role: str) -> list[str]:
    """Scopes granted to a session for ``role``."""
    return sorted(ADMIN_SCOPES if role == ROLE_ADMIN else MEMBER_SCOPES)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _public_user(row: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Strip the password hash and normalize flags for API responses."""
    if not row:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row.get("display_name") or row["username"],
        "avatar_color": row.get("avatar_color"),
        "role": row.get("role") or ROLE_MEMBER,
        "has_password": bool(row.get("password_hash")),
        "created_at": row.get("created_at"),
        "disabled": bool(row.get("disabled_at")),
    }


def normalize_username(raw: str) -> str:
    username = str(raw or "").strip()
    if not USERNAME_RE.match(username):
        raise UserError(
            "Username must be 2-32 characters: letters, digits, dot, dash or underscore."
        )
    return username


def validate_password(raw: str) -> str:
    # No length or complexity rules — this is a home instance and the owner's
    # call. The only thing rejected is an empty password, which would be
    # indistinguishable from "no password" (a separate, deliberate state).
    password = str(raw or "")
    if not password:
        raise UserError("Password cannot be empty.")
    return password


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------


def list_users(*, include_disabled: bool = True) -> list[dict[str, Any]]:
    return [_public_user(row) for row in instance_db().list_user_rows(include_disabled=include_disabled)]


def get_user(user_id: str) -> Optional[dict[str, Any]]:
    return _public_user(instance_db().get_user_row(user_id))


def get_user_by_username(username: str) -> Optional[dict[str, Any]]:
    return _public_user(instance_db().get_user_row_by_username(username))


def count_users(*, include_disabled: bool = False) -> int:
    return instance_db().count_users(include_disabled=include_disabled)


def create_user(
    username: str,
    *,
    password: Optional[str] = None,
    display_name: Optional[str] = None,
    role: str = ROLE_MEMBER,
    avatar_color: Optional[str] = None,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """Create an account. Raises :class:`UserError` on a bad or duplicate name."""
    name = normalize_username(username)
    if role not in (ROLE_ADMIN, ROLE_MEMBER):
        raise UserError(f"Unknown role: {role!r}")

    db = instance_db()
    if db.get_user_row_by_username(name):
        raise UserError(f"There is already an account named {name!r}.")

    new_id = user_id or uuid.uuid4().hex
    password_hash = generate_password_hash(validate_password(password)) if password else None
    color = avatar_color or AVATAR_COLORS[db.count_users(include_disabled=True) % len(AVATAR_COLORS)]

    row = db.create_user_row(
        new_id,
        username=name,
        display_name=(display_name or name).strip() or name,
        avatar_color=color,
        password_hash=password_hash,
        role=role,
    )
    logger.info("users: created %s account %r (%s)", role, name, new_id)
    return _public_user(row)


def update_user(
    user_id: str,
    *,
    display_name: Optional[str] = None,
    avatar_color: Optional[str] = None,
    role: Optional[str] = None,
    username: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    db = instance_db()
    current = db.get_user_row(user_id)
    if not current:
        return None

    patch: dict[str, Any] = {}
    if username is not None:
        name = normalize_username(username)
        existing = db.get_user_row_by_username(name)
        if existing and existing["id"] != user_id:
            raise UserError(f"There is already an account named {name!r}.")
        patch["username"] = name
    if display_name is not None:
        patch["display_name"] = str(display_name).strip() or current["username"]
    if avatar_color is not None:
        patch["avatar_color"] = str(avatar_color).strip() or None
    if role is not None:
        if role not in (ROLE_ADMIN, ROLE_MEMBER):
            raise UserError(f"Unknown role: {role!r}")
        if current.get("role") == ROLE_ADMIN and role != ROLE_ADMIN and _admin_count(db) <= 1:
            raise UserError("The instance needs at least one admin.")
        patch["role"] = role

    row = db.update_user_row(user_id, **patch)
    if role is not None:
        # Scopes are baked into live sessions; force a re-login so the change lands.
        revoke_user_sessions(user_id)
    return _public_user(row)


def set_password(user_id: str, password: Optional[str], *, revoke_sessions: bool = True) -> bool:
    """Set or clear a password. Clearing is only allowed while login is optional."""
    db = instance_db()
    if not db.get_user_row(user_id):
        return False
    if password is None:
        if instance_requires_login(exclude_user_id=user_id):
            raise UserError("This instance requires a password for every account.")
        password_hash = None
    else:
        password_hash = generate_password_hash(validate_password(password))
    db.update_user_row(user_id, password_hash=password_hash)
    if revoke_sessions:
        revoke_user_sessions(user_id)
    return True


def verify_password(user_id: str, password: str) -> bool:
    row = instance_db().get_user_row(user_id)
    if not row or row.get("disabled_at"):
        return False
    stored = row.get("password_hash")
    if not stored:
        # Passwordless accounts only exist while the instance needs no login.
        return not instance_requires_login()
    return check_password_hash(stored, str(password or ""))


def set_disabled(user_id: str, disabled: bool) -> Optional[dict[str, Any]]:
    db = instance_db()
    current = db.get_user_row(user_id)
    if not current:
        return None
    if disabled and current.get("role") == ROLE_ADMIN and _admin_count(db) <= 1:
        raise UserError("The instance needs at least one active admin.")
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if disabled else None
    row = db.update_user_row(user_id, disabled_at=timestamp)
    if disabled:
        revoke_user_sessions(user_id)
    return _public_user(row)


def delete_user(user_id: str, *, purge_files: bool = True) -> bool:
    """Delete an account and, by default, its personal directories.

    Never touches the shared track pool — other people's libraries point at the
    same content-addressed files.
    """
    db = instance_db()
    current = db.get_user_row(user_id)
    if not current:
        return False
    if current.get("role") == ROLE_ADMIN and _admin_count(db) <= 1:
        raise UserError("The instance needs at least one admin.")

    db.delete_user_row(user_id)
    if purge_files:
        from shared.user_context import user_config_dir, user_data_dir

        for path in (user_config_dir(user_id, create=False), user_data_dir(user_id, create=False)):
            try:
                shutil.rmtree(path)
            except FileNotFoundError:
                pass
            except OSError as e:
                logger.warning("users: could not remove %s for deleted account: %s", path, e)
    logger.info("users: deleted account %r (%s)", current.get("username"), user_id)
    return True


def _admin_count(db) -> int:
    return sum(
        1
        for row in db.list_user_rows(include_disabled=False)
        if (row.get("role") or ROLE_MEMBER) == ROLE_ADMIN
    )


def get_admin_user() -> Optional[dict[str, Any]]:
    """First active admin — the identity the desktop owner token maps to."""
    for row in instance_db().list_user_rows(include_disabled=False):
        if (row.get("role") or ROLE_MEMBER) == ROLE_ADMIN:
            return _public_user(row)
    return None


# ---------------------------------------------------------------------------
# Login policy
# ---------------------------------------------------------------------------


def instance_requires_login(*, exclude_user_id: Optional[str] = None) -> bool:
    """Whether callers must authenticate.

    ``False`` only in the one case worth protecting: a single account with no
    password, which is what a migrated single-user install looks like.
    """
    rows = [
        row
        for row in instance_db().list_user_rows(include_disabled=False)
        if row["id"] != exclude_user_id
    ]
    if len(rows) != 1:
        return bool(rows)
    return bool(rows[0].get("password_hash"))


def instance_has_multiple_users() -> bool:
    """True once the music folder's ``library.json`` stops being one person's manifest.

    With a single account the pool and that account's library are the same set,
    so the legacy "adopt whatever is in the music folder" behaviour is still
    correct. With two, that file is the instance catalog — adopting it wholesale
    would pull somebody else's downloads into your library.
    """
    try:
        return instance_db().count_users(include_disabled=True) > 1
    except Exception:  # pragma: no cover - a missing DB must not break saves
        return False


def sole_passwordless_user() -> Optional[dict[str, Any]]:
    """The account to bind automatically when no login is required."""
    if instance_requires_login():
        return None
    rows = instance_db().list_user_rows(include_disabled=False)
    return _public_user(rows[0]) if rows else None


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def create_session(user_id: str, *, device_name: Optional[str] = None) -> tuple[str, dict[str, Any]]:
    """Mint a session token for ``user_id``. Returns ``(token, record)``.

    The plaintext token is returned once — only its hash is stored.
    """
    row = instance_db().get_user_row(user_id)
    if not row or row.get("disabled_at"):
        raise UserError("Account is not available.")

    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    record = instance_db().create_auth_token(
        uuid.uuid4().hex,
        _hash_token(token),
        kind=SESSION_KIND,
        scopes=scopes_for_role(row.get("role") or ROLE_MEMBER),
        name=device_name or "Soundsible session",
        device_type="web",
        expires_at=expires_at,
        user_id=user_id,
    )
    return token, record


def revoke_session_token(token: str) -> bool:
    record = instance_db().get_auth_token_by_hash(_hash_token(token))
    if not record or record.get("kind") != SESSION_KIND:
        return False
    instance_db().revoke_auth_token(record["id"])
    return True


def revoke_user_sessions(user_id: str) -> int:
    """Revoke every live session for a user (role change, password change, disable)."""
    db = instance_db()
    sessions = [
        record
        for record in db.list_auth_tokens(kind=SESSION_KIND, user_id=user_id)
        if not record.get("revoked_at")
    ]
    for record in sessions:
        db.revoke_auth_token(record["id"])
    return len(sessions)


def list_user_sessions(user_id: str) -> list[dict[str, Any]]:
    return [
        record
        for record in instance_db().list_auth_tokens(kind=SESSION_KIND, user_id=user_id)
        if not record.get("revoked_at")
    ]


# ---------------------------------------------------------------------------
# Invitations
# ---------------------------------------------------------------------------

INVITE_TTL_DAYS = 7


def _public_invite(row: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not row:
        return None
    return {
        "id": row["id"],
        "display_name": row.get("display_name"),
        "role": row.get("role") or ROLE_MEMBER,
        "created_at": row.get("created_at"),
        "expires_at": row.get("expires_at"),
        "used": bool(row.get("used_at")),
        "revoked": bool(row.get("revoked_at")),
    }


def create_invite(
    *,
    role: str = ROLE_MEMBER,
    created_by: Optional[str] = None,
    ttl_days: int = INVITE_TTL_DAYS,
) -> tuple[str, dict[str, Any]]:
    """Mint a one-time invitation. Returns ``(token, record)``.

    Invitations carry no name: whoever redeems one picks their own. The
    plaintext token is returned once — only its hash is stored, so the link in
    somebody's chat history is the only copy.
    """
    if role not in (ROLE_ADMIN, ROLE_MEMBER):
        raise UserError(f"Unknown role: {role!r}")

    token = secrets.token_urlsafe(24)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=max(1, ttl_days))).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    row = instance_db().create_invite_row(
        uuid.uuid4().hex,
        _hash_token(token),
        expires_at=expires_at,
        role=role,
        created_by=created_by,
    )
    logger.info("users: created invite %s (role=%s)", row["id"], role)
    return token, _public_invite(row)


def peek_invite(token: str) -> Optional[dict[str, Any]]:
    """Validate a token without consuming it (for the redemption screen)."""
    return _public_invite(instance_db().get_invite_by_hash(_hash_token(token)))


def list_invites() -> list[dict[str, Any]]:
    return [_public_invite(row) for row in instance_db().list_invite_rows()]


def revoke_invite(invite_id: str) -> bool:
    return instance_db().revoke_invite(invite_id)


def redeem_invite(token: str, *, username: str, password: str) -> dict[str, Any]:
    """Create the account an invitation stands for.

    The invite is consumed *before* the account is created, so two taps on the
    same link cannot mint two accounts.
    """
    db = instance_db()
    row = db.get_invite_by_hash(_hash_token(token))
    if not row:
        raise UserError("This invitation is no longer valid.")

    name = normalize_username(username)
    validate_password(password)
    if db.get_user_row_by_username(name):
        raise UserError(f"There is already an account named {name!r}.")

    placeholder_id = uuid.uuid4().hex
    if not db.consume_invite(row["id"], created_user_id=placeholder_id):
        raise UserError("This invitation has already been used.")

    # The account's name is whatever the person chose — an invitation carries no
    # identity, so nobody is greeted by a name the admin picked for them.
    return create_user(
        name,
        password=password,
        role=row.get("role") or ROLE_MEMBER,
        user_id=placeholder_id,
    )


def authenticate(username: str, password: str) -> Optional[dict[str, Any]]:
    """Return the public user record when the credentials check out."""
    row = instance_db().get_user_row_by_username(username)
    if not row or row.get("disabled_at"):
        # Spend the time anyway so a missing account is not obviously faster.
        check_password_hash(generate_password_hash("timing-equalizer"), str(password or ""))
        return None
    if not verify_password(row["id"], password):
        return None
    return _public_user(row)
