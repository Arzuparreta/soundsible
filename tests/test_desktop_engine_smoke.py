"""Headless smoke tests for the desktop engine sidecar contract."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest
import requests

from shared.desktop_bootstrap import ensure_consumer_config
from shared.desktop_runtime import load_runtime_state, stop_owned_desktop_engine
from shared.runtime import reset_runtime


REPO_ROOT = Path(__file__).resolve().parents[1]
ENGINE_ENTRY = REPO_ROOT / "soundsible_engine.py"
STARTUP_TIMEOUT_SEC = 120
# The engine's own shutdown is sequential with bounded waits: the gevent pool
# (1s), the loudness idle worker (3s) and the download drain (5s). A budget
# below that sum fails a clean exit on a slow runner; what this test guards
# against is a shutdown that never finishes.
SHUTDOWN_TIMEOUT_SEC = 30


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


def _ensure_isolated_consumer_config(music: Path, env: dict[str, str]) -> None:
    """Bootstrap only inside the test runtime directories, never the user's config."""
    with patch.dict(os.environ, env, clear=True):
        reset_runtime()
        ensure_consumer_config(music)
    reset_runtime()


def _exercise_media_tools(ffmpeg: Path, output_dir: Path) -> None:
    """Use only the shipped pair, never a runner's system ffprobe."""
    ffprobe = ffmpeg.with_name("ffprobe" + ffmpeg.suffix)
    assert ffmpeg.is_file(), f"Missing bundled ffmpeg: {ffmpeg}"
    assert ffprobe.is_file(), f"Missing bundled ffprobe: {ffprobe}"
    output = output_dir / "prueba música.flac"
    subprocess.run(
        [str(ffmpeg), "-v", "error", "-f", "lavfi", "-i",
         "sine=frequency=440:duration=0.25", "-y", str(output)],
        check=True, capture_output=True, timeout=30,
    )
    result = subprocess.run(
        [str(ffprobe), "-v", "error", "-show_entries",
         "stream=codec_name:format=duration", "-of", "json", str(output)],
        check=True, capture_output=True, text=True, timeout=30,
    )
    report = json.loads(result.stdout)
    assert report["streams"][0]["codec_name"] == "flac"
    assert float(report["format"]["duration"]) > 0


def test_media_tools_round_trip(tmp_path):
    binary = shutil.which("ffmpeg")
    if not binary:
        pytest.skip("FFmpeg is not installed")
    _exercise_media_tools(Path(binary), tmp_path)


def test_media_tools_reject_missing_bundled_probe(tmp_path):
    binary = tmp_path / "ffmpeg.exe"
    binary.touch()
    with pytest.raises(AssertionError, match="Missing bundled ffprobe"):
        _exercise_media_tools(binary, tmp_path)


def _run_smoke(tmp_path: Path, engine_bin: Path | None) -> None:
    reset_runtime()
    env = os.environ.copy()
    env.update(_runtime_env(tmp_path))

    music = tmp_path / "music"
    music.mkdir()
    (music / "sample.flac").write_bytes(b"fake")

    _ensure_isolated_consumer_config(music, env)
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
        ff = payload.get("ffmpeg") or {}
        if engine_bin is not None and os.environ.get("SOUNDSIBLE_REQUIRE_FFMPEG"):
            assert ff.get("available") is True, (
                f"sidecar health missing bundled ffmpeg: {ff!r}"
            )
            assert ff.get("source") in {"bundle", "sibling"}, ff
            _exercise_media_tools(Path(ff["path"]), tmp_path)
        state = load_runtime_state(config_dir)
        assert state is not None
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
        stop_owned_desktop_engine(config_dir)


def test_desktop_engine_sigterm_exits_cleanly(tmp_path):
    """SIGTERM should stop the engine (no hang after 'Shutting down...')."""
    reset_runtime()
    env = os.environ.copy()
    env.update(_runtime_env(tmp_path))
    # Dumps every thread's stack on SIGABRT, which is how a hang reports itself.
    env["PYTHONFAULTHANDLER"] = "1"

    music = tmp_path / "music"
    music.mkdir()
    (music / "sample.flac").write_bytes(b"fake")

    _ensure_isolated_consumer_config(music, env)
    config_dir = Path(env["SOUNDSIBLE_CONFIG_DIR"])

    cmd = _engine_command(None)
    cmd.extend(["--music-dir", str(music)])

    # A file, not a pipe: nothing reads the pipe, and the log is the diagnosis.
    log_path = tmp_path / "engine.log"
    with log_path.open("w") as log:
        proc = subprocess.Popen(
            cmd,
            cwd=REPO_ROOT,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )

    try:
        _wait_for_health(config_dir)
        if os.name == "nt":
            proc.terminate()
        else:
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=SHUTDOWN_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.kill(proc.pid, signal.SIGABRT)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            pytest.fail(
                f"engine still running {SHUTDOWN_TIMEOUT_SEC}s after SIGTERM; "
                f"log tail:\n{log_path.read_text(errors='replace')[-8000:]}"
            )
    finally:
        if proc.poll() is None:
            if os.name == "nt":
                proc.kill()
            else:
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
