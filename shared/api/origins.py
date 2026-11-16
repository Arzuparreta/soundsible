"""Which browser origins may talk to the engine: REST CORS and the Socket.IO handshake.

Both read one list. A browser enforces CORS on REST responses, but nothing
stops a page from opening a WebSocket to another origin: the server has to
refuse the handshake itself, which is what `socket_origin_allowed` does.
"""

from __future__ import annotations

import os
import re
from typing import Mapping, Optional, Sequence, Union
from urllib.parse import urlsplit

from shared.runtime import get_runtime_config
from shared.security import is_trusted_network

OriginPattern = Union[str, "re.Pattern[str]"]

#: The characters flask-cors takes as a sign that a configured origin is a
#: regular expression rather than a literal. Matching the same way keeps an
#: origin that REST accepts accepted by the socket too.
_REGEX_HINT_CHARS = frozenset("*\\]?$^[]()")

_LOCAL_ORIGINS = (
    r"^https?://localhost(:\d+)?$",
    r"^https?://127\.0\.0\.1(:\d+)?$",
)
_NETWORK_ORIGINS = _LOCAL_ORIGINS + (
    r"^https?://192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$",
    r"^https?://10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$",
    r"^https?://172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$",
    r"^https?://100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(:\d+)?$",
)


def _configured(name: str) -> Optional[list[str]]:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return None
    return [value.strip() for value in raw.split(",") if value.strip()]


def _compile(values: Sequence[str]) -> list[OriginPattern]:
    return [
        re.compile(value, re.IGNORECASE) if not _REGEX_HINT_CHARS.isdisjoint(value) else value
        for value in values
    ]


def rest_origins() -> list[OriginPattern]:
    """Origins allowed to call the REST API from another origin.

    `SOUNDSIBLE_ALLOWED_ORIGINS` replaces the default: localhost only when the
    engine listens on loopback, otherwise localhost, private LAN and Tailscale
    addresses.
    """
    configured = _configured("SOUNDSIBLE_ALLOWED_ORIGINS")
    if configured is not None:
        return _compile(configured)
    runtime = get_runtime_config()
    if not runtime.lan_enabled or runtime.host in {"127.0.0.1", "localhost"}:
        return _compile(_LOCAL_ORIGINS)
    return _compile(_NETWORK_ORIGINS)


def socket_origins() -> list[OriginPattern]:
    """Cross-origin pages allowed to open the real-time connection.

    `SOUNDSIBLE_SOCKET_CORS_ORIGINS` replaces the REST list for the socket.
    The engine's own origin is always allowed on top of either.
    """
    configured = _configured("SOUNDSIBLE_SOCKET_CORS_ORIGINS")
    return _compile(configured) if configured is not None else rest_origins()


def _matches(origin: str, patterns: Sequence[OriginPattern]) -> bool:
    for pattern in patterns:
        if isinstance(pattern, str):
            if pattern.casefold() == origin.casefold():
                return True
        elif pattern.match(origin):
            return True
    return False


def _first(value: str) -> str:
    return value.split(",", 1)[0].strip().lower()


def _is_same_origin(origin: str, environ: Mapping[str, object]) -> bool:
    """Whether `origin` is the address this request was sent to.

    That is the `Host` header, or the `X-Forwarded-Host` that a proxy on this
    machine, the LAN or the tailnet wrote (`tailscale serve`, Nginx); the same
    header from any other peer is not believed. The scheme is not compared: a
    TLS-terminating proxy that sends no `X-Forwarded-Proto` turns the player's
    `https://` page into a plain-HTTP request here, and only whoever already
    serves this host can put a page on its other scheme.
    """
    try:
        netloc = urlsplit(origin).netloc.lower()
    except ValueError:
        return False
    if not netloc:
        return False
    host = _first(str(environ.get("HTTP_HOST") or ""))
    if netloc == host:
        return True
    forwarded_host = str(environ.get("HTTP_X_FORWARDED_HOST") or "")
    return bool(
        forwarded_host
        and is_trusted_network(environ.get("REMOTE_ADDR"))
        and netloc == _first(forwarded_host)
    )


def make_socket_origin_check(patterns: Sequence[OriginPattern]):
    """The `cors_allowed_origins` callable Engine.IO calls as `(origin, environ)`.

    Engine.IO replaces its own same-origin check with any list it is given, so
    passing the REST list would refuse the player served at its own address
    behind `tailscale serve` or a proxy. This keeps that check and adds the
    list. A request without `Origin` (native clients, same-origin polling) is
    not checked by Engine.IO at all.
    """
    allowed = tuple(patterns)

    def socket_origin_allowed(origin: Optional[str], environ: Mapping[str, object]) -> bool:
        if not origin:
            return False
        return _is_same_origin(origin, environ) or _matches(origin, allowed)

    return socket_origin_allowed
