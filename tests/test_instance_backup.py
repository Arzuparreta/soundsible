"""Offline recovery: actual canonical libraries, instance accounts and WAL data."""
from dataclasses import replace
import json
import sqlite3

import pytest

from shared.database import DatabaseManager, reset_database_managers
from shared.instance_backup import create_backup, restore_backup, verify_backup
from shared.models import LibraryMetadata, Track
from shared.runtime import configure_runtime
from shared.users import create_user, get_user


def test_restore_after_failed_upgrade(isolated_runtime, tmp_path):
    runtime = isolated_runtime
    user = create_user('owner', role='admin', user_id='owner', password='backup-test-passphrase')
    db_path = runtime.config_dir / 'users/owner/library.db'
    db = DatabaseManager(str(db_path))
    track = Track(id='song', title='Original', artist='Artist', album='Album', duration=3,
                  file_hash='song', original_filename='song.flac', compressed=False,
                  file_size=5, bitrate=100, format='flac')
    db.replace_library(LibraryMetadata(1, [track], {'Mix': ['song']}, {'theme': 'dark'}))
    from player.favourites_manager import FavouritesManager
    from shared.user_context import user_context
    with user_context('owner'):
        favourites = FavouritesManager()
        favourites.set_favourite({'keys': ['lib:song'], 'title': 'Original'})
        saved_entries = favourites.get_entries()
    from shared.api.download_queue import DownloadQueueManager
    queue = DownloadQueueManager()
    queue.add({'id': 'pending-song', 'url': 'https://youtu.be/abcdefghijk'}, user_id=user['id'])
    job_id = queue.list_items(user_id='owner')[0]['id']
    (runtime.music_dir / 'song.flac').write_bytes(b'audio')
    (runtime.data_dir / 'artwork').mkdir()
    (runtime.data_dir / 'artwork/cover').write_bytes(b'cover')
    backup = create_backup(tmp_path / 'backup', {'config': runtime.config_dir, 'data': runtime.data_dir,
                                                'music': runtime.music_dir})
    # Simulate a failed newer migration and a lost media file after backup.
    with sqlite3.connect(db_path) as conn:
        conn.execute('DROP TABLE tracks')
    (runtime.music_dir / 'song.flac').unlink()
    reset_database_managers()
    restored = restore_backup(backup, tmp_path / 'restored')
    configure_runtime(replace(runtime, config_dir=restored / 'config', data_dir=restored / 'data',
                              music_dir=restored / 'music'))
    # Opening through the real manager exercises schema reconciliation.
    recovered = DatabaseManager(str(restored / 'config/users/owner/library.db')).load_library_metadata()
    assert recovered.tracks[0].title == 'Original'
    assert recovered.playlists == {'Mix': ['song']}
    assert recovered.settings == {'theme': 'dark'}
    assert get_user('owner')['username'] == 'owner'
    assert DownloadQueueManager().list_items(user_id='owner')[0]['id'] == job_id
    with user_context('owner'):
        assert FavouritesManager().get_entries() == saved_entries
        assert FavouritesManager().is_favourite('song')
    from shared.users import verify_password
    assert verify_password('owner', 'backup-test-passphrase')
    assert (restored / 'music/song.flac').read_bytes() == b'audio'
    assert (restored / 'data/artwork/cover').read_bytes() == b'cover'


def test_committed_wal_is_included(isolated_runtime, tmp_path):
    runtime = isolated_runtime
    conn = sqlite3.connect(runtime.config_dir / 'wal.db')
    try:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('CREATE TABLE evidence (value TEXT)')
        conn.execute("INSERT INTO evidence VALUES ('committed')")
        conn.commit()
        backup = create_backup(tmp_path / 'backup', {'config': runtime.config_dir, 'data': runtime.data_dir})
        with sqlite3.connect(backup / 'config/wal.db') as restored:
            assert restored.execute('SELECT value FROM evidence').fetchone() == ('committed',)
        assert not (backup / 'config/wal.db-wal').exists()
    finally:
        conn.close()


def test_corruption_and_existing_destination_are_refused(isolated_runtime, tmp_path):
    runtime = isolated_runtime
    (runtime.data_dir / 'important').write_bytes(b'original')
    backup = create_backup(tmp_path / 'backup', {'config': runtime.config_dir, 'data': runtime.data_dir})
    restored = restore_backup(backup, tmp_path / 'restore')
    with pytest.raises(FileExistsError):
        restore_backup(backup, restored)
    (backup / 'data/important').write_bytes(b'corrupt!')
    with pytest.raises(ValueError, match='checksum'):
        restore_backup(backup, tmp_path / 'bad')
    assert not (tmp_path / 'bad').exists()
    assert (restored / 'data/important').read_bytes() == b'original'


def test_symlinks_and_recursive_destination_are_refused(isolated_runtime, tmp_path):
    roots = {'config': isolated_runtime.config_dir, 'data': isolated_runtime.data_dir}
    with pytest.raises(ValueError, match='outside'):
        create_backup(isolated_runtime.config_dir / 'backup', roots)
    (isolated_runtime.data_dir / 'outside').symlink_to(tmp_path)
    with pytest.raises(ValueError, match='Symlinks'):
        create_backup(tmp_path / 'backup', roots)
    assert not (tmp_path / 'backup').exists()


def test_restore_inside_backup_is_refused(isolated_runtime, tmp_path):
    backup = create_backup(tmp_path / 'backup', {'config': isolated_runtime.config_dir,
                                                'data': isolated_runtime.data_dir})
    with pytest.raises(ValueError, match='outside'):
        restore_backup(backup, backup / 'restored')
    verify_backup(backup)


def test_storage_credentials_survive_changed_machine_identity(isolated_runtime, tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    from shared.crypto import CredentialManager
    runtime = isolated_runtime
    original_key = Fernet.generate_key()
    monkeypatch.setattr(CredentialManager, '_legacy_machine_key', lambda: original_key)
    encrypted = CredentialManager.encrypt('private-storage-secret')
    (runtime.config_dir / 'config.json').write_text(json.dumps({
        'is_encrypted': True, 'access_key_id': '', 'secret_access_key': encrypted}))
    backup = create_backup(tmp_path / 'backup', {'config': runtime.config_dir, 'data': runtime.data_dir})
    assert not (runtime.config_dir / '.credentials.key').exists()
    restored = restore_backup(backup, tmp_path / 'restored')
    monkeypatch.setattr(CredentialManager, '_legacy_machine_key', Fernet.generate_key)
    configure_runtime(replace(runtime, config_dir=restored / 'config'))
    assert CredentialManager.decrypt(encrypted) == 'private-storage-secret'
    assert CredentialManager.decrypt(CredentialManager.encrypt('new-secret')) == 'new-secret'


def test_upgrade_and_restore_preserves_legacy_layout(isolated_runtime, tmp_path):
    from shared.multiuser_migration import ensure_multiuser_layout
    runtime = isolated_runtime
    # Real pre-account layout; migration creates an account and moves these files.
    original = LibraryMetadata(1, [], {'Legacy mix': []}, {}).to_json()
    (runtime.config_dir / 'library.json').write_text(original)
    backup = create_backup(tmp_path / 'backup', {'config': runtime.config_dir, 'data': runtime.data_dir})
    result = ensure_multiuser_layout()
    assert result['adopted_existing_library']
    assert not (runtime.config_dir / 'library.json').exists()
    restored = restore_backup(backup, tmp_path / 'restored')
    assert (restored / 'config/library.json').read_text() == original
    assert not (restored / 'config/instance.db').exists()
    # A new attempt at the real migration works on the restored state.
    reset_database_managers()
    configure_runtime(replace(runtime, config_dir=restored / 'config', data_dir=restored / 'data'))
    assert ensure_multiuser_layout()['adopted_existing_library']
