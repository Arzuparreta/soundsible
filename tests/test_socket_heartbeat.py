"""
Tests for the Engine.IO heartbeat tuning that backs the Tailscale-walk
remote-heal gate (plan T5).

Verifies:
  - Defaults match the documented spec (20s ping, 25s timeout).
  - Env-var overrides take effect.
  - Non-integer env values fall back to defaults without crashing import.

The values are read when `shared.api` is imported, so each check imports it in
a fresh interpreter. Re-importing it inside the suite used to leave the
Socket.IO server (`shared.realtime`, which is not reloaded) holding handlers
from the discarded module, and every later socket test talked to the wrong one.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_PROBE = (
    "import json, shared.api as api; from shared import realtime; "
    "eio = realtime.socketio.server.eio; "
    "print(json.dumps([api.SOCKET_PING_INTERVAL, api.SOCKET_PING_TIMEOUT, eio.ping_interval, eio.ping_timeout]))"
)


def _heartbeat(tmp_path, **env):
    environ = {key: value for key, value in os.environ.items()
               if key not in {"SOUNDSIBLE_SOCKET_PING_INTERVAL", "SOUNDSIBLE_SOCKET_PING_TIMEOUT"}}
    environ.update({
        "SOUNDSIBLE_CONFIG_DIR": str(tmp_path / "config"),
        "SOUNDSIBLE_DATA_DIR": str(tmp_path / "data"),
        "SOUNDSIBLE_CACHE_DIR": str(tmp_path / "cache"),
        **env,
    })
    result = subprocess.run([sys.executable, "-c", _PROBE], cwd=ROOT, env=environ,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("env, expected", [
    ({}, [20, 25, 20, 25]),
    ({"SOUNDSIBLE_SOCKET_PING_INTERVAL": "10", "SOUNDSIBLE_SOCKET_PING_TIMEOUT": "40"}, [10, 40, 10, 40]),
    ({"SOUNDSIBLE_SOCKET_PING_INTERVAL": "not-a-number", "SOUNDSIBLE_SOCKET_PING_TIMEOUT": ""}, [20, 25, 20, 25]),
])
def test_heartbeat(tmp_path, env, expected):
    assert _heartbeat(tmp_path, **env) == expected


def test_heartbeat_detects_wedged_peer_within_45s():
    """The documented SLO: a wedged peer is detected within ping_interval +
    ping_timeout seconds."""
    import shared.api as api

    assert api.SOCKET_PING_INTERVAL + api.SOCKET_PING_TIMEOUT <= 45
