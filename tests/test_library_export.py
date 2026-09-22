"""Portable library.json exports: same bytes, one serialization, bounded memory."""
import os
from pathlib import Path
import random
import stat
import tracemalloc
from types import SimpleNamespace

import pytest

from player.library import LibraryManager
from setup_tool.local_provider import LocalStorageProvider
from setup_tool.storage_provider import S3StorageProvider
from shared import atomic_file
from shared.models import LibraryMetadata, Track

_WORDS = ["Rosalía", "東京", "Straße", "😀", "quote\"d", "back\\slash", "tab\tand\nnewline", "\x00", "", "Live"]


def _track(i, rng=None):
    rng = rng or random.Random(i)
    return Track(
        id=f"track-{i}", title=rng.choice(_WORDS) + f" {i}", artist=rng.choice(_WORDS), album=rng.choice(_WORDS),
        duration=rng.choice([180, 0]), file_hash=f"hash-{i}", original_filename=f"{i}.flac", compressed=False,
        file_size=1000 + i, bitrate=rng.choice([320, 1411]), format="flac",
        album_artist=rng.choice([None, "Various"]), artists=rng.choice([None, [], ["A", "B"]]),
        year=rng.choice([None, 1999]), local_path=f"/music/{i}.flac", local_mtime_ns=i,
    )


def _library(count, seed=0):
    rng = random.Random(seed)
    return LibraryMetadata(
        version=7,
        tracks=[_track(i, rng) for i in range(count)],
        playlists={"Mix": [f"track-{i}" for i in range(min(count, 3))], "Empty": []},
        settings={"playlist_covers": {"Mix": "track-0"}, "nested": [1, {"x": None, "y": 1.5}]},
        last_updated="2026-09-22T00:00:00",
        podcast_subscriptions=[{"id": "feed", "title": "Pódcast"}],
        podcast_episode_cache={"feed": {"fetched_at": "now", "episodes": [{"guid": "1", "title": "Epí"}]}},
    )


@pytest.mark.parametrize("count", [0, 1, 511, 512, 513, 1025])
@pytest.mark.parametrize("chunk", [1, 2, 128, 512])
def test_streamed_json_is_byte_identical_to_to_json(count, chunk):
    library = _library(count, seed=count)
    assert "".join(library.iter_json(chunk)) == library.to_json()


def test_streamed_json_matches_empty_headers():
    library = LibraryMetadata(1, [], {}, {}, podcast_subscriptions=[], podcast_episode_cache={})
    assert "".join(library.iter_json()) == library.to_json()


@pytest.fixture
def manager(tmp_path, monkeypatch):
    music = tmp_path / "music"
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: music)
    monkeypatch.setattr("player.library._music_dir_manifest_is_shared", lambda: False)
    manager = LibraryManager(silent=True)
    provider = LocalStorageProvider()
    provider.authenticate({"base_path": str(tmp_path / "bucket-root")})
    provider.bucket_name = "bucket"
    manager.provider = provider
    manager.metadata = _library(40)
    return SimpleNamespace(lib=manager, music=music, mirror=tmp_path / "bucket-root" / "bucket" / "library.json")


def _no_whole_document(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the export built the whole document")

    monkeypatch.setattr(LibraryMetadata, "to_json", refuse)
    monkeypatch.setattr(LibraryMetadata, "to_public_dict", refuse)


def test_a_save_writes_every_copy_from_one_serialization(manager, monkeypatch):
    expected = manager.lib.metadata.to_json().encode("utf-8")
    _no_whole_document(monkeypatch)
    assert manager.lib._save_metadata() is True
    for path in (manager.lib.manifest_path, manager.music / "library.json", manager.mirror):
        assert path.read_bytes() == expected, path
    # No temporaries are left beside any copy.
    for directory in (manager.lib.manifest_path.parent, manager.music, manager.mirror.parent):
        assert not [p.name for p in directory.iterdir() if p.name.startswith(".library.json.")]


def test_a_shared_music_folder_gets_no_copy(manager, monkeypatch):
    monkeypatch.setattr("player.library._music_dir_manifest_is_shared", lambda: True)
    assert manager.lib._save_metadata() is True
    assert manager.lib.manifest_path.exists()
    assert not (manager.music / "library.json").exists()


def test_an_unwritable_copy_is_skipped_and_reported_once(manager, monkeypatch):
    manager.music.parent.mkdir(parents=True, exist_ok=True)
    manager.music.write_text("a file where the music folder should be")
    logged = []
    monkeypatch.setattr(manager.lib, "_log", logged.append)
    expected = manager.lib.metadata.to_json().encode("utf-8")
    assert manager.lib._save_metadata() is True
    assert manager.lib._save_metadata() is True
    assert [message for message in logged if "not writable" in message] == [logged[0]]
    assert manager.lib.manifest_path.read_bytes() == expected
    assert manager.mirror.read_bytes() == expected


def test_the_next_destination_serializes_when_the_first_fails(manager, monkeypatch):
    blocked = manager.lib.manifest_path.parent / "blocked"
    blocked.write_text("not a directory")
    manager.lib.manifest_path = blocked / "library.json"
    expected = manager.lib.metadata.to_json().encode("utf-8")
    assert manager.lib._save_metadata() is True
    assert (manager.music / "library.json").read_bytes() == expected
    assert manager.mirror.read_bytes() == expected


def test_a_failed_rename_leaves_no_temporary(manager, monkeypatch):
    real_replace = atomic_file.os.replace

    def fail_music_copy(source, target):
        if Path(target).parent == manager.music:
            raise OSError("rename refused")
        return real_replace(source, target)

    monkeypatch.setattr(atomic_file.os, "replace", fail_music_copy)
    assert manager.lib._save_metadata() is True
    assert not (manager.music / "library.json").exists()
    assert not [p for p in manager.music.iterdir() if p.name.startswith(".library.json.")]
    assert manager.mirror.exists()


def test_the_provider_mirror_keeps_its_symlink_and_permissions(manager):
    # `upload_json` wrote in place: a symlinked or shared mirror kept its link
    # and permissions. Replacing it whole must keep both too.
    manager.mirror.parent.mkdir(parents=True)
    real = manager.mirror.parent / "real-library.json"
    real.write_text("old")
    real.chmod(0o644)
    manager.mirror.symlink_to(real.name)
    assert manager.lib._save_metadata() is True
    assert manager.mirror.is_symlink()
    assert stat.S_IMODE(real.stat().st_mode) == 0o644
    assert real.read_bytes() == manager.lib.metadata.to_json().encode("utf-8")
    assert not [p.name for p in manager.mirror.parent.iterdir() if p.name.startswith(".real-library.json.")]


def test_a_mirror_that_is_the_source_is_left_alone(tmp_path):
    source = tmp_path / "library.json"
    source.write_text("the only copy")
    provider = LocalStorageProvider()
    provider.authenticate({"base_path": str(tmp_path)})
    provider.bucket_name = "."
    assert provider.save_library_file(source) is True
    assert source.read_text() == "the only copy"
    link = tmp_path / "linked" / "library.json"
    link.parent.mkdir()
    link.symlink_to(source)
    provider.authenticate({"base_path": str(link.parent)})
    assert provider.save_library_file(source) is True
    assert source.read_text() == "the only copy"


def test_a_local_provider_in_the_music_folder_keeps_library_json(manager):
    # Storage endpoint = music folder, bucket ".": the mirror is
    # <music>/library.json, which is also the export source once the per-user
    # manifest cannot be written.
    manager.lib.provider.authenticate({"base_path": str(manager.music)})
    manager.lib.provider.bucket_name = "."
    manager.lib._unwritable_paths.add(str(manager.lib.manifest_path))
    assert manager.lib._save_metadata() is True
    assert (manager.music / "library.json").read_bytes() == manager.lib.metadata.to_json().encode("utf-8")


def test_the_provider_serializes_itself_only_when_no_copy_was_written(manager, monkeypatch):
    calls = []
    manager.lib.provider = SimpleNamespace(
        save_library_file=lambda path: calls.append(("file", Path(path).read_bytes())),
        save_library=lambda metadata: calls.append(("model", metadata)),
    )
    manager.lib._unwritable_paths.update({str(manager.lib.manifest_path), str(manager.music / "library.json")})
    assert manager.lib._save_metadata() is True
    assert calls == [("model", manager.lib.metadata)]


def test_exports_of_one_library_do_not_interleave(manager, monkeypatch):
    held = []
    original = manager.lib._atomic_write

    def checked(path, fill):
        held.append(manager.lib._export_lock.locked())
        return original(path, fill)

    monkeypatch.setattr(manager.lib, "_atomic_write", checked)
    manager.lib._export_metadata(manager.lib.metadata)
    assert held == [True, True]


def test_remote_providers_receive_the_same_text_as_before(tmp_path, monkeypatch):
    library = _library(30)
    path = tmp_path / "library.json"
    atomic_file.publish(path, atomic_file.text_pieces(library.iter_json()))
    uploads = []
    remote = SimpleNamespace(upload_json=lambda text, key: uploads.append((key, text)) or True)
    assert S3StorageProvider.save_library_file(remote, path) is True
    assert uploads == [("library.json", library.to_json())]
    # A text-mode file on Windows holds CRLF; the upload still carries `\n`.
    path.write_bytes(library.to_json().replace("\n", "\r\n").encode("utf-8"))
    monkeypatch.setattr("setup_tool.storage_provider.os.linesep", "\r\n")
    assert S3StorageProvider.save_library_file(remote, path) is True
    assert uploads[-1] == ("library.json", library.to_json())


def test_export_memory_is_bounded_by_a_block_of_tracks(manager):
    manager.lib.metadata = _library(8000)
    size = len(manager.lib.metadata.to_json())
    tracemalloc.start()
    manager.lib._export_metadata(manager.lib.metadata)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert manager.lib.manifest_path.stat().st_size == size
    assert peak < size / 3, (peak, size)


def _temporaries(directory):
    return [p.name for p in directory.iterdir() if p.name.startswith(".library.json.")]


def test_replace_contents_keeps_mode_and_follows_symlinks(tmp_path):
    real = tmp_path / "shared" / "library.json"
    real.parent.mkdir()
    real.write_text("old")
    real.chmod(0o640)
    link = tmp_path / "library.json"
    link.symlink_to(real)
    atomic_file.replace_contents(link, atomic_file.text_pieces(["new"]))
    assert link.is_symlink()
    assert real.read_text() == "new"
    assert stat.S_IMODE(real.stat().st_mode) == 0o640
    assert not _temporaries(real.parent) and not _temporaries(tmp_path)


def test_replace_contents_creates_with_the_umask_default(tmp_path):
    umask = os.umask(0o027)
    try:
        atomic_file.replace_contents(tmp_path / "library.json", atomic_file.text_pieces(["new"]))
    finally:
        os.umask(umask)
    assert stat.S_IMODE((tmp_path / "library.json").stat().st_mode) == 0o640


def test_replace_contents_failure_keeps_the_previous_file(tmp_path):
    path = tmp_path / "library.json"
    path.write_text("previous")

    def broken(handle):
        handle.write(b"{")
        raise ValueError("encoding failed")

    with pytest.raises(ValueError):
        atomic_file.replace_contents(path, broken)
    assert path.read_text() == "previous"
    assert not _temporaries(tmp_path)


def test_replace_contents_writes_in_place_when_the_folder_refuses_temporaries(tmp_path, monkeypatch):
    path = tmp_path / "library.json"
    path.write_text("previous")
    inode = path.stat().st_ino

    def refuse(*args):
        raise PermissionError("read-only folder")

    monkeypatch.setattr(atomic_file.os, "open", refuse)
    atomic_file.replace_contents(path, atomic_file.text_pieces(["new"]))
    assert path.read_text() == "new"
    assert path.stat().st_ino == inode
