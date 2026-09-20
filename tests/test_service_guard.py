import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from shared.runtime import RuntimeConfig
from shared.service_guard import (
    _owner_from_cgroup,
    listener_pid,
    pid_owns_listener,
    preflight,
    service_owner,
    wait_ready,
)


def _runtime(port: int) -> RuntimeConfig:
    return RuntimeConfig.default({
        "SOUNDSIBLE_HOST": "127.0.0.1",
        "SOUNDSIBLE_PORT": str(port),
    })


def test_preflight_rejects_an_existing_listener():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]

        assert preflight(_runtime(port)) == 1
        if os.name == "posix":
            assert pid_owns_listener(os.getpid(), port)


def test_preflight_accepts_a_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    assert preflight(_runtime(port)) == 0


def test_ready_waits_for_health_and_checks_the_expected_pid():
    class Healthy(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"status": "healthy"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Healthy)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert wait_ready(
            _runtime(server.server_port),
            pid=os.getpid(),
            timeout=1,
        ) == 0
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.skipif(os.name != "posix", reason="/proc is where the answer lives")
def test_listener_pid_names_the_process_holding_the_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        assert listener_pid(listener.getsockname()[1]) == os.getpid()


def test_cgroup_reading_finds_the_unit_that_owns_a_process():
    assert _owner_from_cgroup("0::/system.slice/soundsible.service\n") == (
        "soundsible.service",
        False,
    )
    # A user unit lives under user@<uid>.service, which is not the answer.
    user_unit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/soundsible.service\n"
    assert _owner_from_cgroup(user_unit) == ("soundsible.service", True)
    assert _owner_from_cgroup(user_unit).stop_command() == (
        "systemctl --user stop soundsible.service"
    )
    legacy = "9:memory:/system.slice/soundsible.service\n1:name=systemd:/system.slice/soundsible.service\n"
    assert _owner_from_cgroup(legacy).unit == "soundsible.service"


def test_a_process_outside_any_unit_has_no_owner():
    assert _owner_from_cgroup("0::/user.slice/user-1000.slice/session-3.scope\n") is None
    assert _owner_from_cgroup("0::/\n") is None
    assert service_owner(-1) is None
