"""Real NORMAL radio planner consumes acquired fixture files."""

import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
import pytest

from fixture_ports import late_bound_port


@pytest.mark.parametrize("audio_format", ["wav", "flac"])
def test_radio_planner_uses_real_acquired_rows_and_exclusions(tmp_path, audio_format):
    root = Path(__file__).resolve().parents[1]
    port = late_bound_port()
    origin = f"http://127.0.0.1:{port}"
    with (tmp_path / "fixture.log").open("w") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                str(root / "scripts/android_fixture.py"),
                "--audio-format",
                audio_format,
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
            # Engine start-up, not behaviour: scripts/android.py allows the same
            # fixture 240 s on a shared CI runner. 40 s expired under `pytest -n 4`.
            deadline = time.monotonic() + 180
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
                origin + "/__fixture/radio-seed", headers={"X-Android-Fixture": "isolated"}, json={"measured": True}, timeout=30
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
            acquired = {row["id"]: row for row in member.get(origin + "/api/library", timeout=10).json()["tracks"]}
            # The fixture creates distinct songs by copying synthetic bytes;
            # those rows must not inherit the base song's collection identity.
            expected = {'member-track', *(f'member-radio-{index}' for index in range(10))}
            assert len({acquired[source]['item_id'] for source in expected}) == len(expected)
            seeds = member.get(origin + '/api/car/items/radio', timeout=10).json()['items']
            assert len(seeds) == len(expected)
            assert len({row['id'] for row in seeds}) == len(expected)
            assert {row['track_id'] for row in seeds} == expected
            for row in rows:
                recording = acquired[row["track_id"]]
                assert row["loudness_lufs"] == recording["loudness_lufs"]
                assert row["loudness_peak_dbtp"] == recording["loudness_peak_dbtp"]
                assert row["duration"] == recording["duration"]
                assert "file_hash" not in row
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
            headers = {"X-Android-Fixture": "isolated"}
            assert member.post(origin + "/__fixture/radio-delay", json={"seconds": 3}, timeout=10).status_code == 403
            for invalid in [-1, 6, True, "3"]:
                assert (
                    member.post(
                        origin + "/__fixture/radio-delay", headers=headers, json={"seconds": invalid}, timeout=10
                    ).status_code
                    == 400
                )
            assert (
                member.post(
                    origin + "/__fixture/radio-delay", headers=headers, json={"seconds": 3}, timeout=10
                ).status_code
                == 200
            )
            body = {
                "intent": "radio",
                "profile": "balanced",
                "seed": {"track_id": "member-track", "title": "member private song", "artist": "member artist"},
                "exclude": ["member-track"],
                "limit": 8,
            }
            with ThreadPoolExecutor(max_workers=1) as worker:
                pending = worker.submit(member.post, origin + "/api/discovery/music/plan", json=body, timeout=30)
                deadline = time.monotonic() + 20
                while True:
                    stats = member.get(origin + "/__fixture/radio-stats", headers=headers, timeout=10).json()
                    if stats["pending"]:
                        break
                    assert not pending.done(), pending.result().text
                    assert time.monotonic() < deadline
                    time.sleep(0.05)
                retired = stats["delayed_ids"][0]
                assert retired.startswith("member-radio-")
                assert member.delete(origin + "/api/library/tracks/" + retired, timeout=10).status_code == 200
                library = member.get(origin + "/api/library", timeout=10).json()["tracks"]
                assert all(row["id"] != retired for row in library)
                old = pending.result()
                assert old.status_code == 200
                assert any(row.get("track_id") == retired for row in old.json()["items"])
            stats = member.get(origin + "/__fixture/radio-stats", headers=headers, timeout=10).json()
            assert stats["pending"] == 0 and stats["delivered"] == 1 and stats["delay_next"] == 0
            fresh = member.post(origin + "/api/discovery/music/plan", json=body, timeout=30)
            assert fresh.status_code == 200
            assert all(row.get("track_id") != retired for row in fresh.json()["items"])
        finally:
            process.terminate()
            process.wait(timeout=10)
