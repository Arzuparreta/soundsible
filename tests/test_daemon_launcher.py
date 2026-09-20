"""The menu may stop the engine it started, and nothing else.

Leaving the terminal menu used to kill whatever was listening on the Station
port. On a server that is the systemd service, which systemd then restarted —
a gap in the music nobody had asked for.
"""

import os
import socket
import subprocess

import pytest

from shared import daemon_launcher
from shared.constants import STATION_PORT
from shared.daemon_launcher import (
    MSG_STATION_NOT_RUNNING,
    MSG_STATION_STOPPED,
    start_daemon_process,
    stop_daemon_process,
    stop_owned_daemon,
)
from shared.service_guard import ServiceOwner


class FakeEngine:
    """A Popen stand-in that owns the listening socket, as the engine does."""

    def __init__(self, listener: socket.socket, *, pid: int = None):
        self.pid = os.getpid() if pid is None else pid
        self._listener = listener
        self._returncode = None
        self.signals = []

    def poll(self):
        return self._returncode

    def terminate(self):
        self.signals.append("terminate")
        self._listener.close()
        self._returncode = 0

    def kill(self):
        self.signals.append("kill")
        self._listener.close()
        self._returncode = -9

    def wait(self, timeout=None):
        if self._returncode is None:
            raise subprocess.TimeoutExpired("engine", timeout)
        return self._returncode


@pytest.fixture
def listening_port():
    """A real listener this process owns, so /proc agrees it is ours."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        yield listener, listener.getsockname()[1]


@pytest.fixture(autouse=True)
def forget_owned_daemons():
    daemon_launcher._owned_daemons.clear()
    yield
    daemon_launcher._owned_daemons.clear()


def test_starting_the_engine_records_it_as_ours(tmp_path, monkeypatch):
    venv_python = tmp_path / "python"
    venv_python.touch()
    run_py = tmp_path / "run.py"
    run_py.touch()
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "config.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(daemon_launcher, "_venv_python", lambda root: venv_python)
    monkeypatch.setattr(daemon_launcher, "_run_py", lambda root: run_py)
    monkeypatch.setattr(daemon_launcher, "get_config_dir", lambda: config_dir)
    monkeypatch.setattr(daemon_launcher, "is_port_in_use", lambda port=STATION_PORT: False)
    started = object()
    monkeypatch.setattr(daemon_launcher.subprocess, "Popen", lambda *a, **kw: started)

    ok, message = start_daemon_process(tmp_path)

    assert ok and message == daemon_launcher.MSG_STATION_STARTING
    assert daemon_launcher._owned_daemons[STATION_PORT] is started


def test_leaving_the_menu_stops_the_engine_the_menu_started(listening_port):
    listener, port = listening_port
    engine = FakeEngine(listener)
    daemon_launcher._owned_daemons[port] = engine

    assert stop_owned_daemon(port) is True
    assert engine.signals == ["terminate"]
    assert port not in daemon_launcher._owned_daemons


def test_leaving_the_menu_leaves_an_engine_it_did_not_start(listening_port, monkeypatch):
    listener, port = listening_port
    killed = []
    monkeypatch.setattr(daemon_launcher, "_stop_pid", lambda pid, port, **kw: killed.append(pid) or True)

    assert stop_owned_daemon(port) is False
    assert killed == []
    assert daemon_launcher.is_port_in_use(port)


def test_leaving_the_menu_ignores_the_port_when_our_engine_already_exited(listening_port, monkeypatch):
    listener, port = listening_port
    engine = FakeEngine(listener)
    engine._returncode = 1  # it crashed; the port now answers for somebody else
    daemon_launcher._owned_daemons[port] = engine

    assert stop_owned_daemon(port) is False
    assert engine.signals == []
    assert daemon_launcher.is_port_in_use(port)


def test_stop_reports_nothing_to_do_on_a_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]

    assert stop_daemon_process(port) == (True, MSG_STATION_NOT_RUNNING)


def test_stop_ends_our_own_engine(listening_port):
    listener, port = listening_port
    engine = FakeEngine(listener)
    daemon_launcher._owned_daemons[port] = engine

    assert stop_daemon_process(port) == (True, MSG_STATION_STOPPED)
    assert engine.signals == ["terminate"]


def test_stop_refuses_a_systemd_engine_and_names_the_command(listening_port, monkeypatch):
    listener, port = listening_port
    killed = []
    monkeypatch.setattr(daemon_launcher, "listener_pid", lambda _port: 4242)
    monkeypatch.setattr(
        daemon_launcher,
        "service_owner",
        lambda pid: ServiceOwner(unit="soundsible.service", user_scope=False),
    )
    monkeypatch.setattr(daemon_launcher, "_stop_pid", lambda pid, port, **kw: killed.append(pid) or True)

    ok, message = stop_daemon_process(port)

    assert ok is False
    assert killed == []
    assert "sudo systemctl stop soundsible.service" in message


def test_stop_ends_an_engine_started_in_another_terminal(listening_port, monkeypatch):
    listener, port = listening_port
    killed = []
    monkeypatch.setattr(daemon_launcher, "listener_pid", lambda _port: 4242)
    monkeypatch.setattr(daemon_launcher, "service_owner", lambda pid: None)
    monkeypatch.setattr(daemon_launcher, "_stop_pid", lambda pid, port, **kw: killed.append(pid) or True)

    assert stop_daemon_process(port) == (True, MSG_STATION_STOPPED)
    assert killed == [4242]


@pytest.mark.skipif(os.name == "nt", reason="Windows identifies the listener with netstat")
def test_stop_says_so_when_it_cannot_tell_whose_listener_it_is(listening_port, monkeypatch):
    listener, port = listening_port
    monkeypatch.setattr(daemon_launcher, "listener_pid", lambda _port: None)

    ok, message = stop_daemon_process(port)

    assert ok is False
    assert "did not start it" in message
    assert daemon_launcher.is_port_in_use(port)
