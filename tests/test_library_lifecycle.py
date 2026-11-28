from pathlib import Path
from dataclasses import replace

import pytest

from player.library import LibraryManager
from setup_tool.local_provider import LocalStorageProvider
from shared.collection import Collection
from shared.library_lifecycle import LibraryPersistenceError, drain
from shared.models import Track, LibraryMetadata
from shared.user_context import user_context
from shared import library_intake, user_cores


def track():
    return Track(id='song', title='Song', artist='Artist', album='Album', duration=1,
                 file_hash='song', original_filename='song.flac',
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


def test_removal_contract_keeps_similar_uploads_and_playlist_occurrences(tmp_path, monkeypatch):
    from flask import Flask
    from shared.api.routes import car, library as routes

    provider, audio = provider_at(tmp_path / 'pool')
    lib = library('alice', provider)
    metadata = replace(lib.metadata, tracks=[
        replace(track(), title='Invincible', artist='World of Warcraft', youtube_id='AHwGc3pXfsY'),
        replace(track(), id='other', file_hash='other', title='Invincible', artist='World of Warcraft',
                youtube_id='4n6WP9qHyRM'),
    ], playlists={'Mix': ['song', 'other', 'song']})
    assert lib._save_metadata(metadata=metadata)
    old, new = [row.item_id for row in metadata.tracks]
    collection = Collection(lib.db)
    collection.write_saved([
        {'item_id': old, 'title': 'Invincible', 'keys': ['yt:AHwGc3pXfsY'], 'favourite': True},
        {'item_id': new, 'title': 'Invincible', 'keys': ['yt:4n6WP9qHyRM']},
    ])

    api = {'get_library': lambda: lib, 'emit_to_user': lambda event: None}
    monkeypatch.setattr(routes, '_get_api', lambda: api)
    monkeypatch.setattr(car, '_get_api', lambda: api)
    monkeypatch.setattr('shared.hardening.get_request_auth_context', lambda **kwargs: {'kind': 'owner'})
    app = Flask(__name__)
    app.register_blueprint(routes.library_bp)
    app.register_blueprint(car.car_bp)
    client = app.test_client()
    assert client.delete(f'/api/library/collection/{old}/download').get_json()['retired_file_ids'] == ['song']
    stream = next(row for row in collection.snapshot()['items'] if row['item_id'] == old)
    assert stream['id'] == 'AHwGc3pXfsY'
    assert stream['cover'] == 'https://img.youtube.com/vi/AHwGc3pXfsY/mqdefault.jpg'
    assert collection.saved()[0]['favourite']
    assert not audio.exists()

    for _ in range(2):
        assert client.delete(f'/api/library/collection/{old}').status_code == 200
    assert client.delete(f'/api/library/collection/{old}/download').status_code == 200
    after = collection.snapshot()
    assert [row['item_id'] for row in after['saved']] == [new]
    assert [row['id'] for row in after['files']] == ['other']
    assert after['playlists'] == {'Mix': [old, new, old]}
    assert next(row for row in after['items'] if row['item_id'] == old)['in_library'] is False
    assert [row['id'] for row in client.get('/api/car/items/all-tracks').get_json()['items']] == [new]
    assert [row['id'] for row in client.get('/api/car/items/playlist:Mix').get_json()['items']] == [old, new, old]


def test_full_removal_rolls_back_membership_with_the_file(tmp_path, monkeypatch):
    provider, audio = provider_at(tmp_path / 'pool')
    lib = library('alice', provider)
    collection = Collection(lib.db)
    collection.write_saved([{'keys': ['lib:song'], 'title': 'Song', 'favourite': True}])
    with pytest.raises(ValueError, match='no online playback source'):
        lib.remove_collection_item('song', keep_saved=True)

    def fail(*args):
        raise OSError('disk full')

    with monkeypatch.context() as failing:
        failing.setattr(lib.db, '_replace_catalog_projection', fail)
        with pytest.raises(LibraryPersistenceError):
            lib.remove_collection_item('song', keep_saved=False)
    assert collection.saved()[0]['favourite']
    assert lib.metadata.get_track_by_id('song')
    drain(provider)
    assert audio.exists()

    assert lib.remove_collection_item('song', keep_saved=False) == ['song']
    assert collection.saved() == []
    assert collection.snapshot()['items'][0]['unavailable']
    assert not audio.exists()


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
    monkeypatch.setattr("shared.realtime.emit_to_user", lambda *a, **k: None)
    for uid in ('alice', 'bob'):
        user_cores.get_user_core(uid)
    for uid in ('alice', 'bob'):
        assert library_intake.add_tracks_to_user_library([track()], user_id=uid) == 1
    user_cores.reset_user_cores()
    for uid in ('alice', 'bob'):
        assert user_cores.get_user_core(uid).library.db.get_track('song')


def test_replayed_download_receipt_does_not_resurrect_deleted_song(monkeypatch):
    import shared.api as api
    monkeypatch.setattr("shared.realtime.emit_to_user", lambda *a, **k: None)
    library_intake.add_tracks_to_user_library([track()], user_id='alice', operation_id='job')
    lib = user_cores.get_user_core('alice').library
    lib.metadata.remove_track('song')
    assert lib._save_metadata()
    assert library_intake.add_tracks_to_user_library([track()], user_id='alice', operation_id='job') == 0
    assert lib.db.get_track('song') is None


def test_failed_download_commit_never_emits_success(monkeypatch):
    import pytest
    import shared.api as api
    from shared.library_lifecycle import LibraryPersistenceError
    emitted = []
    lib = user_cores.get_user_core('alice').library
    def fail(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(lib.db, 'replace_library', fail)
    monkeypatch.setattr("shared.realtime.emit_to_user", lambda *a, **k: emitted.append(a))
    with pytest.raises(LibraryPersistenceError):
        library_intake.add_tracks_to_user_library([track()], user_id='alice')
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


def pool_file(name, content=b'audio'):
    from shared.app_config import get_output_dir
    path = get_output_dir() / 'tracks' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def settled():
    """A clock past the window in which a new file may still be committing."""
    import time
    from shared.library_lifecycle import SETTLED_SECONDS
    return time.time() + 2 * SETTLED_SECONDS


def music_dir_provider():
    from shared.app_config import get_output_dir
    provider = LocalStorageProvider()
    provider.authenticate({'base_path': str(get_output_dir())})
    provider.bucket_name = '.'
    return provider


def test_stale_favourites_json_does_not_retain_deleted_audio():
    import json
    provider = music_dir_provider()
    audio = pool_file('song.flac')
    lib = library('alice', provider)
    # The legacy saved-song file is a restoration copy the collection no longer updates.
    (Path(lib.db.db_path).with_name('favourites.json')).write_text(json.dumps(
        {'version': '1.0', 'favourites': ['song', {'keys': ['lib:song']}]}))
    assert lib.delete_track(track())
    assert not audio.exists()


def test_a_saved_songs_file_key_does_not_hold_the_file():
    from shared.collection import Collection
    provider = music_dir_provider()
    audio = pool_file('song.flac')
    lib = library('alice', provider)
    with user_context('alice'):
        Collection(lib.db).write_saved([{'keys': ['lib:song', 'yt:dQw4w9WgXcQ'], 'title': 'Song', 'favourite': True}])
        assert lib.delete_track(track())
        saved = Collection(lib.db).snapshot()['saved']
    assert [entry['title'] for entry in saved] == ['Song']
    assert not audio.exists()


def test_pre_intent_leftovers_are_retired_once_and_shared_files_kept(tmp_path):
    from shared.library_lifecycle import operation_db, reconcile
    provider = music_dir_provider()
    held = pool_file('song.flac')
    library('alice', provider)
    leftover = pool_file('a' * 64 + '.m4a')
    other_format = pool_file('song.m4a')
    unmanaged = pool_file('notes.txt')
    outside = tmp_path / ('c' * 64 + '.flac')
    outside.write_bytes(b'borrowed')
    (leftover.parent / outside.name).symlink_to(outside)

    assert reconcile(now=settled()) == 1
    drain(provider)
    assert not leftover.exists()
    assert held.exists() and other_format.exists() and unmanaged.exists()
    assert outside.exists() and (leftover.parent / outside.name).is_symlink()
    # Recorded as done: a later leftover is not this pass's business.
    pool_file('d' * 64 + '.m4a')
    assert reconcile(now=settled()) == 0
    with operation_db() as conn:
        assert not conn.execute('SELECT 1 FROM audio_cleanup').fetchone()


def test_reconciliation_leaves_files_that_may_still_be_committing():
    from shared.library_lifecycle import reconcile
    fresh = pool_file('b' * 64 + '.m4a')
    assert reconcile() == 0
    drain(music_dir_provider())
    assert fresh.exists()


def test_an_undescribed_account_keeps_only_the_files_its_own_keys_name():
    from shared.collection_repair import MIGRATION
    from shared.library_lifecycle import reconcile
    from shared.users import create_user
    provider = music_dir_provider()
    for uid in ('alice', 'bob'):
        create_user(uid, user_id=uid, password='account-password')
    alice = library('alice', provider)
    bob = library('bob', provider)
    alices = pool_file('own.flac')
    evidence = pool_file('e' * 64 + '.m4a')
    leftover = pool_file('a' * 64 + '.m4a')
    with user_context('alice'):
        alice.metadata.tracks.append(Track(id='own', title='Own', artist='Artist', album='', duration=1,
                                           file_hash='own', original_filename='own.flac', file_size=4,
                                           bitrate=100, format='flac'))
        alice.metadata.version += 1
        assert alice._save_metadata()
    # Bob has not opened his library since the migration that reads leftover tags.
    with bob.db._get_connection() as conn:
        conn.execute('DELETE FROM collection_migrations WHERE name=?', (MIGRATION,))
        conn.execute("INSERT INTO collection_items(id,snapshot,saved) VALUES ('bare',?,1)",
                     (f'{{"keys": ["lib:{"e" * 64}"]}}',))
        conn.execute('INSERT INTO collection_keys VALUES (?,?)', (f'lib:{"e" * 64}', 'bare'))
        conn.commit()

    with user_context('alice'):
        assert alice.delete_track(alice.metadata.get_track_by_id('own'))
    assert not alices.exists()
    assert reconcile(now=settled()) == 2
    drain(provider)
    assert not leftover.exists()
    assert evidence.exists()
    with bob.db._get_connection() as conn:
        conn.execute('INSERT INTO collection_migrations VALUES (?)', (MIGRATION,))
        conn.commit()
    drain(provider)
    assert not evidence.exists()


def test_a_library_before_the_collection_keeps_its_saved_and_playlist_files():
    import json
    from shared.library_lifecycle import reconcile
    provider = music_dir_provider()
    lib = library('alice', provider)
    saved = pool_file('a' * 64 + '.m4a')
    listed = pool_file('b' * 64 + '.m4a')
    with lib.db._get_connection() as conn:
        conn.execute('DROP TRIGGER IF EXISTS collection_playlist_INSERT')
        conn.execute('DELETE FROM collection_state')
        conn.execute("INSERT INTO playlist_tracks(playlist_name,position,track_id) VALUES ('Mix',1,?)", ('b' * 64,))
        conn.commit()
    Path(lib.db.db_path).with_name('favourites.json').write_text(json.dumps({'favourites': ['a' * 64]}))
    assert reconcile(now=settled()) == 0
    drain(provider)
    assert saved.exists() and listed.exists()


def test_reconciliation_waits_for_unreadable_accounts_and_running_downloads():
    import json
    from shared.library_lifecycle import operation_db, reconcile
    from shared.users import create_user
    from shared.user_context import user_config_dir
    provider = music_dir_provider()
    create_user('alice', user_id='alice', password='account-password')
    library('alice', provider)
    leftover = pool_file('a' * 64 + '.m4a')

    create_user('carol', user_id='carol', password='account-password')
    (user_config_dir('carol') / 'library.json').write_text('{}')
    assert reconcile(now=settled()) is None
    (user_config_dir('carol') / 'library.json').unlink()

    with operation_db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS download_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, updated REAL NOT NULL)')
        conn.execute("INSERT INTO download_jobs VALUES ('job','downloading',?,0)", (json.dumps({}),))
    assert reconcile(now=settled()) is None
    with operation_db() as conn:
        conn.execute("UPDATE download_jobs SET status='completed'")
    assert reconcile(now=settled()) == 1
    drain(provider)
    assert not leftover.exists()


def test_deleting_an_account_retires_only_audio_nobody_else_uses():
    from shared.users import create_user, delete_user
    provider = music_dir_provider()
    shared_audio = pool_file('song.flac')
    own = pool_file('own.flac')
    for uid in ('alice', 'bob'):
        create_user(uid, user_id=uid, password='account-password')
    library('alice', provider)
    bob = library('bob', provider)
    with user_context('bob'):
        bob.metadata.tracks.append(Track(id='own', title='Own', artist='Artist', album='', duration=1,
                                         file_hash='own', original_filename='own.flac', file_size=4,
                                         bitrate=100, format='flac'))
        bob.metadata.version += 1
        assert bob._save_metadata()
    assert delete_user('bob')
    drain(provider)
    assert shared_audio.exists()
    assert not own.exists()
