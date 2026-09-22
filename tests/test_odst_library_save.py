"""ODST's library.json writer: streamed, and never visible half-written."""
import threading
from unittest.mock import patch

import pytest

from odst_tool.odst_downloader import ODSTDownloader
from shared.models import LibraryMetadata
from scripts.benchmark_library_export import library


def writer(tmp_path, count=129):
    target = ODSTDownloader.__new__(ODSTDownloader)
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

    def broken(self):
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

    def checked(model):
        for block in original(model):
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
