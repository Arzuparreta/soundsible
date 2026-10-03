"""Native podcast fixture preserves RSS/token/proxy/Range and account routes."""

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests


def test_podcast_feed_token_and_range_keep_real_account_isolation(tmp_path):
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
                "podcast-test",
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
                    if requests.get(origin + "/__fixture/ready/podcast-test", timeout=1).status_code == 200:
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
            library = member.get(origin + "/api/library", timeout=10).json()
            assert library["podcast_subscriptions"][0]["id"] == "member-feed"
            feed = member.get(origin + "/api/podcasts/feeds/member-feed/episodes", timeout=10)
            assert feed.status_code == 200, feed.text
            episode = feed.json()["episodes"][0]
            assert episode["title"] == "member fixture episode"
            peek = member.post(
                origin + "/api/podcasts/enclosure/peek", json={"enclosure_url": episode["enclosure_url"]}, timeout=10
            )
            assert peek.status_code == 200, peek.text
            token = peek.json()["stream_token"]
            stream = member.get(
                origin + "/api/podcasts/stream/" + token, headers={"Range": "bytes=100-199"}, timeout=10
            )
            assert stream.status_code == 206
            assert len(stream.content) == 100
            assert stream.headers["Content-Range"].startswith("bytes 100-199/")
            assert member.get(origin + "/api/podcasts/stream/invalid", timeout=10).status_code == 400
            assert requests.get(origin + "/api/podcasts/stream/" + token, timeout=10).status_code == 401
            assert (
                member.post(
                    origin + "/api/podcasts/enclosure/peek",
                    json={"enclosure_url": "http://127.0.0.1/private"},
                    timeout=10,
                ).status_code
                == 400
            )
            owner = requests.Session()
            assert (
                owner.post(
                    origin + "/api/auth/login", json={"username": "owner", "password": "android-test"}, timeout=10
                ).status_code
                == 200
            )
            assert owner.get(origin + "/api/podcasts/feeds/member-feed/episodes", timeout=10).status_code == 404
            acquired = member.post(
                origin + "/__fixture/podcast",
                headers={"X-Android-Fixture": "isolated"},
                json={"acquire_episode": True},
                timeout=10,
            )
            assert acquired.status_code == 200, acquired.text
            local = next(
                row
                for row in member.get(origin + "/api/library", timeout=10).json()["tracks"]
                if row["id"] == "member-podcast-acquired"
            )
            assert local["podcast_episode_guid"] == episode["guid"]
            assert not local.get("podcast_enclosure_url")
            local_stream = member.get(
                origin + "/api/static/stream/member-podcast-acquired", headers={"Range": "bytes=100-199"}, timeout=10
            )
            assert local_stream.status_code == 206 and local_stream.content == stream.content
            records = member.get(origin + "/api/android-fixture/podcast-stats", timeout=10).json()["upstream"]
            assert any(row["range"] == "bytes=100-199" for row in records)
            assert all(not row["cookie_present"] for row in records)
        finally:
            process.terminate()
            process.wait(timeout=10)
