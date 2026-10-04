"""Synthetic provider bytes exercise the actual acquisition pipeline, ownership and cancellation."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import requests


def test_acquisition_retry_commit_and_cancel_keep_real_account_ownership(tmp_path):
    root = Path(__file__).resolve().parents[1]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    headers = {"X-Android-Fixture": "isolated"}
    with (tmp_path / "fixture.log").open("w") as log:
        process = subprocess.Popen([sys.executable, str(root / "scripts/android_fixture.py"), "--root", str(tmp_path / "engine"), "--port", str(port), "--run-id", "acquisition-test"], cwd=root, env={**os.environ, "PYTHONPATH": str(root)}, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 45
            while True:
                assert process.poll() is None, (tmp_path / "fixture.log").read_text()
                try:
                    if requests.get(origin + "/__fixture/ready/acquisition-test", timeout=1).status_code == 200:
                        break
                except requests.RequestException:
                    pass
                assert time.monotonic() < deadline, (tmp_path / "fixture.log").read_text()
                time.sleep(.2)
            assert requests.get(origin + "/__fixture/acquisition", timeout=5).status_code == 403
            member, owner = requests.Session(), requests.Session()
            for account, session in (("member", member), ("owner", owner)):
                assert session.post(origin + "/api/auth/login", json={"username": account, "password": "android-test"}, timeout=10).status_code == 200

            def jobs():
                answer = member.get(origin + "/api/downloader/queue/status", timeout=10)
                assert answer.status_code == 200, answer.text
                return answer.json()["queue"]

            def wait(condition):
                deadline = time.monotonic() + 35
                while not condition():
                    assert time.monotonic() < deadline, (tmp_path / "fixture.log").read_text()
                    time.sleep(.1)

            def enqueue(video):
                answer = member.post(origin + "/api/downloader/queue", json={"items": [{"source_type": "youtube_url", "song_str": "https://www.youtube.com/watch?v=" + video, "video_id": video, "display_title": "member acquired song", "display_artist": "member artist", "identity_keys": ["yt:" + video]}]}, timeout=10)
                assert answer.status_code == 200, answer.text
                assert answer.json()["accepted"][0]["index"] == 0
                return answer.json()["accepted"][0]["id"]

            assert requests.post(origin + "/__fixture/acquisition", headers=headers, json={"failNext": 1}, timeout=5).status_code == 200
            job = enqueue("B1111111111")
            wait(lambda: any(row["id"] == job and row["status"] == "failed" for row in jobs()))
            assert owner.get(origin + "/api/downloader/queue/status", timeout=10).json()["queue"] == []
            assert owner.delete(origin + "/api/downloader/queue/" + job, timeout=10).status_code == 200
            assert any(row["id"] == job for row in jobs())
            assert member.post(origin + "/api/downloader/queue/" + job + "/retry", timeout=10).json()["status"] == "retried"
            wait(lambda: any(row["id"] == job and row.get("progress_percent", 0) > 0 for row in jobs()))
            wait(lambda: not any(row["id"] == job for row in jobs()))
            rows = member.get(origin + "/api/library", timeout=10).json()["tracks"]
            acquired = next(row for row in rows if row.get("youtube_id") == "B1111111111")
            assert acquired["id"] != "B1111111111" and acquired["format"] == "mp4"
            streamed = member.get(origin + "/api/static/stream/" + acquired["id"], headers={"Range": "bytes=100-199"}, timeout=10)
            assert streamed.status_code == 206 and len(streamed.content) == 100
            assert requests.post(origin + "/__fixture/acquisition", headers=headers, json={"delaySeconds": 5}, timeout=5).status_code == 200
            cancelled = enqueue("D1111111111")
            wait(lambda: any(row["id"] == cancelled and row.get("progress_percent", 0) > 0 for row in jobs()))
            assert member.delete(origin + "/api/downloader/queue/" + cancelled, timeout=10).json()["status"] == "removed"
            wait(lambda: requests.get(origin + "/__fixture/acquisition", headers=headers, timeout=5).json()["active"] == 0)
            time.sleep(1)
            assert not any(row["id"] == cancelled for row in jobs())
            assert not any(row.get("youtube_id") == "D1111111111" for row in member.get(origin + "/api/library", timeout=10).json()["tracks"])
            assert not any(row.get("youtube_id") in {"B1111111111", "D1111111111"} for row in owner.get(origin + "/api/library", timeout=10).json()["tracks"])
        finally:
            process.terminate()
            process.wait(timeout=10)
