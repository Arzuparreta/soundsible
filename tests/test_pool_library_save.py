"""The download pool's library.json writer: streamed, and never visible half-written."""
import threading
from unittest.mock import patch

import pytest

from shared.downloader.service import Downloader
from shared.models import LibraryMetadata
from scripts.benchmark_library_export import library


def writer(tmp_path, count=129):
    target = Downloader.__new__(Downloader)
    target.library_path = tmp_path / 'library.json'
    target.library = library(count)
    target._lock = threading.Lock()
    return target


@pytest.mark.parametrize('count', [0, 1, 128, 129, 257])
def test_exact_bytes_without_full_serialization(tmp_path, count):
    target = writer(tmp_path, count)
    target.library.settings = {'unicode': 'á\n"\\', 'nested': [None, {'v': True}]}
    expected = target.library.to_json().encode()
    with patch.object(LibraryMetadata, 'to_json', side_effect=AssertionError('whole document')):
        target.save_library()
    assert target.library_path.read_bytes() == expected


def test_preserves_disk_podcasts_but_keeps_current_tracks_and_settings(tmp_path):
    target = writer(tmp_path)
    disk = library(1)
    disk.podcast_subscriptions = [{'id': 'feed', 'title': 'Podcast'}]
    disk.podcast_episode_cache = {'feed': [{'title': 'Episode', 'url': 'https://example.test/a'}]}
    target.library_path.write_text(disk.to_json())
    target.save_library()
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert len(saved.tracks) == 129
    assert saved.settings == target.library.settings
    assert saved.podcast_subscriptions == disk.podcast_subscriptions
    assert saved.podcast_episode_cache == disk.podcast_episode_cache
    assert target.library_path.read_text() == target.library.to_json()


def test_corrupt_disk_matches_legacy_empty_podcast_defaults(tmp_path):
    target = writer(tmp_path)
    target.library.podcast_episode_cache = {'feed': []}
    target.library_path.write_text('{invalid')
    target.save_library()
    assert target.library.podcast_subscriptions == []
    assert target.library.podcast_episode_cache == {}
    assert target.library_path.read_text() == target.library.to_json()


def temporaries(tmp_path):
    return [p.name for p in tmp_path.iterdir() if p.name.startswith('.library.json.')]


def test_keeps_symlink_and_permissions(tmp_path):
    target = writer(tmp_path)
    actual = tmp_path / 'actual.json'
    actual.write_text('old')
    actual.chmod(0o640)
    target.library_path.symlink_to(actual)
    target.save_library()
    assert target.library_path.is_symlink()
    assert actual.stat().st_mode & 0o777 == 0o640
    assert actual.read_text() == target.library.to_json()
    assert not [p.name for p in tmp_path.iterdir() if p.name.startswith('.actual.json.')]


def test_write_error_keeps_previous_file_and_releases_lock(tmp_path):
    target = writer(tmp_path)
    target.library_path.write_text('previous')
    with patch('shared.atomic_file.os.fsync', side_effect=OSError('disk full')):
        with pytest.raises(OSError, match='disk full'):
            target.save_library()
    assert target.library_path.read_text() == 'previous'
    assert not temporaries(tmp_path)
    assert target._lock.acquire(blocking=False)
    target._lock.release()
    target.save_library()
    assert target.library_path.read_text() == target.library.to_json()


def test_encoding_failure_propagates_and_allows_next_save(tmp_path):
    target = writer(tmp_path)

    def broken(self, **kwargs):
        yield '{'
        raise ValueError('encoding failed')

    target.library_path.write_text('previous')
    with patch.object(LibraryMetadata, 'iter_json', broken):
        with pytest.raises(ValueError, match='encoding failed'):
            target.save_library()
    # A reader never sees the '{' that was already written.
    assert target.library_path.read_text() == 'previous'
    assert not temporaries(tmp_path)
    target.save_library()
    assert target.library_path.read_text() == target.library.to_json()


def test_lock_covers_every_serialized_block(tmp_path):
    target = writer(tmp_path)
    original = LibraryMetadata.iter_json

    def checked(model, **kwargs):
        for block in original(model, **kwargs):
            assert not target._lock.acquire(blocking=False)
            yield block

    with patch.object(LibraryMetadata, 'iter_json', checked):
        target.save_library()
    assert target._lock.acquire(blocking=False)
    target._lock.release()


def test_temporary_failure_propagates_without_losing_lock(tmp_path):
    target = writer(tmp_path)
    with patch('shared.atomic_file.os.open', side_effect=OSError(28, 'No space left on device')):
        with pytest.raises(OSError, match='No space left'):
            target.save_library()
    assert not target.library_path.exists()
    assert target._lock.acquire(blocking=False)
    target._lock.release()


def test_model_invalid_tracks_retain_memory_podcasts(tmp_path):
    target = writer(tmp_path)
    target.library.podcast_subscriptions = [{'id': 'memory'}]
    target.library.podcast_episode_cache = {'memory': [1]}
    target.library_path.write_text('{"tracks":[{}],"podcast_subscriptions":[{"id":"disk"}]}')
    target.save_library()
    assert target.library.podcast_subscriptions == [{'id': 'memory'}]
    assert target.library.podcast_episode_cache == {'memory': [1]}


def test_save_reads_podcasts_without_reconstructing_disk_tracks(tmp_path):
    target = writer(tmp_path)
    disk = library(257)
    disk.podcast_subscriptions = [{'id': 'disk'}]
    target.library_path.write_text(disk.to_json())
    with patch.object(LibraryMetadata, 'from_json', side_effect=AssertionError('model reconstruction')):
        target.save_library()
    assert target.library.podcast_subscriptions == [{'id': 'disk'}]
    assert len(target.library.tracks) == 129


def test_stale_snapshot_refuses_to_erase_station_edit(tmp_path):
    from shared.library_lifecycle import LibraryPersistenceError
    target = writer(tmp_path, 2)
    target.save_library()
    # A separate Station writer edits the file after the pool loaded its model.
    changed = library(2)
    changed.tracks[0].title = 'Station edit'
    from shared.atomic_file import publish, text_pieces
    publish(target.library_path, text_pieces(changed.iter_json()))
    with pytest.raises(LibraryPersistenceError) as error:
        target.save_library()
    assert error.value.status == 409
    assert LibraryMetadata.from_json(target.library_path.read_text()).tracks[0].title == 'Station edit'
    # A targeted acquisition reloads the current pool before adding its result.
    added = library(3).tracks[2]
    target.commit_track(added)
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert len(saved.tracks) == 3
    assert saved.tracks[0].title == 'Station edit'


def test_two_downloaders_do_not_drop_each_others_additions(tmp_path):
    first = writer(tmp_path, 1)
    first.save_library()
    second = writer(tmp_path, 1)
    second.library = second._load_library()
    first.commit_track(library(2).tracks[1])
    second.commit_track(library(3).tracks[2])
    assert len(LibraryMetadata.from_json(first.library_path.read_text()).tracks) == 3


def test_corrupt_manifest_is_never_reinterpreted_as_empty_on_load(tmp_path):
    target = writer(tmp_path)
    target.library_path.write_text('{broken')
    with pytest.raises(ValueError):
        target._load_library()
    assert target.library_path.read_text() == '{broken'


def test_processes_merge_acquired_tracks_under_publication_lock(tmp_path):
    import os
    import subprocess
    import sys
    script = '''
import sys, threading
from pathlib import Path
from shared.downloader.service import Downloader
from scripts.benchmark_library_export import library
writer = Downloader.__new__(Downloader)
writer.library_path = Path(sys.argv[1])
writer._lock = threading.Lock()
writer.commit_track(library(3).tracks[int(sys.argv[2])])
'''
    processes = [subprocess.Popen([sys.executable, '-c', script, str(tmp_path / 'library.json'), str(i)],
                                  env={**os.environ, 'PYTHONPATH': '.'}) for i in range(3)]
    for process in processes:
        assert process.wait(timeout=30) == 0
    assert len(LibraryMetadata.from_json((tmp_path / 'library.json').read_text()).tracks) == 3


def test_sync_snapshot_cannot_erase_download_on_same_downloader(tmp_path):
    from shared.library_lifecycle import LibraryPersistenceError
    target = writer(tmp_path, 1)
    target.save_library()
    snapshot, token = target.read_snapshot()
    target.commit_track(library(2).tracks[1])
    snapshot.tracks[0].title = 'Cloud edit'
    with pytest.raises(LibraryPersistenceError):
        target.replace_snapshot(snapshot, token)
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert len(saved.tracks) == 2
    assert saved.tracks[0].title != 'Cloud edit'


def test_unchanged_manifest_does_not_rebuild_the_resident_library(tmp_path, monkeypatch):
    target = writer(tmp_path, 1)
    target.save_library()
    monkeypatch.setattr(target, '_load_library', lambda: pytest.fail('unnecessary full model reload'))
    target.commit_track(library(2).tracks[1])
    assert len(target.library.tracks) == 2


def test_verified_own_manifest_reads_only_podcast_tail(tmp_path, monkeypatch):
    from shared.downloader import service
    from shared.file_revision import revision
    target = writer(tmp_path, 257)
    target.library.podcast_subscriptions = [{'title': 'Español 東京'}]
    target.save_library()
    assert target._manifest_revision == revision(target.library_path)
    original = service.read_podcast_fields
    offsets = []

    def read(source, **kwargs):
        offsets.append(kwargs['offset'])
        assert kwargs['offset'] > target.library_path.stat().st_size * .9
        return original(source, **kwargs)

    monkeypatch.setattr(service, 'read_podcast_fields', read)
    # Even a caller that changes the in-memory podcast fields gets the exact
    # disk projection, as with the full reader.
    target.library.podcast_subscriptions = [{'id': 'memory'}]
    target.save_library()
    assert target.library.podcast_subscriptions == [{'title': 'Español 東京'}]
    assert len(offsets) == 1
    assert target._manifest_revision == revision(target.library_path)


def test_foreign_snapshot_never_reuses_podcast_offset(tmp_path, monkeypatch):
    from shared.downloader import service
    target = writer(tmp_path, 3)
    target.save_library()
    changed = library(1)
    changed.podcast_subscriptions = [{'id': 'foreign'}]
    target.library_path.write_text(changed.to_json(indent=None))
    original = service.read_podcast_fields

    def read(source, **kwargs):
        assert kwargs['offset'] is None
        return original(source, **kwargs)

    monkeypatch.setattr(service, 'read_podcast_fields', read)
    target.commit_track(library(2).tracks[1])
    assert target.library.podcast_subscriptions == [{'id': 'foreign'}]


def test_failed_publication_does_not_publish_new_offset_or_revision(tmp_path):
    target = writer(tmp_path, 2)
    target.save_library()
    old = target._manifest_revision, target._podcast_revision, target._podcast_offset
    target.library.tracks[0].title = 'A much longer title'
    with patch('shared.atomic_file.os.replace', side_effect=OSError('rename failed')):
        with pytest.raises(OSError):
            target.save_library()
    assert old == (target._manifest_revision, target._podcast_revision, target._podcast_offset)
    target.save_library()
    assert target.library_path.read_text() == target.library.to_json()


def test_model_invalid_own_export_keeps_full_reader_semantics(tmp_path):
    target = writer(tmp_path, 1)
    target.library.version = float('inf')
    target.save_library()
    assert target._podcast_offset is None
    target.library.podcast_subscriptions = [{'id': 'memory'}]
    target.save_library()
    # The old model reader rejects Infinity-as-version and retains memory.
    assert target.library.podcast_subscriptions == [{'id': 'memory'}]


def test_commit_hashes_the_existing_manifest_only_once(tmp_path):
    from shared.downloader import service
    target = writer(tmp_path, 2)
    target.save_library()
    with patch.object(service, 'revision', wraps=service.revision) as checked:
        target.commit_track(library(3).tracks[2])
    assert checked.call_count == 1
    assert len(LibraryMetadata.from_json(target.library_path.read_text()).tracks) == 3


def test_publication_digest_and_offset_include_windows_newlines(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from shared import library_json
    from shared.file_revision import revision
    target = writer(tmp_path, 2)
    target.library.podcast_subscriptions = [{'title': '東京😀'}]
    with monkeypatch.context() as scoped:
        scoped.setattr(library_json, 'os', SimpleNamespace(linesep='\r\n'))
        target.save_library()
    assert b'\r\n' in target.library_path.read_bytes()
    assert target._manifest_revision == revision(target.library_path)
    target.library.podcast_subscriptions.clear()
    target.save_library()
    assert target.library.podcast_subscriptions == [{'title': '東京😀'}]
