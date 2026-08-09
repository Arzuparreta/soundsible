"""Serving bytes: the original file, the transcode, and the cover."""

import subprocess

import pytest

from shared.subsonic import transcode
from tests.subsonic_support import build, track

AUDIO = b"ID3" + b"\x00" * 8189  # 8 KiB, enough for a range request to be interesting


@pytest.fixture
def library(tmp_path, monkeypatch):
    """One track with a real file behind it, inside the music directory."""
    music_dir = tmp_path / "music"
    music_dir.mkdir(exist_ok=True)
    path = music_dir / "song.mp3"
    path.write_bytes(AUDIO)

    harness = build(tmp_path, monkeypatch, [track("t1", title="Song", bitrate=320, duration=200)])
    monkeypatch.setattr(
        "shared.path_resolver.resolve_local_track_path", lambda _t: str(path), raising=False
    )
    monkeypatch.setattr(
        "shared.api.routes.subsonic.resolve_local_track_path", lambda _t: str(path)
    )
    monkeypatch.setattr("shared.api.routes.subsonic.is_safe_path", lambda *a, **k: True)
    harness.audio_path = path
    return harness


# ---------------------------------------------------------------------------
# The untouched file
# ---------------------------------------------------------------------------


def test_stream_serves_the_original_bytes(library):
    response = library.client.get("/rest/stream", query_string=library.auth(id="tr-t1"))
    assert response.status_code == 200
    assert response.data == AUDIO
    assert response.mimetype == "audio/mpeg"


def test_stream_honours_a_byte_range(library):
    response = library.client.get(
        "/rest/stream",
        query_string=library.auth(id="tr-t1"),
        headers={"Range": "bytes=0-1023"},
    )
    assert response.status_code == 206
    assert response.headers["Content-Range"].endswith("/8192")
    assert len(response.data) == 1024


def test_format_raw_never_transcodes(library, monkeypatch):
    monkeypatch.setattr(transcode, "stream_transcoded", _must_not_run)
    response = library.client.get(
        "/rest/stream", query_string=library.auth(id="tr-t1", format="raw", maxBitRate="64")
    )
    assert response.data == AUDIO


def test_a_ceiling_the_file_already_meets_does_not_transcode(library, monkeypatch):
    monkeypatch.setattr(transcode, "stream_transcoded", _must_not_run)
    response = library.client.get(
        "/rest/stream", query_string=library.auth(id="tr-t1", maxBitRate="320")
    )
    assert response.data == AUDIO


def test_asking_for_the_format_it_already_is_does_not_transcode(library, monkeypatch):
    monkeypatch.setattr(transcode, "stream_transcoded", _must_not_run)
    response = library.client.get(
        "/rest/stream", query_string=library.auth(id="tr-t1", format="mp3")
    )
    assert response.data == AUDIO


def _must_not_run(*args, **kwargs):  # pragma: no cover - the assertion is the point
    raise AssertionError("this request should have been served from the file")


def test_download_attaches_the_file(library):
    response = library.client.get("/rest/download", query_string=library.auth(id="tr-t1"))
    assert response.status_code == 200
    assert response.data == AUDIO
    assert "attachment" in response.headers["Content-Disposition"]


def test_a_missing_track_is_not_found(library):
    body = library.json("stream", id="tr-nope")
    assert body["error"]["code"] == 70


# ---------------------------------------------------------------------------
# Transcoding
# ---------------------------------------------------------------------------


def test_a_lower_ceiling_transcodes(library, monkeypatch):
    calls = {}

    def fake(path, *, target_format, bitrate_kbps, time_offset=0):
        calls.update(path=path, target_format=target_format, bitrate=bitrate_kbps, offset=time_offset)
        return iter([b"transcoded"]), "audio/mpeg"

    monkeypatch.setattr(transcode, "should_transcode", lambda **kwargs: True)
    monkeypatch.setattr(transcode, "stream_transcoded", fake)

    response = library.client.get(
        "/rest/stream", query_string=library.auth(id="tr-t1", maxBitRate="96", timeOffset="30")
    )
    assert response.data == b"transcoded"
    assert calls["bitrate"] == 96
    assert calls["offset"] == 30
    assert calls["target_format"] == "mp3"


def test_a_transcode_declares_that_it_cannot_be_ranged(library, monkeypatch):
    """Subsonic seeks a transcode with `timeOffset`, so saying so is the honest answer."""
    monkeypatch.setattr(transcode, "should_transcode", lambda **kwargs: True)
    monkeypatch.setattr(
        transcode, "stream_transcoded", lambda *a, **k: (iter([b"x"]), "audio/mpeg")
    )
    response = library.client.get("/rest/stream", query_string=library.auth(id="tr-t1", maxBitRate="96"))
    assert response.headers["Accept-Ranges"] == "none"
    assert "Content-Length" not in response.headers


def test_estimated_length_is_offered_when_asked_for(library, monkeypatch):
    monkeypatch.setattr(transcode, "should_transcode", lambda **kwargs: True)
    monkeypatch.setattr(
        transcode, "stream_transcoded", lambda *a, **k: (iter([b"x"]), "audio/mpeg")
    )
    response = library.client.get(
        "/rest/stream",
        query_string=library.auth(id="tr-t1", maxBitRate="96", estimateContentLength="true"),
    )
    assert int(response.headers["Content-Length"]) == 200 * 96 * 1000 // 8


def test_an_unavailable_transcode_serves_the_file_instead_of_failing(library, monkeypatch):
    monkeypatch.setattr(transcode, "should_transcode", lambda **kwargs: True)
    monkeypatch.setattr(transcode, "stream_transcoded", lambda *a, **k: None)
    response = library.client.get("/rest/stream", query_string=library.auth(id="tr-t1", maxBitRate="96"))
    assert response.data == AUDIO


def test_no_ffmpeg_means_no_transcode_decision(monkeypatch):
    monkeypatch.setattr(transcode, "resolve_ffmpeg", lambda: None)
    assert transcode.should_transcode(
        source_format="flac", source_bitrate=1000, requested_format="mp3", max_bitrate=128
    ) is False


def test_the_ffmpeg_command_seeks_before_decoding(monkeypatch):
    monkeypatch.setattr(transcode, "ffmpeg_executable", lambda: "/usr/bin/ffmpeg")
    command = transcode.transcode_command(
        "/music/song.flac", target_format="mp3", bitrate_kbps=128, time_offset=42
    )
    assert command[:1] == ["/usr/bin/ffmpeg"]
    # -ss before -i, or ffmpeg decodes everything it is about to throw away.
    assert command.index("-ss") < command.index("-i")
    assert "128k" in command
    assert command[-1] == "-"


def test_the_encoder_is_killed_when_the_listener_leaves(monkeypatch, tmp_path):
    """A skipped track must not leave ffmpeg holding a core and a slot."""

    class _Process:
        def __init__(self):
            self.stdout = _Stdout()
            self.killed = False
            self._running = True

        def poll(self):
            return None if self._running else 0

        def kill(self):
            self.killed = True
            self._running = False

        def wait(self, timeout=None):
            return 0

    class _Stdout:
        def __init__(self):
            self.closed = False

        def read(self, _size):
            return b"chunk"

        def close(self):
            self.closed = True

    process = _Process()
    monkeypatch.setattr(transcode, "resolve_ffmpeg", lambda: tmp_path / "ffmpeg")
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: process)

    started = transcode.stream_transcoded("/music/x.flac", target_format="mp3", bitrate_kbps=128)
    chunks, mimetype = started
    assert mimetype == "audio/mpeg"
    assert next(chunks) == b"chunk"
    chunks.close()  # what Flask does when the client disconnects

    assert process.killed is True
    assert process.stdout.closed is True
    # And the slot went back, so the next listener is not refused for nothing.
    assert transcode._slots.acquire(blocking=False) is True
    transcode._slots.release()


def test_concurrency_is_bounded(monkeypatch, tmp_path):
    monkeypatch.setattr(transcode, "resolve_ffmpeg", lambda: tmp_path / "ffmpeg")
    for _ in range(transcode.MAX_CONCURRENT):
        assert transcode._slots.acquire(blocking=False) is True
    try:
        assert transcode.stream_transcoded("/music/x.flac", target_format="mp3", bitrate_kbps=128) is None
    finally:
        for _ in range(transcode.MAX_CONCURRENT):
            transcode._slots.release()


# ---------------------------------------------------------------------------
# Cover art
# ---------------------------------------------------------------------------


def test_cover_art_resolves_song_album_and_artist_ids(library, monkeypatch, tmp_path):
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff\xdbJPEG")
    monkeypatch.setattr(library.library, "get_cover_url", lambda _t: str(cover))

    album_row = library.db.get_albums()[0]
    artist_row = library.db.get_artists()[0]
    for identifier in (f"tr-t1", f"al-{album_row['id']}", f"ar-{artist_row['id']}"):
        response = library.client.get("/rest/getCoverArt", query_string=library.auth(id=identifier))
        assert response.status_code == 200, identifier
        assert response.mimetype == "image/jpeg"


def test_cover_art_without_artwork_is_not_found(library):
    body = library.json("getCoverArt", id="tr-t1")
    assert body["error"]["code"] == 70
