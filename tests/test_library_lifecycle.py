from pathlib import Path

from player.library import LibraryManager
from setup_tool.local_provider import LocalStorageProvider
from shared.library_lifecycle import drain
from shared.models import Track, LibraryMetadata
from shared.user_context import user_context


def track():
    return Track(id='song', title='Song', artist='Artist', album='Album', duration=1,
                 file_hash='song', original_filename='song.flac', compressed=False,
                 file_size=4, bitrate=100, format='flac')


def library(uid, provider):
    with user_context(uid):
        lib = LibraryManager(silent=True)
        lib.provider = provider
        lib.metadata = LibraryMetadata(1, [track()], {'Mix': ['song']}, {})
        assert lib._save_metadata()
        lib._cache_unavailable = True
        return lib


def provider_at(root):
    provider = LocalStorageProvider()
    provider.authenticate({'base_path': str(root)})
    provider.bucket_name = '.'
    audio = root / 'tracks/song.flac'
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b'test')
    return provider, audio


def test_shared_audio_survives_until_last_account_removes_it(tmp_path):
    provider, audio = provider_at(tmp_path / 'pool')
    a, b = library('alice', provider), library('bob', provider)
    assert a.delete_track(track())
    assert audio.exists()
    assert b.db.get_track('song')
    assert b.delete_track(track())
    assert not audio.exists()


def test_failed_commit_keeps_audio_and_restores_memory(tmp_path, monkeypatch):
    provider, audio = provider_at(tmp_path / 'pool')
    a = library('alice', provider)
    def fail(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(a.db, 'replace_library', fail)
    assert not a.delete_track(track())
    assert audio.exists()
    assert a.metadata.get_track_by_id('song')
    drain(provider)
    assert audio.exists()


def test_failed_physical_delete_is_recoverable(tmp_path, monkeypatch):
    provider, audio = provider_at(tmp_path / 'pool')
    a = library('alice', provider)
    real_delete = provider.delete_file
    monkeypatch.setattr(provider, 'delete_file', lambda key: False)
    assert a.delete_track(track())
    assert audio.exists()
    monkeypatch.setattr(provider, 'delete_file', real_delete)
    drain(provider)
    assert not audio.exists()


def test_wipe_does_not_delete_other_accounts_or_unmanaged_files(tmp_path):
    provider, audio = provider_at(tmp_path / 'pool')
    other = audio.parent.parent / 'unmanaged.txt'
    other.write_text('keep')
    a, b = library('alice', provider), library('bob', provider)
    assert a.nuke_library()
    assert audio.exists() and other.exists()
    assert b.db.get_track('song')


def test_unreadable_other_library_blocks_cleanup(tmp_path):
    provider, audio = provider_at(tmp_path / 'pool')
    a, b = library('alice', provider), library('bob', provider)
    # Replace the other database with invalid bytes after closing its pool.
    path = Path(b.db.db_path)
    path.write_bytes(b'not sqlite')
    assert a.delete_track(track())
    assert audio.exists()


def test_download_commits_each_account_before_returning(monkeypatch):
    import shared.api as api
    monkeypatch.setattr(api, 'emit_to_user', lambda *a, **k: None)
    for uid in ('alice', 'bob'):
        api.get_user_core(uid)
    for uid in ('alice', 'bob'):
        assert api.add_tracks_to_user_library([track()], user_id=uid) == 1
    api.reset_user_cores()
    for uid in ('alice', 'bob'):
        assert api.get_user_core(uid).library.db.get_track('song')


def test_replayed_download_receipt_does_not_resurrect_deleted_song(monkeypatch):
    import shared.api as api
    monkeypatch.setattr(api, 'emit_to_user', lambda *a, **k: None)
    api.add_tracks_to_user_library([track()], user_id='alice', operation_id='job')
    lib = api.get_user_core('alice').library
    lib.metadata.remove_track('song')
    assert lib._save_metadata()
    assert api.add_tracks_to_user_library([track()], user_id='alice', operation_id='job') == 0
    assert lib.db.get_track('song') is None


def test_failed_download_commit_never_emits_success(monkeypatch):
    import pytest
    import shared.api as api
    from shared.library_lifecycle import LibraryPersistenceError
    emitted = []
    lib = api.get_user_core('alice').library
    def fail(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(lib.db, 'replace_library', fail)
    monkeypatch.setattr(api, 'emit_to_user', lambda *a, **k: emitted.append(a))
    with pytest.raises(LibraryPersistenceError):
        api.add_tracks_to_user_library([track()], user_id='alice')
    assert not emitted
    assert lib.metadata.get_track_by_id('song') is None


def test_cache_failure_does_not_reverse_a_committed_deletion(tmp_path):
    from types import SimpleNamespace
    provider, audio = provider_at(tmp_path / 'pool')
    lib = library('alice', provider)
    def unavailable(_):
        raise OSError('cache read only')
    lib._cache = SimpleNamespace(remove_track=unavailable)
    assert lib.delete_track(track())
    assert lib.db.get_track('song') is None
    assert not audio.exists()


def test_slow_remote_export_does_not_hold_the_shared_lock(tmp_path, monkeypatch):
    import threading
    from shared.library_lifecycle import coordinated
    provider, _ = provider_at(tmp_path / 'pool')
    lib = library('alice', provider)
    uploading, release = threading.Event(), threading.Event()
    def slow_upload(path, **kwargs):
        uploading.set()
        release.wait(10)
        return True
    monkeypatch.setattr(provider, 'save_library_file', slow_upload)
    lib.metadata.version += 1
    saver = threading.Thread(target=lib._save_metadata)
    saver.start()
    try:
        assert uploading.wait(5)
        # Any other account, or the download queue, can still take the lock.
        acquired = threading.Event()
        def take():
            with coordinated():
                acquired.set()
        other = threading.Thread(target=take)
        other.start()
        assert acquired.wait(5)
        other.join(5)
    finally:
        release.set()
        saver.join(10)
    assert lib.db.get_library_revision() == lib._library_revision


def test_export_still_finishes_before_a_nested_save_returns(tmp_path):
    import json
    from shared.library_lifecycle import coordinated
    provider, _ = provider_at(tmp_path / 'pool')
    lib = library('alice', provider)
    with coordinated():
        lib.metadata.playlists['Later'] = ['song']
        lib.metadata.version += 1
        assert lib._save_metadata()
        exported = json.loads(lib.manifest_path.read_text())
        assert 'Later' not in exported['playlists']
    assert 'Later' in json.loads(lib.manifest_path.read_text())['playlists']


def test_failed_delete_does_not_report_an_earlier_saves_error(tmp_path, monkeypatch):
    import player.library as library_module
    provider, audio = provider_at(tmp_path / 'pool')
    lib = library('alice', provider)
    lib.last_save_error = 'library_conflict'  # from an unrelated earlier save
    def unsafe(*args, **kwargs):
        raise ValueError('Unsafe managed audio key')
    monkeypatch.setattr(library_module, 'retire', unsafe)
    assert not lib.delete_track(track())
    assert lib.last_save_error == 'library_storage_unavailable'
    assert audio.exists()
