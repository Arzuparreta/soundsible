"""The addresses this station answers on, for pairing codes, invites and the banner."""

from __future__ import annotations

import logging
import socket

from shared.runtime import get_runtime_config

logger = logging.getLogger(__name__)


def active_endpoints() -> list[str]:
    """Gather all network-accessible IPv4 addresses for this machine."""
    endpoints = []
    try:
        # Note: Standard socket-based discovery
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        if local_ip and not local_ip.startswith('127.'):
            endpoints.append(local_ip)
            
        # Note: More robust discovery using all interfaces
        import psutil
        for interface, addrs in psutil.net_if_addrs().items():
            # Note: Skip common bridge/virtual interfaces that aren't useful for mobile sync
            if any(skip in interface.lower() for skip in ['docker', 'br-', 'veth', 'lo']):
                continue
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    if ip not in endpoints and not ip.startswith('127.'):
                        endpoints.append(ip)
    except Exception as e:
        logger.debug("active_endpoints: primary discovery failed, using fallback: %s", e)
        # Note: Fallback to A simple socket test if psutil fails or isn't installed
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip not in endpoints: endpoints.append(ip)
            s.close()
        except Exception:
            pass

    return endpoints


def base_urls() -> dict:
    runtime = get_runtime_config()
    loopback_base_url = f"http://127.0.0.1:{runtime.port}"
    lan_base_urls: list[str] = []
    if runtime.lan_enabled or runtime.host not in {"127.0.0.1", "localhost"}:
        lan_base_urls = [f"http://{host}:{runtime.port}" for host in active_endpoints()]
    suggested_base_url = lan_base_urls[0] if lan_base_urls else None
    return {
        "loopback_base_url": loopback_base_url,
        "lan_base_urls": lan_base_urls,
        "suggested_base_url": suggested_base_url,
        "lan_enabled": runtime.lan_enabled,
    }
