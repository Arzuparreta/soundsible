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


#: Any origin, as both flask-cors and Engine.IO read a configured ``*``.
ANY_ORIGIN = "*"


def _compile(values: Sequence[str]) -> list[OriginPattern]:
    return [
        value if value == ANY_ORIGIN
        else re.compile(value, re.IGNORECASE) if not _REGEX_HINT_CHARS.isdisjoint(value)
        else value
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
        if pattern == ANY_ORIGIN:
            return True
        if isinstance(pattern, str):
            if pattern.casefold() == origin.casefold():
                return True
        elif pattern.match(origin):
            return True
    return False


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _first(value: object) -> str:
    return str(value or "").split(",", 1)[0].strip().lower()


def _endpoint(scheme: str, netloc: str) -> Optional[tuple[str, str, int]]:
    """``(scheme, host, port)`` with the scheme's default port filled in."""
    try:
        parts = urlsplit(f"{scheme}://{netloc}")
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if not parts.hostname or scheme not in _DEFAULT_PORTS:
        return None
    return scheme, parts.hostname.lower(), port or _DEFAULT_PORTS[scheme]


def _is_same_origin(origin: str, environ: Mapping[str, object]) -> bool:
    """Whether `origin` is the address this request was sent to.

    Scheme, host and port all count, as they do for the browser. The address is
    the `Host` header with the request's scheme. A proxy on this machine, the
    LAN or the tailnet (`tailscale serve`, Nginx) may say what the browser saw
    with `X-Forwarded-Host` and `X-Forwarded-Proto`; the same headers from any
    other peer are not believed. A TLS-terminating proxy that sends no
    `X-Forwarded-Proto` makes the player's `https://` page look like another
    origin: such a proxy needs that header or its address configured.
    """
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    wanted = _endpoint(parts.scheme, parts.netloc)
    if wanted is None:
        return False
    trusted = is_trusted_network(environ.get("REMOTE_ADDR"))
    scheme = str(environ.get("wsgi.url_scheme") or "http")
    hosts = [_first(environ.get("HTTP_HOST"))]
    if trusted:
        scheme = _first(environ.get("HTTP_X_FORWARDED_PROTO")) or scheme
        hosts.append(_first(environ.get("HTTP_X_FORWARDED_HOST")))
    return any(host and _endpoint(scheme, host) == wanted for host in hosts)


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
