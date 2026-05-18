"""
Security hardening helpers for LAN/Tailscale deployments.
"""

from __future__ import annotations

import os
import time
import threading
import hashlib
from collections import defaultdict
from functools import wraps
from typing import Callable, Iterable, Optional

from flask import g, jsonify, request

from shared.database import DatabaseManager
from shared.runtime import get_runtime_config
from shared.security import is_trusted_network

SCOPE_LIBRARY_READ = "library:read"
SCOPE_PLAYBACK_CONTROL = "playback:control"
SCOPE_DOWNLOAD_ADD = "download:add"
SCOPE_LIBRARY_WRITE = "library:write"
SCOPE_ADMIN_CONFIG = "admin:config"
SCOPE_ADMIN_DANGEROUS = "admin:dangerous"

ALL_SCOPES = {
    SCOPE_LIBRARY_READ,
    SCOPE_PLAYBACK_CONTROL,
    SCOPE_DOWNLOAD_ADD,
    SCOPE_LIBRARY_WRITE,
    SCOPE_ADMIN_CONFIG,
    SCOPE_ADMIN_DANGEROUS,
}

LEGACY_AGENT_SCOPES = {
    SCOPE_LIBRARY_READ,
    SCOPE_PLAYBACK_CONTROL,
    SCOPE_DOWNLOAD_ADD,
}


def _db() -> DatabaseManager:
    return DatabaseManager()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


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
    runtime = get_runtime_config()
    return bool(runtime.advanced_mode)


def _legacy_agent_context(record: dict) -> dict:
    return {
        "source": "legacy_agent_token",
        "kind": "agent",
        "scopes": set(LEGACY_AGENT_SCOPES),
        "record": {k: v for k, v in record.items() if k != "token_hash"},
    }


def get_request_auth_context(*, allow_trusted_network: bool = False) -> Optional[dict]:
    cached = getattr(g, "_soundsible_auth_context", None)
    if cached is not None:
        return cached

    token = _request_supplied_token()
    context = None
    if token:
        token_hash = _hash_token(token)
        record = _db().get_auth_token_by_hash(token_hash)
        if record:
            _db().touch_auth_token(record["id"])
            context = {
                "source": "auth_token",
                "kind": record.get("kind") or "agent",
                "scopes": _normalize_scope_list(record.get("scopes")),
                "record": {k: v for k, v in record.items() if k != "token_hash"},
            }
        elif has_valid_admin_token():
            context = {
                "source": "legacy_admin_env",
                "kind": "owner",
                "scopes": set(ALL_SCOPES),
                "record": {"name": "legacy-admin-env"},
            }
        else:
            legacy_agent = _db().get_agent_token_by_hash(token_hash)
            if legacy_agent:
                _db().touch_agent_token(legacy_agent["id"])
                context = _legacy_agent_context(legacy_agent)

    if context is None and allow_trusted_network and _legacy_trusted_network_allowed():
        configured = _read_admin_token()
        if not configured and is_trusted_network(request.remote_addr):
            context = {
                "source": "legacy_trusted_network",
                "kind": "owner",
                "scopes": set(ALL_SCOPES),
                "record": {"name": "trusted-network-compat"},
            }

    g._soundsible_auth_context = context
    if context:
        g.auth_token = context.get("record")
    return context


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
