"""The download pool's library.json writer: streamed, and never visible half-written."""
import threading
from unittest.mock import patch

import pytest

from shared.downloader.service import Downloader
from shared.file_revision import publication_lock, revision
from shared.models import LibraryMetadata
from scripts.benchmark_library_export import library


def writer(tmp_path, count=129):
    target = Downloader.__new__(Downloader)
    target.library_path = tmp_path / 'library.json'
    target.library = library(count)
    target._lock = threading.Lock()
    return target


def save(target, expected=None):
    """Publish the writer's own model against the file as it is now."""
    target.replace_snapshot(target.library, revision(target.library_path) if expected is None else expected)


@pytest.mark.parametrize('count', [0, 1, 128, 129, 257])
def test_exact_bytes_without_full_serialization(tmp_path, count):
    target = writer(tmp_path, count)
    target.library.settings = {'unicode': 'á\n"\\', 'nested': [None, {'v': True}]}
    expected = target.library.to_json().encode()
    with patch.object(LibraryMetadata, 'to_json', side_effect=AssertionError('whole document')):
        save(target)
    assert target.library_path.read_bytes() == expected


def test_preserves_disk_podcasts_but_keeps_current_tracks_and_settings(tmp_path):
    target = writer(tmp_path)
    disk = library(1)
    disk.podcast_subscriptions = [{'id': 'feed', 'title': 'Podcast'}]
    disk.podcast_episode_cache = {'feed': [{'title': 'Episode', 'url': 'https://example.test/a'}]}
    target.library_path.write_text(disk.to_json())
    save(target)
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
    save(target)
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
    save(target)
    assert target.library_path.is_symlink()
    assert actual.stat().st_mode & 0o777 == 0o640
    assert actual.read_text() == target.library.to_json()
    assert not [p.name for p in tmp_path.iterdir() if p.name.startswith('.actual.json.')]


def test_write_error_keeps_previous_file_and_releases_lock(tmp_path):
    target = writer(tmp_path)
    target.library_path.write_text('previous')
    with patch('shared.atomic_file.os.fsync', side_effect=OSError('disk full')):
        with pytest.raises(OSError, match='disk full'):
            save(target)
    assert target.library_path.read_text() == 'previous'
    assert not temporaries(tmp_path)
    assert target._lock.acquire(blocking=False)
    target._lock.release()
    save(target)
    assert target.library_path.read_text() == target.library.to_json()


def test_encoding_failure_propagates_and_allows_next_save(tmp_path):
    target = writer(tmp_path)

    def broken(self, **kwargs):
        yield '{'
        raise ValueError('encoding failed')

    target.library_path.write_text('previous')
    with patch.object(LibraryMetadata, 'iter_json', broken):
        with pytest.raises(ValueError, match='encoding failed'):
            save(target)
    # A reader never sees the '{' that was already written.
    assert target.library_path.read_text() == 'previous'
    assert not temporaries(tmp_path)
    save(target)
    assert target.library_path.read_text() == target.library.to_json()


def test_lock_covers_every_serialized_block(tmp_path):
    target = writer(tmp_path)
    original = LibraryMetadata.iter_json

    def checked(model, **kwargs):
        for block in original(model, **kwargs):
            assert not target._lock.acquire(blocking=False)
            yield block

    with patch.object(LibraryMetadata, 'iter_json', checked):
        save(target)
    assert target._lock.acquire(blocking=False)
    target._lock.release()


def test_temporary_failure_propagates_without_losing_lock(tmp_path):
    target = writer(tmp_path)
    with patch('shared.atomic_file.os.open', side_effect=OSError(28, 'No space left on device')):
        with pytest.raises(OSError, match='No space left'):
            save(target)
    assert not target.library_path.exists()
    assert target._lock.acquire(blocking=False)
    target._lock.release()


def test_model_invalid_tracks_retain_memory_podcasts(tmp_path):
    target = writer(tmp_path)
    target.library.podcast_subscriptions = [{'id': 'memory'}]
    target.library.podcast_episode_cache = {'memory': [1]}
    target.library_path.write_text('{"tracks":[{}],"podcast_subscriptions":[{"id":"disk"}]}')
    save(target)
    assert target.library.podcast_subscriptions == [{'id': 'memory'}]
    assert target.library.podcast_episode_cache == {'memory': [1]}


def test_save_reads_podcasts_without_reconstructing_disk_tracks(tmp_path):
    target = writer(tmp_path)
    disk = library(257)
    disk.podcast_subscriptions = [{'id': 'disk'}]
    target.library_path.write_text(disk.to_json())
    with patch.object(LibraryMetadata, 'from_json', side_effect=AssertionError('model reconstruction')):
        save(target)
    assert target.library.podcast_subscriptions == [{'id': 'disk'}]
    assert len(target.library.tracks) == 129


def test_stale_snapshot_refuses_to_erase_station_edit(tmp_path):
    from shared.library_lifecycle import LibraryPersistenceError
    target = writer(tmp_path, 2)
    save(target)
    # A separate Station writer edits the file after the pool loaded its model.
    changed = library(2)
    changed.tracks[0].title = 'Station edit'
    from shared.atomic_file import publish, text_pieces
    publish(target.library_path, text_pieces(changed.iter_json()))
    with pytest.raises(LibraryPersistenceError) as error:
        save(target, target._manifest_revision)
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
    save(first)
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
    save(target)
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
    save(target)
    monkeypatch.setattr(target, '_read_locked', lambda _: pytest.fail('unnecessary full model reload'))
    target.commit_track(library(2).tracks[1])
    assert len(target.library.tracks) == 2


def test_own_publication_is_neither_hashed_nor_read_again(tmp_path, monkeypatch):
    from shared.downloader import service
    target = writer(tmp_path, 257)
    target.library.podcast_subscriptions = [{'title': 'Español 東京'}]
    target.library.podcast_episode_cache = {'feed': {'episodes': [{'title': 'One'}]}}
    save(target)
    monkeypatch.setattr(service, 'read_revision', lambda *_: pytest.fail('read its own file'))
    monkeypatch.setattr(service, 'read_podcast_fields', lambda *_: pytest.fail('reread podcasts'))
    for index in range(2):
        target.commit_track(library(259).tracks[257 + index])
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert len(saved.tracks) == 259
    # The Station's podcast data travels on: it is the file's, held in memory.
    assert saved.podcast_subscriptions == [{'title': 'Español 東京'}]
    assert saved.podcast_episode_cache == {'feed': {'episodes': [{'title': 'One'}]}}
    assert target._manifest_revision == revision(target.library_path)


@pytest.mark.parametrize('writer_kind', ['cooperating', 'external'])
def test_any_other_writer_makes_the_pool_reload_its_file(tmp_path, monkeypatch, writer_kind):
    from shared.downloader import service
    from shared.atomic_file import publish, text_pieces
    target = writer(tmp_path, 3)
    save(target)
    changed = library(1)
    changed.podcast_subscriptions = [{'id': 'foreign'}]
    if writer_kind == 'cooperating':
        # Even a replacement that kept the file's identity, size and times
        # is seen: it took the publication lock, which counts every hold.
        monkeypatch.setattr(service, 'signature', lambda _: 'unchanged')
        target._seen = target._seen._replace(signature='unchanged')
        publish(target.library_path, text_pieces(changed.iter_json()))
    else:
        # A writer that ignores the lock changes the file's signature.
        target.library_path.write_text(changed.to_json(indent=None))
    target.commit_track(library(2).tracks[1])
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert [track.id for track in saved.tracks] == [changed.tracks[0].id, library(2).tracks[1].id]
    assert saved.podcast_subscriptions == [{'id': 'foreign'}]


def test_failed_publication_keeps_the_previous_file_and_model_revision(tmp_path):
    target = writer(tmp_path, 2)
    save(target)
    old = target._manifest_revision, target.library_path.read_bytes()
    with patch('shared.atomic_file.os.replace', side_effect=OSError('rename failed')):
        with pytest.raises(OSError):
            target.commit_track(library(3).tracks[2])
    assert old == (target._manifest_revision, target.library_path.read_bytes())
    target.commit_track(library(4).tracks[3])
    assert target.library_path.read_text() == target.library.to_json()
    assert len(target.library.tracks) == 4


def test_publication_generation_counts_publications_not_holds(tmp_path):
    import os
    import subprocess
    import sys
    from shared.atomic_file import publish, text_pieces
    path = tmp_path / 'library.json'
    with publication_lock(path) as hold:
        assert hold.generation is None  # Nothing published here yet.
        publish(path, text_pieces(['{}']))
        first = hold.generation
        with publication_lock(path) as nested:
            assert nested is hold
    with publication_lock(path) as hold:
        # Reading under the lock writes nothing and changes nothing.
        assert hold.generation == first
    subprocess.run([sys.executable, '-c', 'import sys\nfrom pathlib import Path\n'
                    'from shared.atomic_file import publish, text_pieces\n'
                    'publish(Path(sys.argv[1]), text_pieces(["[]"]))', str(path)],
                   check=True, env={**os.environ, 'PYTHONPATH': '.'})
    with publication_lock(path) as hold:
        assert hold.generation == (first + 1) % 2**64
    (tmp_path / '.soundsible-write.lock').unlink()
    with publication_lock(path) as hold:
        assert hold.generation is None
        publish(path, text_pieces(['{}']))
        # A fresh counter starts anywhere, not where the old one stopped.
        assert hold.generation not in (None, (first + 2) % 2**64)


def test_publication_digest_includes_windows_newlines(tmp_path, monkeypatch):
    import os
    from types import SimpleNamespace
    from shared import library_json
    target = writer(tmp_path, 2)
    target.library.podcast_subscriptions = [{'title': '東京😀'}]
    with monkeypatch.context() as scoped:
        scoped.setattr(library_json, 'os', SimpleNamespace(linesep='\r\n', fstat=os.fstat))
        save(target)
    assert b'\r\n' in target.library_path.read_bytes()
    assert target._manifest_revision == revision(target.library_path)


def test_writer_landing_after_the_rename_is_not_mistaken_for_the_pool(tmp_path, monkeypatch):
    from shared import atomic_file
    target = writer(tmp_path, 2)
    save(target)
    external = library(2)
    external.tracks[0].title = 'External edit'
    external.podcast_subscriptions = [{'id': 'external'}]
    original = atomic_file.sync_directory

    def replaced_meanwhile(directory):
        original(directory)
        # Same size, written in place, before the pool looks at the file.
        target.library_path.write_text(external.to_json())

    monkeypatch.setattr(atomic_file, 'sync_directory', replaced_meanwhile)
    target.commit_track(library(3).tracks[2])
    monkeypatch.setattr(atomic_file, 'sync_directory', original)
    target.commit_track(library(4).tracks[3])
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert saved.tracks[0].title == 'External edit'
    assert saved.podcast_subscriptions == [{'id': 'external'}]


def test_unreadable_signature_after_publication_is_only_a_cache_miss(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from shared import file_revision
    target = writer(tmp_path, 2)
    save(target)
    snapshot, token = target.read_snapshot()
    snapshot.tracks[0].title = 'Cloud edit'

    def refused(_):
        raise PermissionError('stat refused')

    monkeypatch.setattr(file_revision, 'os', SimpleNamespace(**{**vars(file_revision.os), 'stat': refused}))
    assert file_revision.signature(target.library_path) is None
    target.replace_snapshot(snapshot, token)
    # Published, and adopted: the bookkeeping failure did not undo it.
    assert target.library is snapshot and target._seen is None
    monkeypatch.undo()
    assert LibraryMetadata.from_json(target.library_path.read_text()).tracks[0].title == 'Cloud edit'
    target.commit_track(library(3).tracks[2])
    assert len(LibraryMetadata.from_json(target.library_path.read_text()).tracks) == 3


def test_commit_after_a_station_export_reads_the_file_once(tmp_path):
    from shared.downloader import service
    from shared.atomic_file import publish, text_pieces
    target = writer(tmp_path, 2)
    save(target)
    station = library(3)
    station.podcast_subscriptions = [{'id': 'station'}]
    publish(target.library_path, text_pieces(station.iter_json()))
    with patch.object(service, 'read_revision', wraps=service.read_revision) as reads:
        target.commit_track(library(4).tracks[3])
    assert reads.call_count == 1
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert len(saved.tracks) == 4 and saved.podcast_subscriptions == [{'id': 'station'}]


def test_first_cloud_sync_keeps_the_snapshot_podcasts(tmp_path):
    target = writer(tmp_path, 0)
    target.library = target._load_library()  # As at start-up, with no manifest yet.
    snapshot, token = target.read_snapshot()
    assert token is None and target._manifest_revision is None
    snapshot.podcast_subscriptions = [{'id': 'remote'}]
    snapshot.podcast_episode_cache = {'remote': {'episodes': [{'title': 'One'}]}}
    target.replace_snapshot(snapshot, token)
    saved = LibraryMetadata.from_json(target.library_path.read_text())
    assert saved.podcast_subscriptions == [{'id': 'remote'}]
    assert saved.podcast_episode_cache == {'remote': {'episodes': [{'title': 'One'}]}}
