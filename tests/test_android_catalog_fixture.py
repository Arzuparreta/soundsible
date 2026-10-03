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
        finally:
            process.terminate()
            process.wait(timeout=10)
