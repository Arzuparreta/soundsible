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

from shared.instance_layout import create_instance
from shared.desktop_runtime import load_runtime_state
from shared.runtime import reset_runtime


REPO_ROOT = Path(__file__).resolve().parents[1]
ENGINE_ENTRY = REPO_ROOT / "soundsible_engine.py"
STARTUP_TIMEOUT_SEC = 120


def _runtime_env(instance_dir: Path) -> dict[str, str]:
    return {
        "SOUNDSIBLE_INSTANCE_DIR": str(instance_dir),
        "PYTHONPATH": str(REPO_ROOT),
    }


def _wait_for_health(instance_dir: Path) -> str:
    deadline = time.time() + STARTUP_TIMEOUT_SEC
    while time.time() < deadline:
        state = load_runtime_state(instance_dir)
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
    layout = create_instance(tmp_path / "instance")
    env = os.environ.copy()
    env.update(_runtime_env(layout.root))
    (layout.tracks_dir / "sample.flac").write_bytes(b"fake")

    cmd = _engine_command(engine_bin)
    cmd.extend(["--instance-dir", str(layout.root)])

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
        health_url = _wait_for_health(layout.root)
        payload = requests.get(health_url, timeout=5).json()
        assert isinstance(payload, dict)
        ff = payload.get("ffmpeg") or {}
        if engine_bin is not None and os.environ.get("SOUNDSIBLE_REQUIRE_FFMPEG"):
            assert ff.get("available") is True, (
                f"sidecar health missing bundled ffmpeg: {ff!r}"
            )
        state = load_runtime_state(layout.root)
        assert state is not None
        assert state["instance_dir"] == str(layout.root)
        player_base = payload.get("base_url") or state["base_url"]
        desktop = requests.get(f"{player_base.rstrip('/')}/player/desktop/", timeout=10)
        assert desktop.status_code == 200
    finally:
        if proc.poll() is None:
            if os.name == "nt":
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            else:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)
        state_file = layout.runtime_dir / "desktop-engine-state.json"
        if state_file.exists():
            state_file.unlink()


def test_desktop_engine_sigterm_exits_cleanly(tmp_path):
    """SIGTERM should stop the engine within a few seconds (no hang after 'Shutting down...')."""
    reset_runtime()
    layout = create_instance(tmp_path / "instance")
    env = os.environ.copy()
    env.update(_runtime_env(layout.root))
    (layout.tracks_dir / "sample.flac").write_bytes(b"fake")

    cmd = _engine_command(None)
    cmd.extend(["--instance-dir", str(layout.root)])

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
        _wait_for_health(layout.root)
        if os.name == "nt":
            proc.terminate()
        else:
            os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=10)
        assert proc.returncode is not None
    finally:
        if proc.poll() is None:
            if os.name == "nt":
                proc.kill()
            else:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        state_file = layout.runtime_dir / "desktop-engine-state.json"
        if state_file.exists():
            state_file.unlink()


def test_desktop_engine_smoke_python(tmp_path):
    _run_smoke(tmp_path, engine_bin=None)


def test_desktop_engine_smoke_sidecar(tmp_path):
    sidecar = os.environ.get("SOUNDSIBLE_ENGINE_BIN")
    if not sidecar:
        pytest.skip(
            "Set SOUNDSIBLE_ENGINE_BIN to the sidecar built for this source tree"
        )
    _run_smoke(tmp_path, engine_bin=Path(sidecar))
