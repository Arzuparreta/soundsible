"""Repairing a stored file must cost the listener nothing.

Every MP4 in the library this was written for carried an H.264 video stream and
a 1.3 MB PNG cover parked in the header — 19.1 MB of file for 96 kbps of music,
of which 1.66 MB had to arrive before the first sample could decode. On a LAN
nobody notices; at the 87 KB/s measured to a phone it is nineteen seconds of
silence.

The repair drops the video and caps the artwork with `-c copy`, so the audio is
moved rather than re-encoded. These tests hold that line: the decoded audio must
come out identical, the cover must survive (smaller), and a file with nothing
wrong with it must not be rewritten at all.
"""

import io
import shutil

import pytest

import shared.ffmpeg_runtime as ffmpeg_runtime
from shared.ffmpeg_runtime import ffmpeg_executable
from shared.library_repair import (
    DEFAULT_COVER_MAX_BYTES,
    extract_cover,
    inspect_file,
    repair_file,
    repair_library,
    shrink_cover,
)
from shared.models import Track


@pytest.fixture(autouse=True)
def real_ffmpeg():
    """These tests exercise the real remux; without ffmpeg there is nothing to test."""
    ffmpeg_runtime._RESOLVED = None
    resolved = ffmpeg_runtime.resolve_ffmpeg()
    if resolved is None or shutil.which(str(resolved)) is None:
        pytest.skip("ffmpeg is not available")
    try:
        yield
    finally:
        ffmpeg_runtime._RESOLVED = None


def _big_cover(edge: int = 700) -> bytes:
    """A PNG as heavy as the ones `--embed-thumbnail` actually parks in a header.

    Built from noise on purpose: a flat or patterned image compresses away, and
    a fixture that compresses away cannot stand in for the 1.3 MB cover this
    exists to catch.
    """
    import os

    from PIL import Image

    image = Image.frombytes("RGB", (edge, edge), os.urandom(edge * edge * 3))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _music_video(tmp_path, name="song.mp4", *, seconds=3, with_cover=True):
    """What yt-dlp's progressive fallback leaves behind: video + audio + art."""
    cover = tmp_path / "cover.png"
    cover.write_bytes(_big_cover())
    path = tmp_path / name
    command = [
        ffmpeg_executable(), "-y", "-v", "error",
        "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=30:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
    ]
    if with_cover:
        command += ["-i", str(cover)]
    command += ["-map", "0:v", "-map", "1:a"]
    if with_cover:
        command += ["-map", "2:v", "-c:v:1", "png", "-disposition:v:1", "attached_pic"]
    command += ["-c:v:0", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "96k", str(path)]
    subprocess_run(command)
    return path


def _audio_only(tmp_path, name="clean.m4a", *, seconds=3):
    path = tmp_path / name
    subprocess_run([
        ffmpeg_executable(), "-y", "-v", "error",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:a", "aac", "-b:a", "96k", str(path),
    ])
    return path


def subprocess_run(command):
    import subprocess

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        pytest.skip(f"ffmpeg could not build the fixture: {result.stderr[:200]}")
    return result


def _decoded_audio_md5(path):
    import subprocess

    out = subprocess.run(
        [ffmpeg_executable(), "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "md5", "-"],
        capture_output=True, text=True,
    ).stdout
    return out.strip().split("=", 1)[1]


@pytest.fixture
def pool_paths(monkeypatch):
    """Resolve a track to the fixture file, so these tests are about repairing
    and not about where the pool lives."""
    import shared.path_resolver as path_resolver

    monkeypatch.setattr(path_resolver, "resolve_local_track_path", lambda track: track.local_path)
    return None


def _track(track_id: str, path) -> Track:
    return Track(
        id=track_id, title="Corpo e Canção", artist="Antdot", album="Single",
        duration=3, file_hash=track_id, original_filename=path.name, compressed=False,
        file_size=path.stat().st_size, bitrate=96, format=path.suffix.lstrip("."),
        youtube_id="K3JGxj2rvAs", added_at="2026-07-02T10:00:00", local_path=str(path),
        is_local=True,
    )


def test_a_music_video_is_recognised_for_what_it_is(tmp_path):
    shape = inspect_file(_music_video(tmp_path))

    assert shape.has_video and "h264" in shape.video_codecs
    assert shape.cover_bytes > DEFAULT_COVER_MAX_BYTES
    assert shape.needs_repair


def test_an_attached_picture_is_not_mistaken_for_video(tmp_path):
    """Cover art rides in a video stream. Reading that as "this is a music
    video" would rewrite half the library for nothing."""
    path = _audio_only(tmp_path)
    from shared.library_repair import embed_cover

    embed_cover(path, shrink_cover(_big_cover()))

    shape = inspect_file(path)
    assert not shape.has_video
    assert not shape.needs_repair


def test_repairing_moves_the_audio_without_touching_it(tmp_path):
    """The whole justification for a remux over a re-encode."""
    path = _music_video(tmp_path)
    before = _decoded_audio_md5(path)

    result = repair_file(path)

    assert result is not None
    assert result.dropped_video
    assert _decoded_audio_md5(result.path) == before
    assert result.size_after < result.size_before


def test_the_cover_survives_the_repair_but_stops_blocking_the_first_note(tmp_path):
    path = _music_video(tmp_path)

    result = repair_file(path)

    assert result.cover_before > DEFAULT_COVER_MAX_BYTES
    assert 0 < result.cover_after <= DEFAULT_COVER_MAX_BYTES
    assert extract_cover(result.path), "a repaired track must still have artwork"


def test_a_file_with_nothing_wrong_is_left_alone(tmp_path):
    """No rewrite, no new hash, no id churn for a track that was already fine."""
    path = _audio_only(tmp_path)
    before = path.read_bytes()

    assert repair_file(path) is None
    assert path.read_bytes() == before


def test_a_failed_verification_leaves_the_original_untouched(tmp_path, monkeypatch):
    """If the audio moved, the repair is wrong and the file is not the place to
    find that out afterwards."""
    path = _music_video(tmp_path)
    before = path.read_bytes()
    from shared import library_repair

    calls = iter(["aaa", "bbb"])
    monkeypatch.setattr(library_repair, "_audio_fingerprint", lambda _p: next(calls, "bbb"))

    assert library_repair.repair_file(path) is None
    assert path.read_bytes() == before


def test_a_dry_run_reports_without_touching_anything(tmp_path, pool_paths):
    path = _music_video(tmp_path)
    before = path.read_bytes()
    track = _track("hash-1", path)

    summary = repair_library([track], tmp_path, dry_run=True)

    assert summary["repaired"] == 1
    assert summary["id_map"] == {}
    assert path.read_bytes() == before


def test_a_repaired_track_keeps_everything_that_was_not_its_bytes(tmp_path, pool_paths):
    """A repair re-keys the track, and `dataclasses.replace` is what stops the
    identity, the date it joined and the video it came from going with it."""
    path = _music_video(tmp_path)
    track = _track("hash-1", path)

    summary = repair_library([track], tmp_path, dry_run=False)

    repaired = summary["tracks"][0]
    assert summary["id_map"] == {"hash-1": repaired.id}
    assert repaired.id != "hash-1" and repaired.file_hash == repaired.id
    assert repaired.youtube_id == "K3JGxj2rvAs"
    assert repaired.added_at == "2026-07-02T10:00:00"
    assert repaired.title == "Corpo e Canção"
    assert (tmp_path / f"{repaired.id}.{repaired.format}").exists()
    assert not path.exists(), "the oversized original is not left behind"


def test_repair_copies_a_scanned_external_file_without_mutating_it(tmp_path, pool_paths):
    external = tmp_path / "external"
    external.mkdir()
    pool = tmp_path / "managed" / "tracks"
    pool.mkdir(parents=True)
    path = _music_video(external)
    before = path.read_bytes()
    track = _track("external-1", path)

    summary = repair_library([track], pool, dry_run=False)

    repaired = summary["tracks"][0]
    assert path.read_bytes() == before
    assert repaired.local_path is None
    assert (pool / f"{repaired.id}.{repaired.format}").is_file()
    assert _decoded_audio_md5(pool / f"{repaired.id}.{repaired.format}") == _decoded_audio_md5(path)


def test_shrinking_refuses_to_invent_a_cover(tmp_path):
    assert shrink_cover(b"") is None
    assert shrink_cover(b"not an image") is None
