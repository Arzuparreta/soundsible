"""
Desktop engine runtime helpers.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import signal
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from shared.database import instance_db
from shared.hardening import ALL_SCOPES
from shared.runtime import RuntimeConfig


OWNER_TOKEN_KIND = "owner"
OWNER_TOKEN_NAME = "desktop-owner"
OWNER_TOKEN_FILENAME = "desktop-owner-token"
RUNTIME_STATE_FILENAME = "desktop-engine-state.json"


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def default_owner_token_file(runtime: RuntimeConfig) -> Path:
    return (runtime.config_dir / OWNER_TOKEN_FILENAME).resolve()


def runtime_state_file(runtime: RuntimeConfig) -> Path:
    return (runtime.config_dir / RUNTIME_STATE_FILENAME).resolve()


def ensure_owner_token(runtime: RuntimeConfig) -> tuple[RuntimeConfig, str]:
    token_file = runtime.owner_token_file or default_owner_token_file(runtime)
    token_file.parent.mkdir(parents=True, exist_ok=True)

    token = secrets.token_urlsafe(32)
    db = instance_db()
    db.revoke_auth_tokens_by_kind(OWNER_TOKEN_KIND)
    db.create_auth_token(
        str(uuid.uuid4()),
        _hash_token(token),
        kind=OWNER_TOKEN_KIND,
        scopes=sorted(ALL_SCOPES),
        name=OWNER_TOKEN_NAME,
        device_type="desktop-shell",
    )
    token_file.write_text(token)
    try:
        os.chmod(token_file, 0o600)
    except OSError:
        pass

    runtime = RuntimeConfig(
        host=runtime.host,
        port=runtime.port,
        config_dir=runtime.config_dir,
        data_dir=runtime.data_dir,
        cache_dir=runtime.cache_dir,
        log_dir=runtime.log_dir,
        music_dir=runtime.music_dir,
        ui_dist=runtime.ui_dist,
        owner_token_file=token_file,
        lan_enabled=runtime.lan_enabled,
        advanced_mode=runtime.advanced_mode,
    )
    return runtime, token


def write_runtime_state(runtime: RuntimeConfig, *, version: str, health_path: str = "/api/health") -> Dict[str, Any]:
    state = {
        "mode": "desktop-engine",
        "pid": os.getpid(),
        "host": runtime.host,
        "port": runtime.port,
        "base_url": f"http://{runtime.host}:{runtime.port}",
        "health": health_path,
        "version": version,
        "owner_token_file": str(runtime.owner_token_file) if runtime.owner_token_file else None,
        "config_dir": str(runtime.config_dir),
        "data_dir": str(runtime.data_dir),
        "cache_dir": str(runtime.cache_dir),
        "log_dir": str(runtime.log_dir),
        "music_dir": str(runtime.music_dir),
        "started_at": int(time.time()),
    }
    runtime_state_file(runtime).write_text(json.dumps(state, indent=2))
    return state


def clear_runtime_state(runtime: RuntimeConfig) -> None:
    state_file = runtime_state_file(runtime)
    try:
        state_file.unlink()
    except FileNotFoundError:
        return


def load_runtime_state(config_dir: str | Path) -> Optional[Dict[str, Any]]:
    path = Path(config_dir).expanduser().resolve() / RUNTIME_STATE_FILENAME
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def stop_owned_desktop_engine(config_dir: str | Path, *, timeout_sec: float = 8.0) -> tuple[bool, str]:
    state = load_runtime_state(config_dir)
    if not state:
        return True, "Desktop engine was not running."

    pid = int(state.get("pid") or 0)
    if pid <= 0:
        return False, "Desktop engine state file is invalid."
    if not _pid_exists(pid):
        try:
            (Path(config_dir).expanduser().resolve() / RUNTIME_STATE_FILENAME).unlink()
        except FileNotFoundError:
            pass
        return True, "Desktop engine was not running."

    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid)], capture_output=True, text=True, timeout=5)
        else:
            os.kill(pid, signal.SIGTERM)
    except Exception as exc:
        return False, str(exc)

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if not _pid_exists(pid):
            try:
                (Path(config_dir).expanduser().resolve() / RUNTIME_STATE_FILENAME).unlink()
            except FileNotFoundError:
                pass
            return True, "Desktop engine stopped."
        time.sleep(0.2)

    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, text=True, timeout=5)
        else:
            os.kill(pid, signal.SIGKILL)
    except Exception as exc:
        return False, f"Desktop engine did not stop cleanly: {exc}"

    try:
        (Path(config_dir).expanduser().resolve() / RUNTIME_STATE_FILENAME).unlink()
    except FileNotFoundError:
        pass
    return True, "Desktop engine stopped."
