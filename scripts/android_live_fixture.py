#!/usr/bin/env python3
"""Real Community + MediaMTX, disposable TLS relay for Android acceptance only."""
from __future__ import annotations

import argparse
import io
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import time
from urllib.request import urlopen
import ssl

sys.path.insert(0, str(Path(__file__).resolve().parent))
from download_retry import fetch  # noqa: E402

# The relay binary from MediaMTX's GitHub release, pinned by checksum and
# fetched with download_retry. It used to be the Docker Hub image of the same
# version, and a Docker Hub pull that failed (exit 125) took every Android
# shard down with it before any test ran.
MEDIAMTX_VERSION = "v1.19.3"
MEDIAMTX_ARCHIVE = f"mediamtx_{MEDIAMTX_VERSION}_linux_amd64.tar.gz"
MEDIAMTX_SHA256 = "a7ba21268fccda3ebc43fdad76b87fddb85ce77e725b5cb637bca724b5394fbe"
MEDIAMTX_URL = f"https://github.com/bluenviron/mediamtx/releases/download/{MEDIAMTX_VERSION}/{MEDIAMTX_ARCHIVE}"


def mediamtx() -> Path:
    """The pinned relay binary, downloaded and checked once per machine."""
    cache = Path(os.getenv("XDG_CACHE_HOME") or Path.home() / ".cache") / "soundsible" / "mediamtx" / MEDIAMTX_VERSION
    binary = cache / "mediamtx"
    if binary.exists():
        return binary
    archive = fetch([MEDIAMTX_URL], max_bytes=64 * 1024 * 1024, sha256=MEDIAMTX_SHA256, what=MEDIAMTX_ARCHIVE)
    cache.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        member = bundle.extractfile("mediamtx")
        partial = cache / "mediamtx.partial"
        partial.write_bytes(member.read())
    partial.chmod(0o755)
    partial.replace(binary)
    return binary


class LiveFixture:
    def __init__(self, directory: Path, ca: Path, certificate: Path, key: Path, log):
        self.directory, self.ca, self.certificate, self.key, self.log = directory, ca, certificate, key, log
        self.process = None
        self.relay = None

    def start(self):
        self.directory.mkdir()
        for port in (58080, 58443, 58889, 59997, 58189):
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(("127.0.0.1", port))
        config = self.directory / "mediamtx.yml"
        config.write_text(f"""logLevel: info
rtsp: false
rtmp: false
hls: false
srt: false
playback: false
moq: false
api: true
apiAddress: 127.0.0.1:59997
authMethod: http
authHTTPAddress: http://127.0.0.1:58080/internal/media-auth
authHTTPExclude:
  - action: api
  - action: metrics
webrtc: true
webrtcAddress: :58889
webrtcEncryption: true
webrtcServerCert: {self.directory.parent / "server.pem"}
webrtcServerKey: {self.directory.parent / "server-key.pem"}
webrtcLocalUDPAddress: :58189
webrtcLocalTCPAddress: :58189
webrtcAdditionalHosts: [10.0.2.2]
webrtcHandshakeTimeout: 30s
pathDefaults:
  source: publisher
  overridePublisher: false
paths:
  all_others:
""")
        environment = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
                       "COMMUNITY_DB_PATH": str(self.directory / "community.db"),
                       "COMMUNITY_ARTWORK_DIR": str(self.directory / "artwork"),
                       "COMMUNITY_PUBLIC_URL": "https://10.0.2.2:58443",
                       "COMMUNITY_MEDIA_URL": "https://10.0.2.2:58889",
                       "COMMUNITY_MEDIA_HEALTH_URL": "http://127.0.0.1:59997/v3/config/global/get"}
        try:
            self.process = subprocess.Popen([sys.executable, __file__, "--serve", "--cert", str(self.certificate), "--key", str(self.key)], env=environment, stdout=self.log, stderr=self.log)
            self.relay = subprocess.Popen([str(mediamtx()), str(config)], stdout=self.log, stderr=self.log)
            deadline = time.monotonic() + 30
            trust = ssl.create_default_context(cafile=self.ca)
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("Community fixture exited; inspect fixture.log")
                if self.relay.poll() is not None:
                    raise RuntimeError("MediaMTX exited; inspect fixture.log")
                try:
                    with urlopen("https://127.0.0.1:58443/health", context=trust, timeout=1) as response:
                        if response.status == 200:
                            return
                except OSError:
                    time.sleep(.2)
            raise RuntimeError("Live relay startup timed out; inspect fixture.log")
        except BaseException:
            self.close()
            raise

    def close(self):
        for attribute in ("relay", "process"):
            process = getattr(self, attribute)
            if process is None:
                continue
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            setattr(self, attribute, None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true", required=True)
    parser.add_argument("--cert", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    args = parser.parse_args()
    from gevent import monkey
    monkey.patch_all()
    from gevent.pywsgi import WSGIServer
    from geventwebsocket.handler import WebSocketHandler
    from community_service.app import app
    from flask import request, jsonify
    from urllib.request import Request
    import json

    blocked_reads = set()
    denied_reads = {}
    slow_listeners = 0

    @app.before_request
    def isolated_media_failure():
        if request.path == "/internal/media-auth":
            body = request.get_json(silent=True) or {}
            path = (body.get("path"), body.get("action"))
            if path in blocked_reads:
                denied_reads[path] = denied_reads.get(path, 0) + 1
                return "", 503

    @app.route("/__fixture/read-failure", methods=["POST", "GET"])
    def read_failure():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        from community_service.app import _session_row
        body = request.get_json(silent=True) or {}
        room = _session_row(body.get("session_id", request.args.get("session_id", "")))
        if room is None:
            return jsonify(error="invalid isolated resource"), 400
        role = body.get("role", request.args.get("role", "read"))
        if role not in ("read", "publish"):
            return jsonify(error="invalid isolated role"), 400
        path = (room["stream_path"], role)
        if request.method == "POST":
            if body.get("blocked") is True:
                blocked_reads.add(path)
                denied_reads[path] = 0
            else:
                blocked_reads.discard(path)
        return jsonify(denied=denied_reads.get(path, 0), slow_listeners=slow_listeners)

    @app.route("/__fixture/slow-listener", methods=["OPTIONS"])
    def slow_listener():
        nonlocal slow_listeners
        if request.remote_addr != "127.0.0.1":
            return jsonify(error="fixture only"), 403
        slow_listeners += 1
        from gevent import sleep
        sleep(10)
        return "", 204

    @app.route("/__fixture/slow-handshake", methods=["OPTIONS"])
    def slow_handshake():
        if request.remote_addr != "127.0.0.1" or request.headers.get("Authorization") != "Bearer isolated":
            return jsonify(error="fixture only"), 403
        from gevent import sleep
        sleep(10)
        return "", 204

    @app.post("/__fixture/relay-kick")
    def relay_kick():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        from community_service.app import _session_row
        body = request.get_json(silent=True) or {}
        room = _session_row(str(body.get("session_id", "")))
        role = body.get("role")
        if room is None or role not in ("publish", "read"):
            return jsonify(error="invalid isolated resource"), 400
        with urlopen("http://127.0.0.1:59997/v3/webrtcsessions/list", timeout=2) as response:
            peers = json.load(response)["items"]
        selected = [peer for peer in peers if peer["path"] == room["stream_path"] and peer["state"] == role]
        if not selected:
            return jsonify(error="no matching relay peer"), 404
        for peer in selected:
            with urlopen(Request("http://127.0.0.1:59997/v3/webrtcsessions/kick/" + peer["id"], method="POST"), timeout=2):
                pass
        return jsonify(kicked=len(selected))

    @app.post("/__fixture/socket-cut")
    def socket_cut():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        from community_service.app import _connections, socketio
        body = request.get_json(silent=True) or {}
        role = body.get("role")
        if role not in ("host", "guest"):
            return jsonify(error="invalid isolated role"), 400
        selected = [sid for sid, connection in list(_connections.items())
                    if connection["session_id"] == body.get("session_id") and connection["host"] == (role == "host")]
        for sid in selected:
            socketio.server.disconnect(sid, namespace="/")
        return jsonify(disconnected=len(selected))

    @app.get("/__fixture/relay-state")
    def relay_state():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        from community_service.app import _session_row
        room = _session_row(request.args.get("session_id", ""))
        if room is None:
            return jsonify(error="invalid isolated resource"), 400
        with urlopen("http://127.0.0.1:59997/v3/webrtcsessions/list", timeout=2) as response:
            peers = json.load(response)["items"]
        selected = [peer for peer in peers if peer["path"] == room["stream_path"]]
        return jsonify(publishers=sum(peer["state"] == "publish" for peer in selected), readers=sum(peer["state"] == "read" for peer in selected))
    internal = WSGIServer(("127.0.0.1", 58080), app, handler_class=WebSocketHandler)
    internal.start()
    WSGIServer(("127.0.0.1", 58443), app, handler_class=WebSocketHandler,
               certfile=str(args.cert), keyfile=str(args.key)).serve_forever()


if __name__ == "__main__":
    main()
