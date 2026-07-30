import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from shared.runtime import RuntimeConfig
from shared.service_guard import pid_owns_listener, preflight, wait_ready


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
