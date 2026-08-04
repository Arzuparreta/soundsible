"""One click must not cost one enormous HTTP response.

A player opens a track by asking for `bytes=0-`, and the engine used to answer
with the whole file. Measured on a real station over 265 local streams, 40
distinct tracks cost 2.3 GB — 1.55x their own size — and one track was fetched 82
times, because a response carrying 124 MB of 24-bit FLAC keeps dying in flight and
the player keeps starting it again.

These tests hold the two halves of the fix that can be broken by accident. That
an open-ended range comes back as a chunk, and — the one that matters most —
that walking those chunks reassembles the file byte for byte. The point of
slicing rather than transcoding is that nothing about the audio changes, and
`test_a_chunk_walk_reassembles_the_file_exactly` is what makes that a fact
rather than an intention.

The last test holds the telemetry instead of the bytes. It is here rather than in
the report's own tests because what the route writes is the only thing the report
can ever read, and a field quietly dropped from one row is a measurement nobody
can reconstruct afterwards.
"""

from __future__ import annotations

import hashlib
import random
import re

import pytest

from tests.conftest import TEST_USER_ID

#: Big enough to be sliced several times under the default policy, small enough
#: that a test suite does not notice it. With `TRACK_DURATION` this stands in for
#: the shape of the real library: a few hundred kilobytes per second of audio.
FILE_BYTES = 4 * 1024 * 1024
TRACK_DURATION = 240

_CONTENT_RANGE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")


def _content_range(response) -> tuple[int, int, int]:
    header = response.headers.get("Content-Range", "")
    match = _CONTENT_RANGE.match(header)
    assert match, f"unparseable Content-Range: {header!r}"
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


@pytest.fixture
def client():
    from shared.api import app

    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


def _register(tmp_path, monkeypatch, *, track_id, payload, duration):
    from shared.api import get_user_core
    from shared.models import Track
    from shared.user_context import user_context

    tracks_dir = tmp_path / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    audio = tracks_dir / f"{track_id}.flac"
    audio.write_bytes(payload)

    monkeypatch.setattr("shared.app_config.get_output_dir", lambda: str(tmp_path))
    monkeypatch.setattr("shared.security.is_safe_path", lambda *a, **k: True)

    track = Track(
        id=track_id,
        title="Sliced",
        artist="Artist",
        album="Album",
        duration=duration,
        file_hash=track_id,
        original_filename=f"{track_id}.flac",
        compressed=False,
        file_size=len(payload),
        bitrate=1411,
        format="flac",
    )
    with user_context(TEST_USER_ID):
        library = get_user_core(TEST_USER_ID).library
        if library.metadata and not library.metadata.get_track_by_id(track_id):
            library.metadata.add_track(track)
    return audio


def _unregister(track_id):
    from shared.api import get_user_core
    from shared.user_context import user_context

    with user_context(TEST_USER_ID):
        library = get_user_core(TEST_USER_ID).library
        if library.metadata:
            library.metadata.remove_track(track_id)


@pytest.fixture
def big_track(tmp_path, monkeypatch):
    """A track large enough that the default policy has to slice it."""
    # Seeded, so a failure reproduces, and noise rather than zeros, so a body
    # that came back truncated or out of order cannot match by luck.
    payload = random.Random(20260804).randbytes(FILE_BYTES)

    audio = _register(
        tmp_path, monkeypatch, track_id="slicedtrack", payload=payload, duration=TRACK_DURATION
    )
    yield "slicedtrack", audio.read_bytes()
    _unregister("slicedtrack")


@pytest.fixture
def tiny_track(tmp_path, monkeypatch):
    """Smaller than one chunk: there is nothing to slice."""
    payload = b"fLaC" + bytes(4096)
    audio = _register(
        tmp_path, monkeypatch, track_id="tinytrack", payload=payload, duration=1
    )
    yield "tinytrack", audio.read_bytes()
    _unregister("tinytrack")


def test_an_open_range_comes_back_as_a_chunk(client, big_track):
    """`bytes=0-` means "from here on", not "send me everything you have"."""
    track_id, payload = big_track

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=0-"}
    )

    assert response.status_code == 206
    start, end, total = _content_range(response)
    assert start == 0
    # The whole point: less than the file, and the client is told the real total
    # so it still knows how long the track is and where it may seek to.
    assert end < total - 1
    assert total == len(payload)
    assert int(response.headers["Content-Length"]) == end - start + 1
    assert response.headers.get("Accept-Ranges") == "bytes"
    assert response.get_data() == payload[start : end + 1]


def test_a_later_open_range_is_bounded_too(client, big_track):
    """A player buffering forward gets chunks all the way, not one giant tail."""
    track_id, payload = big_track

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=1048576-"}
    )

    assert response.status_code == 206
    start, end, total = _content_range(response)
    assert start == 1048576
    assert end < total - 1
    assert response.get_data() == payload[start : end + 1]


def test_an_explicit_range_is_answered_exactly_as_asked(client, big_track):
    """A caller that named both ends gets both ends. Never widened, never cut."""
    track_id, payload = big_track

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=100-200"}
    )

    assert response.status_code == 206
    assert _content_range(response)[:2] == (100, 200)
    assert response.get_data() == payload[100:201]


def test_a_suffix_range_is_answered_exactly_as_asked(client, big_track):
    """This is how an MP4 demuxer finds a `moov` atom parked at the end.

    Shrinking a suffix range would leave the player unable to read the header of
    a file it can otherwise play perfectly, so it is left alone.
    """
    track_id, payload = big_track

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=-1024"}
    )

    assert response.status_code == 206
    assert response.get_data() == payload[-1024:]


def test_a_request_without_a_range_still_gets_the_whole_file(client, big_track):
    """An unsolicited 206 violates RFC 7233 and breaks plain downloads.

    Browsers effectively always send a range for media — 264 of 265 measured
    requests did — so nothing is lost by leaving this path exactly as it was.
    """
    track_id, payload = big_track

    response = client.get(f"/api/static/stream/{track_id}")

    assert response.status_code == 200
    assert response.get_data() == payload


def test_a_track_smaller_than_a_chunk_arrives_in_one_piece(client, tiny_track):
    track_id, payload = tiny_track

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=0-"}
    )

    assert response.status_code == 206
    assert response.get_data() == payload


def test_a_chunk_walk_reassembles_the_file_exactly(client, big_track):
    """The whole justification for slicing instead of re-encoding.

    A library of 24-bit FLAC cannot give up any quality, so the delivery changed
    and the bytes did not. Walk the chunks the way a player does and the file
    has to come back out with the same hash it went in with.
    """
    track_id, payload = big_track

    received = bytearray()
    requests = 0
    while len(received) < len(payload):
        response = client.get(
            f"/api/static/stream/{track_id}",
            headers={"Range": f"bytes={len(received)}-"},
        )
        assert response.status_code == 206
        start, end, total = _content_range(response)
        assert start == len(received)
        assert total == len(payload)
        received += response.get_data()
        assert len(received) == end + 1
        requests += 1
        assert requests < 200, "chunking made no progress"

    assert hashlib.sha256(received).hexdigest() == hashlib.sha256(payload).hexdigest()
    # It has to be more than one response, or this test would pass on the very
    # behaviour it exists to replace.
    assert requests > 1


def test_the_kill_switch_restores_the_previous_behaviour(client, big_track, monkeypatch):
    """Deciding whether this was worth it means being able to turn it off."""
    track_id, payload = big_track
    monkeypatch.setenv("SOUNDSIBLE_STREAM_BOUNDED", "0")

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=0-"}
    )

    assert response.status_code == 206
    assert response.get_data() == payload


def test_slicing_does_not_cost_the_headers_that_keep_a_track_cached(client, big_track):
    """The caching bargain in `test_stream_caching.py` still has to hold."""
    track_id, _ = big_track

    response = client.get(
        f"/api/static/stream/{track_id}", headers={"Range": "bytes=0-"}
    )

    cache_control = response.headers.get("Cache-Control", "")
    assert "private" in cache_control and "max-age=" in cache_control
    assert response.headers.get("ETag") or response.headers.get("Last-Modified")
    assert response.headers.get("X-Soundsible-Playback-Source") == "local"


@pytest.fixture
def emitted(monkeypatch):
    """Every telemetry row the route writes during a test."""
    rows: list[dict] = []
    monkeypatch.setattr("shared.telemetry.emit", lambda event, row: rows.append(row))
    return rows


def test_a_passthrough_records_why_it_was_not_reshaped(client, big_track, emitted):
    """`bounded: false` alone cannot be read.

    The first measurement after this shipped showed 69 of 95 requests going through
    untouched, and telling "an MP4 demuxer sent a closed range and never reached the
    policy" apart from "the tail already fitted" meant walking raw offsets by hand
    for an afternoon. Both rows below say `bounded: false`; everything that makes
    them different findings is in the other fields.
    """
    track_id, payload = big_track

    client.get(f"/api/static/stream/{track_id}", headers={"Range": "bytes=0-"})
    client.get(
        f"/api/static/stream/{track_id}",
        headers={"Range": f"bytes=65536-{len(payload) - 1}"},
    )
    client.get(f"/api/static/stream/{track_id}", headers={"Range": "bytes=16375-65535"})

    walk, everything, an_atom = (row["segments"] for row in emitted[:3])
    assert (walk["bounded"], walk["range_kind"]) == (True, "open")
    assert (everything["bounded"], everything["range_kind"]) == (False, "closed")
    assert everything["bound_outcome"] == "passthrough_closed"
    # The one that sizes the gap: a closed range for all of what is left is the
    # old failure shape, and a closed range for 48 KB is a demuxer reading a
    # structure. Same `bounded`, same `range_kind`, and not the same thing at all.
    assert everything["range_span"] == 1.0
    assert an_atom["range_span"] < 0.05
    assert walk["format"] == "flac"
