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
from shared.models import LibraryMetadata, Track


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
        duration=3, file_hash=track_id, original_filename=path.name,
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
    original_cover = extract_cover(path)

    result = repair_file(path)

    assert result is not None
    assert result.dropped_video
    from shared.artwork import artwork_store
    from shared.audio_files import AudioProcessor
    from pathlib import Path
    assert Path(artwork_store().path(AudioProcessor.calculate_hash(result.path))).read_bytes() == original_cover
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
    assert path.exists(), "original stays until canonical references have committed"


def test_cross_user_remap_saves_an_account_with_only_playlist_references(tmp_path, monkeypatch):
    """The initiating repair account already has the new track objects by the
    time the all-user pass runs. Its playlists still have to make the save."""
    from contextlib import contextmanager
    from types import SimpleNamespace

    from shared.api import remap_track_ids_for_all_users

    path = tmp_path / "new.flac"
    path.write_bytes(b"audio")
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("new", path)],
        playlists={"Mix": ["old"]},
        settings={"playlist_covers": {"Mix": "old"}},
    )
    saves = []

    class Library:
        def __init__(self):
            self.metadata = metadata

        def refresh_if_stale(self):
            pass

        def _save_metadata(self, *, id_replacements=None):
            saves.append(dict(id_replacements or {}))
            return True

    @contextmanager
    def bound_user(_user_id):
        yield

    monkeypatch.setattr("shared.users.list_users", lambda: [{"id": "user"}])
    monkeypatch.setattr("shared.user_context.user_context", bound_user)
    monkeypatch.setattr(
        "shared.api.get_user_core",
        lambda _user_id: SimpleNamespace(
            library=Library(),
            favourites=SimpleNamespace(remap_library_id=lambda *_args: False),
        ),
    )
    monkeypatch.setattr("shared.api.emit_to_user", lambda *_args, **_kwargs: None)

    assert remap_track_ids_for_all_users({"old": "new"}) == {"user": 1}
    assert metadata.playlists == {"Mix": ["new"]}
    assert metadata.settings["playlist_covers"] == {"Mix": "new"}
    assert saves == [{"old": "new"}]


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


def test_a_repair_that_saves_nothing_publishes_nothing(tmp_path, pool_paths, monkeypatch):
    """Every repair now publishes a new object, so the "nothing gained" check
    is what keeps a remux that saves no bytes from churning the track's id."""
    from dataclasses import replace
    from shared import library_repair

    pool = tmp_path / "tracks"
    pool.mkdir()
    path = _music_video(pool, name="hash-1.mp4")
    real_inspect = library_repair.inspect_file
    monkeypatch.setattr(library_repair, "inspect_file",
                        lambda p: (lambda shape: shape and replace(shape, size_bytes=1))(real_inspect(p)))

    summary = repair_library([_track("hash-1", path)], pool, dry_run=False)

    assert summary["id_map"] == {}
    assert sorted(p.name for p in pool.iterdir() if p.suffix != ".png") == ["hash-1.mp4"]


def test_a_failed_repair_commit_discards_its_unreferenced_copies(tmp_path, pool_paths, monkeypatch):
    import shared.api as api
    from shared.user_context import user_context

    pool = tmp_path / "music" / "tracks"
    pool.mkdir(parents=True)
    path = _music_video(pool, name="hash-1.mp4")
    monkeypatch.setattr("shared.app_config.get_output_dir", lambda: pool.parent)
    monkeypatch.setattr(api, "get_output_dir_for_repair", lambda: pool)
    monkeypatch.setattr(api.orchestrator, "submit_task", lambda _name, task: task())
    monkeypatch.setattr(api, "emit_to_user", lambda *_args, **_kwargs: None)
    library = api.get_user_core("alice").library
    library.metadata = LibraryMetadata(1, [_track("hash-1", path)], {}, {})
    assert library._save_metadata()

    def fail(*_args, **_kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(library.db, "replace_library", fail)
    with user_context("alice"):
        api.run_library_repair_task(dry_run=False)

    # The original is still referenced, so it stays; the copy nobody adopted goes.
    assert sorted(p.name for p in pool.iterdir() if p.suffix != ".png") == ["hash-1.mp4"]
    assert library.db.get_track("hash-1")


# --- Restoring the stream a YouTube FLAC was decoded from -------------------


def _flac(directory, name="decoded.flac", *, seconds=3):
    """What the old `ultra` profile stored: YouTube's stream decoded to FLAC."""
    path = directory / name
    subprocess_run([
        ffmpeg_executable(), "-y", "-v", "error",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:a", "flac", str(path),
    ])
    return path


class _Fetcher:
    """Stands in for yt-dlp: hands back a fresh file the way `_download_audio` does."""

    def __init__(self, directory, make):
        self.directory = directory
        self.make = make
        self.calls = []
        self.handed_out = []

    def __call__(self, video_id):
        self.calls.append(video_id)
        path = self.make(self.directory, f"fetched-{len(self.calls)}")
        self.handed_out.append(path)
        return path


@pytest.fixture
def pool(tmp_path):
    path = tmp_path / "tracks"
    path.mkdir()
    return path


@pytest.fixture
def downloads(tmp_path):
    path = tmp_path / "downloads"
    path.mkdir()
    return path


def test_a_youtube_flac_is_replaced_by_the_stream_it_came_from(pool, downloads, pool_paths):
    flac = _flac(pool)
    track = _track("hash-1", flac)
    fetch = _Fetcher(downloads, lambda d, n: _audio_only(d, f"{n}.m4a"))

    summary = repair_library([track], pool, dry_run=False, fetch_original=fetch)

    restored = summary["tracks"][0]
    assert fetch.calls == ["K3JGxj2rvAs"]
    assert summary["id_map"] == {"hash-1": restored.id}
    assert restored.format == "m4a" and restored.file_hash == restored.id
    assert restored.audio_quality == "lossy"
    assert restored.youtube_id == "K3JGxj2rvAs"
    assert restored.added_at == "2026-07-02T10:00:00"
    assert restored.original_filename == "decoded.m4a"
    assert (pool / f"{restored.id}.m4a").is_file()
    assert restored.file_size < flac.stat().st_size
    assert not fetch.handed_out[0].exists()
    assert flac.exists(), "original stays until canonical references have committed"


def test_a_download_of_a_different_length_is_not_the_same_recording(pool, downloads, pool_paths):
    flac = _flac(pool, seconds=3)
    before = flac.read_bytes()
    track = _track("hash-1", flac)
    fetch = _Fetcher(downloads, lambda d, n: _audio_only(d, f"{n}.m4a", seconds=9))

    summary = repair_library([track], pool, dry_run=False, fetch_original=fetch)

    assert summary["tracks"] == [track] and summary["id_map"] == {}
    assert flac.read_bytes() == before
    assert not fetch.handed_out[0].exists()


def test_a_download_that_is_lossless_again_changes_nothing(pool, downloads, pool_paths):
    flac = _flac(pool)
    track = _track("hash-1", flac)
    fetch = _Fetcher(downloads, lambda d, n: _flac(d, f"{n}.flac"))

    summary = repair_library([track], pool, dry_run=False, fetch_original=fetch)

    assert summary["tracks"] == [track] and summary["id_map"] == {}


def test_a_failed_download_keeps_the_stored_file(pool, pool_paths):
    flac = _flac(pool)
    track = _track("hash-1", flac)

    def unavailable(video_id):
        raise RuntimeError("Video unavailable")

    summary = repair_library([track], pool, dry_run=False, fetch_original=unavailable)

    assert summary["tracks"] == [track] and summary["repaired"] == 0
    assert flac.exists()


def test_a_dry_run_counts_youtube_flacs_without_downloading(pool, downloads, pool_paths):
    track = _track("hash-1", _flac(pool))
    fetch = _Fetcher(downloads, lambda d, n: _audio_only(d, f"{n}.m4a"))

    summary = repair_library([track], pool, dry_run=True, fetch_original=fetch)

    assert summary["repaired"] == 1 and fetch.calls == []


@pytest.mark.parametrize("case", ["not from youtube", "outside the pool"])
def test_a_flac_that_is_not_a_youtube_download_is_never_touched(tmp_path, pool, downloads, pool_paths, case):
    if case == "not from youtube":
        track = _track("hash-1", _flac(pool))
        track.youtube_id = None
    else:
        external = tmp_path / "external"
        external.mkdir()
        track = _track("hash-1", _flac(external))
    fetch = _Fetcher(downloads, lambda d, n: _audio_only(d, f"{n}.m4a"))

    summary = repair_library([track], pool, dry_run=False, fetch_original=fetch)

    assert fetch.calls == [] and summary["tracks"] == [track]


def _aac(directory, name, *, kbps, seconds=3):
    path = directory / name
    subprocess_run([
        ffmpeg_executable(), "-y", "-v", "error",
        "-f", "lavfi", "-i", f"anoisesrc=duration={seconds}:amplitude=0.5",
        "-c:a", "aac", "-b:a", f"{kbps}k", str(path),
    ])
    return path


def test_a_low_bitrate_youtube_download_is_fetched_again(pool, downloads, pool_paths):
    stored = _aac(pool, "low.m4a", kbps=48)
    track = _track("hash-1", stored)
    fetch = _Fetcher(downloads, lambda d, n: _aac(d, f"{n}.m4a", kbps=128))

    summary = repair_library([track], pool, dry_run=False, fetch_original=fetch)

    restored = summary["tracks"][0]
    assert summary["id_map"] == {"hash-1": restored.id}
    assert restored.file_size > stored.stat().st_size


def test_a_download_no_better_than_the_stored_file_changes_nothing(pool, downloads, pool_paths):
    track = _track("hash-1", _aac(pool, "low.m4a", kbps=48))
    fetch = _Fetcher(downloads, lambda d, n: _aac(d, f"{n}.m4a", kbps=48))

    summary = repair_library([track], pool, dry_run=False, fetch_original=fetch)

    assert fetch.calls == ["K3JGxj2rvAs"]
    assert summary["tracks"] == [track] and summary["id_map"] == {}
    assert not fetch.handed_out[0].exists()


def test_a_good_youtube_download_is_never_fetched_again(pool, downloads, pool_paths):
    track = _track("hash-1", _aac(pool, "fine.m4a", kbps=128))
    fetch = _Fetcher(downloads, lambda d, n: _aac(d, f"{n}.m4a", kbps=128))

    repair_library([track], pool, dry_run=False, fetch_original=fetch)

    assert fetch.calls == []


def test_the_ultra_profile_never_converts_youtube_audio_to_flac(tmp_path, monkeypatch):
    """`ultra` means the stream as YouTube serves it. When the native download
    fails and yt-dlp has to extract, it must keep that codec, not write FLAC."""
    import shared.downloader.youtube_downloader as ytd
    from shared.downloader.youtube import download

    launched = []

    class FailedRun:
        stdout = iter(())
        returncode = 1

        def wait(self, timeout=None):
            return 1

    def popen(args, **kwargs):
        launched.append(args)
        return FailedRun()

    monkeypatch.setattr(download.subprocess, "Popen", popen)
    downloader = ytd.YouTubeDownloader(tmp_path, quality="ultra")

    with pytest.raises(Exception):
        downloader._download_audio("https://www.youtube.com/watch?v=K3JGxj2rvAs")

    extracting = [args for args in launched if "-x" in args]
    assert extracting, "the fallback extraction ran"
    for args in extracting:
        assert args[args.index("--audio-format") + 1] == "best"
