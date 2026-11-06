"""
Trust and path safety checks for the Station Engine.
"""

import ipaddress
import os
import logging
import tempfile

logger = logging.getLogger(__name__)

from shared.constants import DEFAULT_OUTPUT_DIR_FALLBACK
from shared.runtime import get_cache_dir, get_config_dir


def _get_output_dir_root():
    """Output dir for allowed_roots; use app_config if set, else fallback."""
    from shared.app_config import get_output_dir
    out = get_output_dir()
    if out is not None:
        return os.path.normpath(os.path.abspath(str(out)))
    return os.path.normpath(os.path.abspath(os.path.expanduser(DEFAULT_OUTPUT_DIR_FALLBACK)))


#: Tailscale gives tailnet devices addresses from the shared CGNAT block, which
#: Python does not count as private. The rest of 100.0.0.0/8 is public internet.
TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")


def is_trusted_network(remote_addr) -> bool:
    """Whether an address is this machine, the LAN or the tailnet."""
    try:
        ip = ipaddress.ip_address(str(remote_addr or "").strip())
    except ValueError as e:
        logger.debug("is_trusted_network: invalid remote_addr %s: %s", remote_addr, e)
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_private or ip.is_loopback or (ip.version == 4 and ip in TAILSCALE_NETWORK)


def _strip_port(value: str) -> str:
    value = value.strip().strip('"')
    if value.startswith("["):
        return value[1:value.index("]")] if "]" in value else ""
    if value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def _last_forwarded_for(header: str) -> str:
    """The ``for=`` of the last element of an RFC 7239 ``Forwarded`` header."""
    last = header.split(",")[-1]
    for pair in last.split(";"):
        name, _, value = pair.partition("=")
        if name.strip().lower() == "for":
            return _strip_port(value)
    return ""


def request_client_address(req=None) -> str:
    """The address of whoever is calling, as far as it can be known.

    A reverse proxy or ``tailscale serve``/``funnel`` on this machine makes
    every request arrive from 127.0.0.1, so the socket alone would trust the
    whole internet. When a trusted peer forwards a request, the decision is made
    on the client it names: the right-most ``X-Forwarded-For`` entry, the one
    the nearest proxy wrote (earlier entries are whatever the client sent).
    A request that shows a proxy but names no client gets ``""``, which nothing
    trusts. Headers from an untrusted peer are never believed.
    """
    if req is None:
        from flask import request as req
    peer = (req.remote_addr or "").strip()
    if not is_trusted_network(peer):
        return peer
    headers = req.headers
    if headers.get("Tailscale-Funnel-Request"):
        # Funnel is the public internet by definition, whatever it reports.
        return ""
    forwarded_for = headers.get("X-Forwarded-For")
    if forwarded_for is not None:
        entries = [entry for entry in forwarded_for.split(",") if entry.strip()]
        return _strip_port(entries[-1]) if entries else ""
    forwarded = headers.get("Forwarded")
    if forwarded is not None:
        return _last_forwarded_for(forwarded)
    real_ip = headers.get("X-Real-IP")
    if real_ip is not None:
        return _strip_port(real_ip)
    if headers.get("X-Forwarded-Host") or headers.get("X-Forwarded-Proto"):
        return ""
    return peer


def is_trusted_request(req=None) -> bool:
    """Whether the caller of this request is on this machine, the LAN or the tailnet."""
    return is_trusted_network(request_client_address(req))


def is_safe_path(file_path, is_trusted: bool = False) -> bool:
    """
    Ensures the Station Engine only serves files from approved music or cache folders.
    If is_trusted is True (LAN/Tailscale), all paths are allowed for maximum flexibility.
    """
    if is_trusted:
        return True

    try:
        # Note: Lexical normalization for public-facing security check
        target = os.path.normpath(os.path.abspath(os.path.expanduser(file_path)))

        # Approved roots for public access
        allowed_roots = [
            os.path.normpath(os.path.abspath(str(get_config_dir()))),
            os.path.normpath(os.path.abspath(str(get_cache_dir()))),
            _get_output_dir_root(),
            os.path.normpath(os.path.abspath(tempfile.gettempdir())),
            os.path.normpath(os.path.abspath(os.path.expanduser("~")))
        ]

        for root in allowed_roots:
            try:
                # Note: Use commonpath to verify target is within root
                if os.path.commonpath([target, root]) == root:
                    return True
            except (ValueError, OSError) as e:
                logger.debug("Path check root %s: %s", root, e)
                continue

    except Exception as e:
        logger.warning("SECURITY: Error validating path %s: %s", file_path, e)

    return False
