"""
Security hardening helpers for LAN/Tailscale deployments.
"""

from __future__ import annotations

import os
import time
import threading
import hashlib
import logging
from collections import defaultdict
from functools import wraps
from typing import Callable, Iterable, Optional

from flask import g, jsonify, request

from shared.database import instance_db
from shared.runtime import get_runtime_config
from shared.security import is_trusted_network

logger = logging.getLogger(__name__)

SCOPE_LIBRARY_READ = "library:read"
SCOPE_PLAYBACK_CONTROL = "playback:control"
SCOPE_DOWNLOAD_ADD = "download:add"
SCOPE_LIBRARY_WRITE = "library:write"
SCOPE_ADMIN_CONFIG = "admin:config"
SCOPE_ADMIN_DANGEROUS = "admin:dangerous"
# Machine-level settings: music folder, storage backend, downloader tuning,
# accounts. `admin:config` stays what a member needs for their own preferences.
SCOPE_ADMIN_INSTANCE = "admin:instance"

ALL_SCOPES = {
    SCOPE_LIBRARY_READ,
    SCOPE_PLAYBACK_CONTROL,
    SCOPE_DOWNLOAD_ADD,
    SCOPE_LIBRARY_WRITE,
    SCOPE_ADMIN_CONFIG,
    SCOPE_ADMIN_DANGEROUS,
    SCOPE_ADMIN_INSTANCE,
}

LEGACY_AGENT_SCOPES = {
    SCOPE_LIBRARY_READ,
    SCOPE_PLAYBACK_CONTROL,
    SCOPE_DOWNLOAD_ADD,
}


def _db():
    """Accounts and credentials live in the instance database, never a user's."""
    return instance_db()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _request_session_token() -> str:
    from shared.users import SESSION_COOKIE_NAME

    return (request.cookies.get(SESSION_COOKIE_NAME) or "").strip()


def _read_admin_token() -> str:
    return (os.getenv("SOUNDSIBLE_ADMIN_TOKEN") or "").strip()


def _request_supplied_admin_token() -> str:
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("X-Soundsible-Admin-Token") or "").strip()


def _request_supplied_agent_token() -> str:
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("X-Soundsible-Agent-Token") or "").strip()


def _request_supplied_token() -> str:
    for candidate in (
        _request_supplied_admin_token(),
        _request_supplied_agent_token(),
    ):
        if candidate:
            return candidate
    return ""


def _normalize_scope_list(scopes: Optional[Iterable[str]]) -> set[str]:
    return {str(scope).strip() for scope in (scopes or []) if str(scope).strip()}


def _legacy_trusted_network_allowed() -> bool:
    """Trusted-LAN-as-owner compatibility.

    Only survives while the instance needs no login (one account, no password).
    As soon as a second person exists, a LAN address proves nothing about who
    is calling, so the compatibility path shuts off.
    """
    from shared.users import instance_requires_login

    if instance_requires_login():
        return False
    runtime = get_runtime_config()
    return bool(runtime.advanced_mode)


def _resolve_owner_user_id() -> Optional[str]:
    """Identity behind credentials that predate accounts (desktop owner token)."""
    from shared.users import get_admin_user

    admin = get_admin_user()
    return admin["id"] if admin else None


def _legacy_agent_context(record: dict) -> dict:
    return {
        "source": "legacy_agent_token",
        "kind": "agent",
        "scopes": set(LEGACY_AGENT_SCOPES),
        "record": {k: v for k, v in record.items() if k != "token_hash"},
    }


def _context_from_stored_token(record: dict) -> Optional[dict]:
    kind = record.get("kind") or "agent"
    context = {
        "source": "auth_token",
        "kind": kind,
        "scopes": _normalize_scope_list(record.get("scopes")),
        "record": {k: v for k, v in record.items() if k != "token_hash"},
        "user_id": record.get("user_id") or None,
    }
    if context["user_id"]:
        return context

    # Only the desktop owner token may borrow the admin's identity: it lives in
    # a 0600 file on the machine itself, so holding it already implies control
    # of the box. An `agent` or `paired_device` row without a user_id predates
    # accounts and belongs to nobody — treating it as the admin would let any
    # member mint a credential that reads someone else's library.
    if kind == "owner":
        context["user_id"] = _resolve_owner_user_id()
        return context

    logger.warning(
        "Rejecting %s token %s: no account attached.",
        kind,
        str(record.get("id"))[:8],
    )
    return None


def get_request_auth_context(*, allow_trusted_network: bool = False) -> Optional[dict]:
    cached = getattr(g, "_soundsible_auth_context", None)
    if cached is not None:
        return cached

    context = None

    session_token = _request_session_token()
    if session_token:
        record = _db().get_auth_token_by_hash(_hash_token(session_token))
        if record and record.get("kind") == "session" and record.get("user_id"):
            _db().touch_auth_token(record["id"])
            context = {
                "source": "session",
                "kind": "session",
                "scopes": _normalize_scope_list(record.get("scopes")),
                "record": {k: v for k, v in record.items() if k != "token_hash"},
                "user_id": record["user_id"],
            }

    token = _request_supplied_token() if context is None else ""
    if token:
        token_hash = _hash_token(token)
        record = _db().get_auth_token_by_hash(token_hash)
        if record:
            _db().touch_auth_token(record["id"])
            context = _context_from_stored_token(record)
        elif has_valid_admin_token():
            context = {
                "source": "legacy_admin_env",
                "kind": "owner",
                "scopes": set(ALL_SCOPES),
                "record": {"name": "legacy-admin-env"},
                "user_id": _resolve_owner_user_id(),
            }
        else:
            legacy_agent = _db().get_agent_token_by_hash(token_hash)
            if legacy_agent:
                # The legacy `agent_tokens` table predates accounts, so its rows
                # name nobody. They stay usable while the instance still has a
                # single account; once several people share it, an unattributed
                # credential must not pick one of them.
                from shared.users import instance_requires_login

                if instance_requires_login():
                    logger.warning(
                        "Rejecting legacy agent token %s: no account attached.",
                        str(legacy_agent.get("id"))[:8],
                    )
                else:
                    _db().touch_agent_token(legacy_agent["id"])
                    context = _legacy_agent_context(legacy_agent)
                    context["user_id"] = _resolve_owner_user_id()

    if context is None and allow_trusted_network and _legacy_trusted_network_allowed():
        configured = _read_admin_token()
        if not configured and is_trusted_network(request.remote_addr):
            context = {
                "source": "legacy_trusted_network",
                "kind": "owner",
                "scopes": set(ALL_SCOPES),
                "record": {"name": "trusted-network-compat"},
                "user_id": _resolve_owner_user_id(),
            }

    g._soundsible_auth_context = context
    if context:
        g.auth_token = context.get("record")
    return context


def current_user_id_from_request() -> Optional[str]:
    """User behind this request, from whichever credential authenticated it."""
    context = get_request_auth_context(allow_trusted_network=True)
    return (context or {}).get("user_id")


def current_user() -> Optional[dict]:
    """Public account record for the requesting user, or ``None``."""
    from shared.users import get_user

    user_id = current_user_id_from_request()
    return get_user(user_id) if user_id else None


def request_is_admin_user() -> bool:
    """Whether the caller may change machine-level settings and accounts."""
    return request_has_scopes(SCOPE_ADMIN_INSTANCE, allow_trusted_network=True)


def request_has_scopes(*required_scopes: str, allow_trusted_network: bool = False) -> bool:
    context = get_request_auth_context(allow_trusted_network=allow_trusted_network)
    if not context:
        return False
    if context.get("kind") == "owner":
        return True
    required = _normalize_scope_list(required_scopes)
    return required.issubset(_normalize_scope_list(context.get("scopes")))


def has_valid_admin_token() -> bool:
    configured = _read_admin_token()
    if not configured:
        return False
    return _request_supplied_admin_token() == configured


def is_admin_request(*, allow_trusted_network: bool = True) -> bool:
    """
    Admin request policy:
    - If SOUNDSIBLE_ADMIN_TOKEN is configured: token is required for all admin routes.
    - If not configured: trusted LAN/Tailscale callers are allowed (compat mode).
    """
    return request_has_scopes(SCOPE_ADMIN_CONFIG, allow_trusted_network=allow_trusted_network)


def require_scope(*required_scopes: str, allow_trusted_network: bool = False):
    required = _normalize_scope_list(required_scopes)

    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            context = get_request_auth_context(allow_trusted_network=allow_trusted_network)
            if context:
                if context.get("kind") == "owner" or required.issubset(_normalize_scope_list(context.get("scopes"))):
                    return fn(*args, **kwargs)
                return jsonify({"error": "Insufficient token scope", "required_scopes": sorted(required)}), 403
            msg = (
                "Admin token required."
                if _read_admin_token()
                else "Authentication required."
            )
            return jsonify({"error": msg, "required_scopes": sorted(required)}), 403

        return wrapped

    return decorator


def require_any_scope(*acceptable_scopes: str, allow_trusted_network: bool = False):
    """Token must include at least one of the given scopes (owner always allowed)."""
    acceptable = _normalize_scope_list(acceptable_scopes)

    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            context = get_request_auth_context(allow_trusted_network=allow_trusted_network)
            if context:
                if context.get("kind") == "owner":
                    return fn(*args, **kwargs)
                have = _normalize_scope_list(context.get("scopes"))
                if have.intersection(acceptable):
                    return fn(*args, **kwargs)
                return jsonify(
                    {
                        "error": "Insufficient token scope",
                        "required_any_of": sorted(acceptable),
                    }
                ), 403
            msg = (
                "Admin token required."
                if _read_admin_token()
                else "Authentication required."
            )
            return jsonify({"error": msg, "required_any_of": sorted(acceptable)}), 403

        return wrapped

    return decorator


def require_admin(*, allow_trusted_network: bool = True):
    return require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=allow_trusted_network)


def require_instance_admin(*, allow_trusted_network: bool = True):
    """Guard machine-level settings and account management.

    Members hold ``admin:config`` for their own preferences; only an admin
    holds ``admin:instance``.
    """
    return require_scope(SCOPE_ADMIN_INSTANCE, allow_trusted_network=allow_trusted_network)


class _WindowRateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: dict[str, list[float]] = defaultdict(list)

    def allow(self, key: str, limit: int, window_sec: int) -> bool:
        now = time.time()
        with self._lock:
            events = self._events.get(key, [])
            events = [t for t in events if now - t < window_sec]
            if len(events) >= limit:
                self._events[key] = events
                return False
            events.append(now)
            self._events[key] = events
            return True


_rate_limiter = _WindowRateLimiter()


def rate_limit(action: str, *, limit: int, window_sec: int):
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            ip = request.remote_addr or "unknown"
            key = f"{action}:{ip}"
            if _rate_limiter.allow(key, limit, window_sec):
                return fn(*args, **kwargs)
            return jsonify({"error": "Too many requests"}), 429

        return wrapped

    return decorator


def apply_security_headers(resp):
    """
    Baseline security headers safe for LAN/Tailscale app delivery.
    """
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; "
        "img-src 'self' data: https:; media-src 'self' https:; "
        "style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self' http: https: ws: wss:;",
    )
    return resp
