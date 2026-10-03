"""Real isolated engine/provider: complete cache, Range and shared progressive reader ownership."""

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests


def test_android_preview_provider_uses_real_proxy_and_preserves_other_reader(tmp_path):
    root = Path(__file__).resolve().parents[1]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    with (tmp_path / "fixture.log").open("w") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                str(root / "scripts/android_fixture.py"),
                "--root",
                str(tmp_path / "engine"),
                "--port",
                str(port),
                "--run-id",
                "preview-test",
            ],
            cwd=root,
            env={**os.environ, "PYTHONPATH": str(root)},
            stdout=log,
            stderr=log,
        )
        try:
            deadline = time.monotonic() + 40
            while True:
                assert process.poll() is None, (tmp_path / "fixture.log").read_text()
                try:
                    if requests.get(origin + "/__fixture/ready/preview-test", timeout=1).status_code == 200:
                        break
                except requests.RequestException:
                    pass
                assert time.monotonic() < deadline, (tmp_path / "fixture.log").read_text()
                time.sleep(0.2)
            client = requests.Session()
            login = client.post(
                origin + "/api/auth/login", json={"username": "member", "password": "android-test"}, timeout=10
            )
            assert login.status_code == 200, login.text
            warm = client.get(origin + "/api/preview/stream/C1111111111", timeout=30)
            assert warm.status_code == 200 and len(warm.content) > 1000
            partial = client.get(
                origin + "/api/preview/stream/C1111111111", headers={"Range": "bytes=100-199"}, timeout=10
            )
            assert partial.status_code == 206 and partial.content == warm.content[100:200]
            assert partial.headers["X-Soundsible-Playback-Cache"] == "disk"
            assert (
                client.post(
                    origin + "/__fixture/preview", headers={"X-Android-Fixture": "isolated"}, json={"slow": True}
                ).status_code
                == 200
            )
            first = client.get(origin + "/api/preview/stream/D1111111111", stream=True, timeout=30)
            assert first.headers["X-Soundsible-Playback-Cache"] == "progressive"
            assert len(first.raw.read(65536)) == 65536
            second = client.get(
                origin + "/api/preview/stream/D1111111111", headers={"Range": "bytes=65536-"}, stream=True, timeout=30
            )
            assert second.status_code == 206
            assert second.headers["Content-Range"].startswith("bytes 65536-")
            first.close()  # Android must drop its own interest, rather than cancel the global video.
            assert len(second.content) > 65536
            second.close()
            deadline = time.monotonic() + 15
            while True:
                status = client.post(origin + "/api/preview/status", json={"video_ids": ["D1111111111"]}, timeout=10)
                if status.json()["preparation"]["D1111111111"]["state"] == "ready":
                    break
                assert time.monotonic() < deadline, status.text
                time.sleep(0.1)
            stats = client.get(origin + "/api/android-fixture/preview-stats", timeout=10).json()
            assert len(stats["upstream"]) == 2  # One WebM transfer, one shared MP4 transfer.
            assert all(not row["cookie_present"] and row["range"] == "bytes=0-" for row in stats["upstream"])
        finally:
            process.terminate()
            process.wait(timeout=10)
