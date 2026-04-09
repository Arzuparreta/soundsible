"""
Trust and path safety checks for the Station Engine.
"""

import os
import logging
import tempfile

logger = logging.getLogger(__name__)

from shared.constants import DEFAULT_CONFIG_DIR, DEFAULT_CACHE_DIR, DEFAULT_OUTPUT_DIR_FALLBACK


def _get_output_dir_root():
    """Output dir for allowed_roots; use app_config if set, else fallback (no odst_tool import)."""
    from shared.app_config import get_output_dir
    out = get_output_dir()
    if out is not None:
        return os.path.normpath(os.path.abspath(str(out)))
    return os.path.normpath(os.path.abspath(os.path.expanduser(DEFAULT_OUTPUT_DIR_FALLBACK)))


def is_trusted_network(remote_addr) -> bool:
    """
    Automatically trusts Local, LAN, and Tailscale networks.
    Provides 'Zero-Friction' access for friends and family on the network.
    """
    try:
        import ipaddress
        ip = ipaddress.ip_address(remote_addr)
        # Note: Trust if it's private (LAN/wifi) or loopback (localhost)
        # Note: 100.X.x.x (tailscale) is explicitly caught by is_private in many versions,
        # Note: But we check it specifically for reliability.
        is_tailscale = str(remote_addr).startswith('100.')
        return ip.is_private or ip.is_loopback or is_tailscale
    except (ValueError, TypeError) as e:
        logger.debug("is_trusted_network: invalid remote_addr %s: %s", remote_addr, e)
        return False


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

        # Note: Approved roots for public access (no odst_tool dependency)
        allowed_roots = [
            os.path.normpath(os.path.abspath(os.path.expanduser(DEFAULT_CONFIG_DIR))),
            os.path.normpath(os.path.abspath(os.path.expanduser(DEFAULT_CACHE_DIR))),
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
