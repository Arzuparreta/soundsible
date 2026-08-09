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


@pytest.fixture(autouse=True)
def restore_api_modules():
    """Put the original ``shared.api`` modules back when the test is done.

    Reading the heartbeat config means re-importing the package, which replaces
    every ``shared.api*`` entry in ``sys.modules`` with a fresh object — and
    with it ``shared.api.app`` and each route module. Test modules that bound
    ``app`` (or a route helper) at *their* import time keep pointing at the
    originals, so anything running afterwards was patching one module and
    exercising another. It failed as a 404 from a route that looked correctly
    stubbed, and only when the suite ran in the right order.
    """
    saved = {name: mod for name, mod in sys.modules.items() if name.startswith("shared.api")}
    try:
        yield
    finally:
        for name in [m for m in list(sys.modules) if m.startswith("shared.api")]:
            del sys.modules[name]
        sys.modules.update(saved)
        # `sys.modules` is not the only place a module lives. `import shared.api`
        # reads the `api` attribute off the `shared` package, and the reload set
        # that to the fresh object. Restoring only `sys.modules` leaves the two
        # disagreeing: `monkeypatch.setattr("shared.api.x", …)` patches the entry
        # in `sys.modules`, while `from shared.api import x` inside the code under
        # test reads the attribute — and gets the unpatched one.
        for name, module in saved.items():
            parent, _, child = name.rpartition(".")
            if parent in sys.modules:
                setattr(sys.modules[parent], child, module)


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
