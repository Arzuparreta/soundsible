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
            directory = member.get(origin + "/api/discovery/podcasts/search?q=fixture", timeout=10)
            assert directory.status_code == 200
            entry = directory.json()["results"][0]
            browse = member.get(
                origin + "/api/podcasts/episodes-by-url", params={"rss_url": entry["feed_url"]}, timeout=10
            )
            assert browse.status_code == 200, browse.text
            followed = member.post(origin + "/api/podcasts/subscribe", json={"rss_url": entry["feed_url"]}, timeout=10)
            assert followed.status_code == 200, followed.text
            subscription = followed.json()["subscription"]
            ep = browse.json()["episodes"][0]
            control = {"X-Android-Fixture": "isolated"}
            member.post(
                origin + "/__fixture/podcast", headers=control, json={"enclosure_status": 503}, timeout=10
            ).raise_for_status()
            intake = member.post(
                origin + "/api/downloader/queue",
                json={
                    "items": [
                        {
                            "source_type": "podcast_enclosure",
                            "enclosure_url": ep["enclosure_url"],
                            "guid": ep["guid"],
                            "podcast_feed_id": subscription["id"],
                            "podcast_rss_url": entry["feed_url"],
                            "title": ep["title"],
                            "show_title": subscription["title"],
                        }
                    ]
                },
                timeout=10,
            )
            assert intake.status_code == 200, intake.text
            job_id = intake.json()["ids"][0]

            def await_job(status):
                deadline = time.monotonic() + 60
                while True:
                    job = next(
                        (
                            row
                            for row in member.get(origin + "/api/downloader/queue/status", timeout=10).json()["queue"]
                            if row["id"] == job_id
                        ),
                        None,
                    )
                    if status == "completed" and job is None:
                        assert any(
                            row.get("podcast_episode_guid") == ep["guid"]
                            for row in member.get(origin + "/api/library", timeout=10).json()["tracks"]
                        )
                        return
                    if job and job["status"] == status:
                        return job
                    assert time.monotonic() < deadline, job
                    time.sleep(0.2)

            await_job("failed")
            member.post(
                origin + "/__fixture/podcast", headers=control, json={"enclosure_status": 0}, timeout=10
            ).raise_for_status()
            retry = member.post(origin + f"/api/downloader/queue/{job_id}/retry", timeout=10)
            assert retry.status_code == 200, retry.text
            await_job("completed")
            downloaded = next(
                row
                for row in member.get(origin + "/api/library", timeout=10).json()["tracks"]
                if row.get("podcast_episode_guid") == ep["guid"]
            )
            assert downloaded["media_kind"] == "podcast_episode" and downloaded["podcast_feed_id"] == subscription["id"]
            assert (
                member.delete(origin + "/api/podcasts/subscriptions/" + subscription["id"], timeout=10).status_code
                == 200
            )
            assert any(
                row["id"] == downloaded["id"]
                for row in member.get(origin + "/api/library", timeout=10).json()["tracks"]
            )
            assert not any(
                row["id"] == downloaded["id"] for row in owner.get(origin + "/api/library", timeout=10).json()["tracks"]
            )
            for path in ("top", "top-episodes"):
                chart = member.get(origin + f"/api/discovery/podcasts/{path}?country=es&limit=10", timeout=10)
                assert chart.status_code == 200, chart.text
                assert chart.json()["results"]
            resolved = member.get(
                origin + "/api/discovery/podcasts/episode?show_id=900003&episode_id=900004&country=es", timeout=10
            )
            assert resolved.status_code == 200, resolved.text
            assert resolved.json()["episode"]["guid"] == "directory-episode-guid"
            records = member.get(origin + "/api/android-fixture/podcast-stats", timeout=10).json()["upstream"]
            assert {"country-chart", "directory-lookup"} <= {row["path"] for row in records}
            assert any(row["range"] == "bytes=100-199" for row in records)
            assert all(not row["cookie_present"] for row in records)
        finally:
            process.terminate()
            process.wait(timeout=10)
