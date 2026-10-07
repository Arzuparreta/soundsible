"""Native search fixture substitutes providers, not identity/search/saved routes."""

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests


def test_catalog_search_resolve_and_save_keep_real_account_isolation(tmp_path):
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
                "catalog-test",
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
                    if requests.get(origin + "/__fixture/ready/catalog-test", timeout=1).status_code == 200:
                        break
                except requests.RequestException:
                    pass
                assert time.monotonic() < deadline, (tmp_path / "fixture.log").read_text()
                time.sleep(0.2)
            assert requests.get(origin + "/api/catalog/search?q=fixture", timeout=10).status_code == 401
            member = requests.Session()
            assert (
                member.post(
                    origin + "/api/auth/login", json={"username": "member", "password": "android-test"}, timeout=10
                ).status_code
                == 200
            )
            before = member.get(origin + "/api/library", timeout=10).json()["tracks"]
            response = member.get(
                origin + "/api/catalog/search", params={"q": "fixture", "type": "track,library_track"}, timeout=15
            )
            assert response.status_code == 200, response.text
            data = response.json()
            assert {row["title"] for row in data["items"]} == {"fixture direct song", "fixture resolved song"}
            assert data["partial_failures"][0]["source"] == "musicbrainz"
            resolved = member.post(
                origin + "/api/catalog/resolve",
                json={"artist": "fixture artist", "title": "fixture resolved song", "duration": 60},
                timeout=15,
            )
            assert resolved.status_code == 200, resolved.text
            assert resolved.json()["video_id"] == "C1111111111"
            entry = {
                "title": "fixture resolved song",
                "artist": "fixture artist",
                "keys": ["cat:deezer:track:900001", "deezer:900001", "yt:C1111111111"],
            }
            assert (
                member.post(
                    origin + "/api/library/saved/set", json={"entries": [entry], "saved": True}, timeout=10
                ).status_code
                == 200
            )
            entries = member.get(origin + "/api/library/saved", timeout=10).json()["saved"]
            assert any("yt:C1111111111" in row["keys"] for row in entries)
            assert member.get(origin + "/api/library", timeout=10).json()["tracks"] == before
            entities = member.get(origin + "/api/catalog/search", params={
                "q": "fixture collection", "type": "artist,album"}, timeout=15)
            assert entities.status_code == 200, entities.text
            identities = {item["type"]: item["external_ids"] for item in entities.json()["items"]}
            assert identities["artist"]["deezer_artist_id"] == "910001"
            assert identities["album"]["deezer_album_id"] == "920001"
            # Real Core profiles consume synthetic provider pages, including
            # complete album order and full artist discography.
            artist = member.get(origin + "/api/catalog/artist", params={
                "name": "fixture collection artist", "deezer_id": "910001"}, timeout=15)
            assert artist.status_code == 200, artist.text
            assert artist.json()["deezer_id"] == "910001"
            assert artist.json()["albums"][0]["deezer_id"] == "920001"
            album = member.get(origin + "/api/catalog/album", params={
                "name": "fixture collection album", "artist": "fixture collection artist",
                "deezer_id": "920001"}, timeout=15)
            assert album.status_code == 200, album.text
            assert album.json()["tracklist"][0]["external_ids"]["deezer_id"] == "900001"
            discography = member.get(origin + "/api/catalog/artist/discography",
                params={"deezer_id": "910001"}, timeout=15)
            assert discography.status_code == 200, discography.text
            assert len(discography.json()["tracklist"]) == 1
            # A low confidence candidate enters the real durable review path;
            # the user's choice resumes the normal acquisition pipeline.
            started = member.post(origin + "/api/catalog/album/download", json={"deezer_id": "920002"}, timeout=15)
            assert started.status_code == 202, started.text
            job_id = started.json()["job"]["id"]
            deadline = time.monotonic() + 40
            while True:
                job = member.get(origin + f"/api/migration/jobs/{job_id}", timeout=10).json()["job"]
                if job["state"] == "needs_review":
                    break
                assert time.monotonic() < deadline, job
                time.sleep(0.2)
            assert job["provider"] == "album:920002"
            row = job["tracks"][0]
            assert row["state"] == "needs_review"
            candidate = row["candidates"][0]
            assert candidate["video_id"] == "D1111111111" and candidate["confidence"] < 0.75
            assert member.get(origin + "/api/library", timeout=10).json()["tracks"] == before
            choice = member.post(origin + f"/api/migration/jobs/{job_id}/decision",
                json={"source_key": row["source_key"], "decision": "use_candidate", "candidate": candidate}, timeout=10)
            assert choice.status_code == 200, choice.text
            resumed = member.post(origin + f"/api/migration/jobs/{job_id}/control", json={"action": "resume"}, timeout=10)
            assert resumed.status_code == 200, resumed.text
            while True:
                job = member.get(origin + f"/api/migration/jobs/{job_id}", timeout=10).json()["job"]
                if job["state"] == "completed":
                    break
                assert time.monotonic() < deadline, job
                time.sleep(0.2)
            acquired = [track for track in member.get(origin + "/api/library", timeout=10).json()["tracks"]
                        if track.get("youtube_id") == "D1111111111"]
            assert len(acquired) == 1
            assert acquired[0]["album"] == "fixture review album choose" and acquired[0]["track_number"] == 1
            owner = requests.Session()
            assert (
                owner.post(
                    origin + "/api/auth/login", json={"username": "owner", "password": "android-test"}, timeout=10
                ).status_code
                == 200
            )
            assert not any(
                "yt:C1111111111" in row["keys"]
                for row in owner.get(origin + "/api/library/saved", timeout=10).json()["saved"]
            )
            assert (
                member.post(
                    origin + "/api/library/saved/set", json={"entries": [entry], "saved": False}, timeout=10
                ).status_code
                == 200
            )
            assert not any(
                "yt:C1111111111" in row["keys"]
                for row in member.get(origin + "/api/library/saved", timeout=10).json()["saved"]
            )
            stats = member.get(origin + "/api/android-fixture/catalog-stats", timeout=10).json()
            assert any(row["provider"] == "resolution" for row in stats["calls"])
            assert not any(row["path"] == "/api/catalog/save" for row in stats["requests"])
            # Independent APK cases reset only their synthetic login budget.
            # The real production policy remains active within each case.
            controls = {"X-Android-Fixture": "isolated"}
            reset = origin + "/__fixture/reset-auth-limit"
            assert requests.post(reset, json={}, timeout=10).status_code == 403
            assert requests.post(reset, headers=controls, json={}, timeout=10).status_code == 200
            credentials = {"username": "member", "password": "wrong"}
            for _ in range(10):
                assert requests.post(origin + "/api/auth/login", json=credentials, timeout=10).status_code == 401
            assert requests.post(origin + "/api/auth/login", json=credentials, timeout=10).status_code == 429
            assert requests.post(reset, json={}, timeout=10).status_code == 403
            assert requests.post(origin + "/api/auth/login", json=credentials, timeout=10).status_code == 429
            assert requests.get(origin + "/__fixture/auth-stats", timeout=10).status_code == 403
            audit = requests.get(origin + "/__fixture/auth-stats", headers=controls, timeout=10).json()["events"]
            assert audit[-1]["status"] == 429
            assert all(set(row) == {"status", "time"} for row in audit)
            assert requests.post(reset, headers=controls, json={}, timeout=10).status_code == 200
            assert requests.post(origin + "/api/auth/login", json={"username": "member", "password": "android-test"}, timeout=10).status_code == 200
        finally:
            process.terminate()
            process.wait(timeout=10)
