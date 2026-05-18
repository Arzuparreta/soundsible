"""
Tests for the Engine.IO heartbeat tuning that backs the Tailscale-walk
remote-heal gate (plan T5).

Verifies:
  - Defaults match the documented spec (20s ping, 25s timeout).
  - Env-var overrides take effect.
  - Non-integer env values fall back to defaults without crashing import.
"""

import importlib
import sys

import pytest


def _reload_api(monkeypatch, **env):
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    # Drop the orchestrator singleton so the re-imported module starts clean.
    if "shared.api.orchestrator" in sys.modules:
        sys.modules["shared.api.orchestrator"].JobOrchestrator._reset_instance_for_tests()
    for mod in [m for m in list(sys.modules) if m.startswith("shared.api")]:
        del sys.modules[mod]
    return importlib.import_module("shared.api")


def test_default_heartbeat_spec(monkeypatch):
    api = _reload_api(
        monkeypatch,
        SOUNDSIBLE_SOCKET_PING_INTERVAL=None,
        SOUNDSIBLE_SOCKET_PING_TIMEOUT=None,
    )
    assert api.SOCKET_PING_INTERVAL == 20
    assert api.SOCKET_PING_TIMEOUT == 25
    # Flask-SocketIO exposes config via the underlying Engine.IO server.
    eio = api.socketio.server.eio
    assert eio.ping_interval == 20
    assert eio.ping_timeout == 25


def test_heartbeat_env_overrides(monkeypatch):
    api = _reload_api(
        monkeypatch,
        SOUNDSIBLE_SOCKET_PING_INTERVAL="10",
        SOUNDSIBLE_SOCKET_PING_TIMEOUT="40",
    )
    assert api.SOCKET_PING_INTERVAL == 10
    assert api.SOCKET_PING_TIMEOUT == 40
    assert api.socketio.server.eio.ping_interval == 10
    assert api.socketio.server.eio.ping_timeout == 40


def test_invalid_env_falls_back_to_defaults(monkeypatch):
    api = _reload_api(
        monkeypatch,
        SOUNDSIBLE_SOCKET_PING_INTERVAL="not-a-number",
        SOUNDSIBLE_SOCKET_PING_TIMEOUT="",
    )
    assert api.SOCKET_PING_INTERVAL == 20
    assert api.SOCKET_PING_TIMEOUT == 25
