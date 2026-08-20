"""Media routes preserve the HTTP ranges chosen by the client.

The server used to rewrite open-ended and whole-remainder ranges into guessed
application chunks.  Besides adding round trips, the first guessed chunk could
contain only embedded artwork and no decodable audio.  Werkzeug already
implements the correct progressive contract; these tests pin that boring path.
"""

from __future__ import annotations

import random
import re

import pytest

from tests.conftest import TEST_USER_ID

FILE_BYTES = 4 * 1024 * 1024
_CONTENT_RANGE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")


@pytest.fixture
def client():
    from shared.api import app

    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


@pytest.fixture
def track(tmp_path, monkeypatch):
    from shared.api import get_user_core
    from shared.models import Track
    from shared.user_context import user_context

    payload = random.Random(20260820).randbytes(FILE_BYTES)
    tracks_dir = tmp_path / "tracks"
    tracks_dir.mkdir(parents=True)
    path = tracks_dir / "standard-range.flac"
    path.write_bytes(payload)
    monkeypatch.setattr("shared.app_config.get_output_dir", lambda: str(tmp_path))
    monkeypatch.setattr("shared.security.is_safe_path", lambda *a, **k: True)

    row = Track(
        id="standard-range",
        title="Standard",
        artist="Artist",
        album="Album",
        duration=240,
        file_hash="standard-range",
        original_filename=path.name,
        compressed=False,
        file_size=len(payload),
        bitrate=1411,
        format="flac",
    )
    with user_context(TEST_USER_ID):
        library = get_user_core(TEST_USER_ID).library
        if library.metadata and not library.metadata.get_track_by_id(row.id):
            library.metadata.add_track(row)
    yield row.id, payload
    with user_context(TEST_USER_ID):
        library = get_user_core(TEST_USER_ID).library
        if library.metadata:
            library.metadata.remove_track(row.id)


def _range(response) -> tuple[int, int, int]:
    match = _CONTENT_RANGE.match(response.headers.get("Content-Range", ""))
    assert match
    return tuple(map(int, match.groups()))


def test_open_ended_range_returns_the_exact_remainder(client, track):
    track_id, payload = track
    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=0-"}
    )

    assert response.status_code == 206
    assert _range(response) == (0, len(payload) - 1, len(payload))
    assert response.get_data() == payload
    assert response.headers["Accept-Ranges"] == "bytes"


def test_later_open_range_is_not_widened_or_shortened(client, track):
    track_id, payload = track
    start = 1_048_576
    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": f"bytes={start}-"}
    )

    assert response.status_code == 206
    assert _range(response) == (start, len(payload) - 1, len(payload))
    assert response.get_data() == payload[start:]


def test_closed_and_suffix_ranges_are_answered_exactly(client, track):
    track_id, payload = track
    closed = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=100-200"}
    )
    suffix = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=-1024"}
    )

    assert _range(closed) == (100, 200, len(payload))
    assert closed.get_data() == payload[100:201]
    assert suffix.get_data() == payload[-1024:]


def test_no_range_is_a_complete_200_with_cache_validators(client, track):
    track_id, payload = track
    response = client.get(f"/api/static/stream/{track_id}")

    assert response.status_code == 200
    assert response.get_data() == payload
    assert "private" in response.headers.get("Cache-Control", "")
    assert response.headers.get("ETag") or response.headers.get("Last-Modified")


def test_range_past_end_is_416(client, track):
    track_id, payload = track
    response = client.get(
        f"/api/static/stream/{track_id}",
        headers={"Range": f"bytes={len(payload) + 10}-"},
    )
    assert response.status_code == 416


def test_stream_telemetry_does_not_wrap_or_claim_delivery(client, track, monkeypatch):
    rows: list[dict] = []
    monkeypatch.setattr("shared.telemetry.emit", lambda event, row: rows.append(row))
    track_id, _ = track

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=0-1023"}
    )
    assert response.get_data()
    segments = rows[-1]["segments"]
    assert segments["ranged"] is True
    assert segments["scope"] == "local"
    assert "delivered_bytes" not in segments
    assert "write_ms" not in segments
    assert "complete" not in segments
