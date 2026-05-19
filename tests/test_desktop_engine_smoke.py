"""Headless smoke tests for the desktop engine sidecar contract."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests

from shared.desktop_bootstrap import ensure_consumer_config
from shared.desktop_runtime import load_runtime_state, stop_owned_desktop_engine
from shared.runtime import reset_runtime


REPO_ROOT = Path(__file__).resolve().parents[1]
ENGINE_ENTRY = REPO_ROOT / "soundsible_engine.py"
STARTUP_TIMEOUT_SEC = 120


def _runtime_env(tmp_path: Path) -> dict[str, str]:
    return {
        "SOUNDSIBLE_CONFIG_DIR": str(tmp_path / "cfg"),
        "SOUNDSIBLE_DATA_DIR": str(tmp_path / "data"),
        "SOUNDSIBLE_CACHE_DIR": str(tmp_path / "cache"),
        "SOUNDSIBLE_LOG_DIR": str(tmp_path / "logs"),
        "PYTHONPATH": str(REPO_ROOT),
    }


def _wait_for_health(config_dir: Path) -> str:
    deadline = time.time() + STARTUP_TIMEOUT_SEC
    while time.time() < deadline:
        state = load_runtime_state(config_dir)
        if state and state.get("base_url"):
            health_url = state["base_url"].rstrip("/") + state.get("health", "/api/health")
            try:
                resp = requests.get(health_url, timeout=2)
                if resp.status_code == 200:
                    return health_url
            except requests.RequestException:
                pass
        time.sleep(0.25)
    raise TimeoutError("Desktop engine did not become healthy in time")


def _engine_command(engine_bin: Path | None) -> list[str]:
    if engine_bin is not None:
        return [str(engine_bin)]
    python = REPO_ROOT / "venv" / "bin" / "python3"
    if not python.exists():
        python = Path(sys.executable)
    return [str(python), str(ENGINE_ENTRY)]


def _run_smoke(tmp_path: Path, engine_bin: Path | None) -> None:
    reset_runtime()
    env = os.environ.copy()
    env.update(_runtime_env(tmp_path))

    music = tmp_path / "music"
    music.mkdir()
    (music / "sample.flac").write_bytes(b"fake")

    ensure_consumer_config(music)
    config_dir = Path(env["SOUNDSIBLE_CONFIG_DIR"])

    cmd = _engine_command(engine_bin)
    cmd.extend(["--music-dir", str(music)])

    proc = subprocess.Popen(
        cmd,
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )

    try:
        health_url = _wait_for_health(config_dir)
        payload = requests.get(health_url, timeout=5).json()
        assert isinstance(payload, dict)
        state = load_runtime_state(config_dir)
        assert state is not None
        player_base = payload.get("base_url") or state["base_url"]
        desktop = requests.get(f"{player_base.rstrip('/')}/player/desktop/", timeout=10)
        assert desktop.status_code == 200
    finally:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        stop_owned_desktop_engine(config_dir)


def test_desktop_engine_smoke_python(tmp_path):
    _run_smoke(tmp_path, engine_bin=None)


def test_desktop_engine_smoke_sidecar(tmp_path):
    sidecar = os.environ.get("SOUNDSIBLE_ENGINE_BIN")
    if sidecar:
        engine_bin = Path(sidecar)
    else:
        binaries = REPO_ROOT / "desktop-shell" / "src-tauri" / "binaries"
        matches = sorted(p for p in binaries.glob("soundsible-engine*") if p.is_file())
        if not matches:
            pytest.skip("Sidecar binary not built; run desktop-shell/scripts/build-sidecar.sh")
        engine_bin = matches[0]
    _run_smoke(tmp_path, engine_bin=engine_bin)
