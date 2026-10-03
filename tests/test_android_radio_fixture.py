"""Real NORMAL radio planner consumes acquired fixture files."""

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests


def test_radio_planner_uses_real_acquired_rows_and_exclusions(tmp_path):
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
                "radio-test",
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
                    if requests.get(origin + "/__fixture/ready/radio-test", timeout=1).status_code == 200:
                        break
                except requests.RequestException:
                    pass
                assert time.monotonic() < deadline, (tmp_path / "fixture.log").read_text()
                time.sleep(0.2)
            assert requests.get(origin + "/api/podcasts/feeds/member-feed/episodes", timeout=10).status_code == 401
            member = requests.Session()
            assert (
                member.post(
                    origin + "/api/auth/login", json={"username": "member", "password": "android-test"}, timeout=10
                ).status_code
                == 200
            )
            seeded = member.post(
                origin + "/__fixture/radio-seed", headers={"X-Android-Fixture": "isolated"}, json={}, timeout=10
            )
            assert seeded.status_code == 200, seeded.text
            answer = member.post(
                origin + "/api/discovery/music/plan",
                json={
                    "intent": "radio",
                    "profile": "balanced",
                    "seed": {"track_id": "member-track", "title": "member private song", "artist": "member artist"},
                    "exclude": ["member-track", "member-radio-0"],
                    "limit": 8,
                },
                timeout=30,
            )
            assert answer.status_code == 200, answer.text
            rows = answer.json()["items"]
            assert rows, answer.text
            assert all(
                row["source"] == "library"
                and row["track_id"].startswith("member-radio-")
                and row["track_id"] != "member-radio-0"
                for row in rows
            )
            streamed = member.get(
                origin + "/api/static/stream/" + rows[0]["track_id"], headers={"Range": "bytes=100-199"}, timeout=10
            )
            assert streamed.status_code == 206, streamed.text[:100]
            assert len(streamed.content) == 100
        finally:
            process.terminate()
            process.wait(timeout=10)
