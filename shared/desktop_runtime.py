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
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, Optional

from shared.database import instance_db
from shared.hardening import ALL_SCOPES
from shared.runtime import RuntimeConfig


OWNER_TOKEN_KIND = "owner"
OWNER_TOKEN_NAME = "desktop-owner"
OWNER_TOKEN_FILENAME = "desktop-owner-token"
RUNTIME_STATE_FILENAME = "desktop-engine-state.json"


def _machine_fingerprint() -> str:
    from shared.crypto import CredentialManager

    return hashlib.sha256(CredentialManager.generate_machine_key()).hexdigest()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def default_owner_token_file(runtime: RuntimeConfig) -> Path:
    if runtime.instance_dir is not None:
        from shared.instance_layout import InstanceLayout

        return (InstanceLayout.at(runtime.instance_dir).runtime_dir / OWNER_TOKEN_FILENAME).resolve()
    return (runtime.config_dir / OWNER_TOKEN_FILENAME).resolve()


def runtime_state_file(runtime: RuntimeConfig) -> Path:
    if runtime.instance_dir is not None:
        from shared.instance_layout import InstanceLayout

        return (InstanceLayout.at(runtime.instance_dir).runtime_dir / RUNTIME_STATE_FILENAME).resolve()
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

    runtime = replace(runtime, owner_token_file=token_file)
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
        "instance_dir": str(runtime.instance_dir) if runtime.instance_dir else None,
        "machine_fingerprint": _machine_fingerprint(),
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
    root = Path(config_dir).expanduser().resolve()
    path = root / RUNTIME_STATE_FILENAME
    if (root / "soundsible.instance.json").is_file():
        path = root / "runtime" / RUNTIME_STATE_FILENAME
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

    root = Path(config_dir).expanduser().resolve()
    state_instance = state.get("instance_dir")
    if state.get("machine_fingerprint") != _machine_fingerprint() or (
        state_instance and Path(state_instance).expanduser().resolve() != root
    ):
        state_path = root / RUNTIME_STATE_FILENAME
        if (root / "soundsible.instance.json").is_file():
            state_path = root / "runtime" / RUNTIME_STATE_FILENAME
        try:
            state_path.unlink()
        except FileNotFoundError:
            pass
        return True, "Removed stale desktop engine state from another location or machine."

    pid = int(state.get("pid") or 0)
    if pid <= 0:
        return False, "Desktop engine state file is invalid."
    if not _pid_exists(pid):
        try:
            root = Path(config_dir).expanduser().resolve()
            state_path = root / RUNTIME_STATE_FILENAME
            if (root / "soundsible.instance.json").is_file():
                state_path = root / "runtime" / RUNTIME_STATE_FILENAME
            state_path.unlink()
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
                root = Path(config_dir).expanduser().resolve()
                state_path = root / RUNTIME_STATE_FILENAME
                if (root / "soundsible.instance.json").is_file():
                    state_path = root / "runtime" / RUNTIME_STATE_FILENAME
                state_path.unlink()
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
        root = Path(config_dir).expanduser().resolve()
        state_path = root / RUNTIME_STATE_FILENAME
        if (root / "soundsible.instance.json").is_file():
            state_path = root / "runtime" / RUNTIME_STATE_FILENAME
        state_path.unlink()
    except FileNotFoundError:
        pass
    return True, "Desktop engine stopped."
