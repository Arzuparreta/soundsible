"""Coordinate canonical references and retirement of managed audio objects.

A cleanup intent is durable before references change. Failure always retains
bytes; a later pass rechecks all canonical libraries before deleting anything.
"""
from contextlib import contextmanager
from functools import wraps
import json
import logging
import os
from pathlib import Path
import sqlite3
import threading

from shared.runtime import get_config_dir

log = logging.getLogger(__name__)
_lock = threading.RLock()
_local = threading.local()


@contextmanager
def coordinated():
    # Same lock order everywhere: process lock, file lock, SQLite transaction.
    # Reentrant because a library mutation calls DatabaseManager.replace_library.
    with _lock:
        if getattr(_local, 'depth', 0):
            _local.depth += 1
            try:
                yield
            finally:
                _local.depth -= 1
            return
        path = get_config_dir() / '.library-lifecycle.lock'
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a+b') as handle:
            handle.seek(0, 2)
            if not handle.tell():
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            _local.depth = 1
            try:
                yield
            finally:
                _local.depth = 0
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def serialized(func):
    @wraps(func)
    def call(*args, **kwargs):
        with coordinated():
            return func(*args, **kwargs)
    return call


@contextmanager
def operation_db(path=None):
    target = Path(path) if path else get_config_dir() / 'instance.db'
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('PRAGMA synchronous=FULL')
        conn.execute('''CREATE TABLE IF NOT EXISTS audio_cleanup (
            target TEXT PRIMARY KEY, payload TEXT NOT NULL)''')
        conn.commit()
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def provider_identity(provider):
    if provider is None:
        return None
    # No credentials in the journal. Changing storage must not delete from the
    # new destination using an intent created against the old one.
    return {key: str(getattr(provider, key, '') or '') for key in
            ('base_path', 'bucket_name', 'endpoint_url') } | {
                'type': type(provider).__name__,
                'remote': str(getattr(getattr(getattr(provider, 's3_client', None), 'meta', None), 'endpoint_url', '') or '')}


@serialized
def retire(track, provider=None):
    from shared.app_config import get_output_dir
    from shared.path_resolver import track_storage_key
    key = track_storage_key(track)
    if Path(key).name != key.removeprefix('tracks/') or '..' in Path(key).parts:
        raise ValueError('Unsafe managed audio key')
    root = get_output_dir()
    payload = {'key': key, 'track_id': track.id, 'file_hash': track.file_hash,
               'format': track.format, 'music_dir': str(Path(root).resolve()) if root else None,
               'provider': provider_identity(provider), 'cover': track.cover_art_key}
    target = json.dumps([payload['music_dir'], payload['provider'], key], sort_keys=True)
    with operation_db() as conn:
        conn.execute('INSERT OR REPLACE INTO audio_cleanup VALUES (?, ?)',
                     (target, json.dumps(payload)))


def _referenced(payload):
    root = get_config_dir()
    paths = set((root / 'users').glob('*/library.db'))
    # A registered account with an unreadable/missing legacy library must never
    # be interpreted as an empty library. Include disabled accounts as well.
    instance = root / 'instance.db'
    if instance.exists():
        with sqlite3.connect(f'{instance.as_uri()}?mode=ro', uri=True) as conn:
            if conn.execute("SELECT 1 FROM sqlite_master WHERE name='users'").fetchone():
                for (uid,) in conn.execute('SELECT id FROM users'):
                    directory = root / 'users' / uid
                    db = directory / 'library.db'
                    if db.exists():
                        paths.add(db)
                    elif (directory / 'library.json').exists():
                        return True
            # An acquisition can be between publishing audio and committing its
            # personal reference. Conservatively postpone cleanup during jobs.
            if conn.execute("SELECT 1 FROM sqlite_master WHERE name='download_jobs'").fetchone():
                if conn.execute("SELECT 1 FROM download_jobs WHERE status IN ('pending','downloading','failed') LIMIT 1").fetchone():
                    return True
    for path in paths:
        with sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True) as conn:
            # IDs and hashes are both used by the local path resolver.
            if conn.execute('''SELECT 1 FROM tracks WHERE
                (id IN (?, ?) OR file_hash IN (?, ?)) AND format=? LIMIT 1''',
                (payload['track_id'], payload['file_hash'], payload['track_id'],
                 payload['file_hash'], payload['format'])).fetchone():
                return True
    return False


@serialized
def drain(provider=None, limit=32):
    """Best effort. Unknown references/storage keep the intent and the bytes."""
    removed = []
    with operation_db() as conn:
        rows = conn.execute('SELECT target, payload FROM audio_cleanup LIMIT ?', (limit,)).fetchall()
    for row in rows:
        try:
            payload = json.loads(row['payload'])
            if _referenced(payload):
                continue
            if payload['provider'] and payload['provider'] != provider_identity(provider):
                continue
            key = payload['key']
            if payload['provider']:
                if provider.file_exists(key) and not provider.delete_file(key):
                    continue
            if payload['music_dir']:
                pool = Path(payload['music_dir']).resolve() / 'tracks'
                path = pool / Path(key).name
                # Never follow a pool symlink to a borrowed external original.
                if path.exists() and path.resolve().parent == pool.resolve():
                    path.unlink()
            # Shared artwork is deliberately retained; its existing store owns
            # reference accounting, not this audio cleanup operation.
            with operation_db() as conn:
                conn.execute('DELETE FROM audio_cleanup WHERE target=?', (row['target'],))
            removed.append(payload['track_id'])
        except Exception:
            log.warning('Audio cleanup deferred; keeping retirement intent', exc_info=True)
    return removed
