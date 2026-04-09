"""
Security hardening helpers for LAN/Tailscale deployments.
"""

from __future__ import annotations

import os
import time
import threading
from collections import defaultdict
from functools import wraps
from typing import Callable

from flask import jsonify, request

from shared.security import is_trusted_network


def _read_admin_token() -> str:
    return (os.getenv("SOUNDSIBLE_ADMIN_TOKEN") or "").strip()


def _request_supplied_admin_token() -> str:
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("X-Soundsible-Admin-Token") or "").strip()


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
    configured = _read_admin_token()
    if configured:
        return has_valid_admin_token()
    if allow_trusted_network:
        return is_trusted_network(request.remote_addr)
    return False


def require_admin(*, allow_trusted_network: bool = True):
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if is_admin_request(allow_trusted_network=allow_trusted_network):
                return fn(*args, **kwargs)
            msg = (
                "Admin token required."
                if _read_admin_token()
                else "Admin actions restricted to Home Network / Tailscale."
            )
            return jsonify({"error": msg}), 403

        return wrapped

    return decorator


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
        "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; "
        "style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self' http: https: ws: wss:;",
    )
    return resp

