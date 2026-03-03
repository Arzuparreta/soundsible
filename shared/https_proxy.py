"""
Optional Caddy HTTPS reverse proxy for Soundsible.
Terminates TLS on port 8443 and forwards to Flask on 5005.
"""
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Optional

from shared.constants import DEFAULT_CONFIG_DIR

HTTPS_PROXY_PORT = 8443
STATION_PORT = 5005


def _launcher_prefs_path() -> Path:
    """Path to launcher preferences (proxy toggle)."""
    return Path(DEFAULT_CONFIG_DIR).expanduser() / "launcher_prefs.json"


def is_proxy_preferred() -> bool:
    """Return True if user has enabled HTTPS proxy in launcher preferences."""
    path = _launcher_prefs_path()
    if not path.exists():
        return False
    try:
        import json
        data = json.loads(path.read_text())
        return bool(data.get("https_proxy", False))
    except Exception:
        return False


def is_caddy_available() -> bool:
    """Return True if caddy is in PATH."""
    return shutil.which("caddy") is not None


def _caddyfile_path() -> Path:
    """Path for the generated Caddyfile."""
    config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir / "Caddyfile"


def _write_caddyfile(proxy_port: int = HTTPS_PROXY_PORT, backend_port: int = STATION_PORT) -> Path:
    """Write minimal Caddyfile and return its path."""
    path = _caddyfile_path()
    content = f""":{proxy_port} {{
    tls internal
    reverse_proxy 127.0.0.1:{backend_port}
}}
"""
    path.write_text(content)
    return path


def start_caddy_proxy(
    port: int = HTTPS_PROXY_PORT,
    backend_port: int = STATION_PORT,
) -> Optional[subprocess.Popen]:
    """
    Start Caddy as reverse proxy. Returns Popen instance or None if failed.
    """
    if not is_caddy_available():
        print("HTTPS Proxy: caddy not found in PATH. Install with: apt install caddy (or equivalent)")
        return None

    caddyfile = _write_caddyfile(port, backend_port)

    try:
        proc = subprocess.Popen(
            ["caddy", "run", "--config", str(caddyfile)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=(os.name != "nt"),
        )
    except Exception as e:
        print(f"HTTPS Proxy: failed to start caddy: {e}")
        return None

    # Wait for Caddy to bind
    for _ in range(15):
        time.sleep(0.2)
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    print(f"HTTPS Proxy: Caddy listening on https://0.0.0.0:{port}")
                    return proc
        except Exception:
            pass
        if proc.poll() is not None:
            print("HTTPS Proxy: Caddy exited unexpectedly")
            return None

    proc.terminate()
    proc.wait(timeout=3)
    print("HTTPS Proxy: Caddy failed to bind in time")
    return None


def stop_caddy_proxy(port: int = HTTPS_PROXY_PORT) -> bool:
    """Kill process listening on the given port. Returns True if something was killed."""
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if out.returncode != 0:
                return False
            for line in out.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    if len(parts) >= 5:
                        pid = parts[-1]
                        subprocess.run(
                            ["taskkill", "/PID", pid, "/F"],
                            capture_output=True,
                            timeout=5,
                        )
                        return True
            return False
        subprocess.run(
            ["fuser", "-k", f"{port}/tcp"],
            stderr=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            timeout=5,
        )
        return True
    except Exception:
        return False
