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
    user = create_user('owner', role='admin', user_id='owner')
    db_path = runtime.config_dir / 'users/owner/library.db'
    db = DatabaseManager(str(db_path))
    track = Track(id='song', title='Original', artist='Artist', album='Album', duration=3,
                  file_hash='song', original_filename='song.flac', compressed=False,
                  file_size=5, bitrate=100, format='flac')
    db.replace_library(LibraryMetadata(1, [track], {'Mix': ['song']}, {'theme': 'dark'}))
    (runtime.config_dir / 'users/owner/favourites.json').write_text('{"saved": ["song"]}')
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
    assert json.loads((restored / 'config/users/owner/favourites.json').read_text()) == {'saved': ['song']}
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
