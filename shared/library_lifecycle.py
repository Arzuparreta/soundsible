"""Coordinate canonical references and retirement of managed audio objects.

A cleanup intent is durable before references change. Failure always retains
bytes; a later pass rechecks all canonical libraries before deleting anything.
An account uses a file through a track row or its collection's binding to that
file (`collection_files`), never through a saved song's `lib:` key once
`described-saved-songs` has read the evidence those keys point at.
"""
from contextlib import contextmanager, closing
from functools import wraps
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import threading
import time

from shared.runtime import get_config_dir

log = logging.getLogger(__name__)
_lock = threading.RLock()
_local = threading.local()


class LibraryPersistenceError(RuntimeError):
    def __init__(self, code=None):
        self.code = code or 'library_storage_unavailable'
        self.status = 409 if self.code == 'library_conflict' else 503
        super().__init__('Library changed while saving; try again.' if self.status == 409
                         else 'Could not persist the operation. Check server storage and retry.')


@contextmanager
def coordinated():
    # Same lock order everywhere: process lock, file lock, SQLite transaction.
    # Reentrant because a library mutation calls DatabaseManager.replace_library.
    # The depth is thread-local and non-zero only while this thread holds both.
    if getattr(_local, 'depth', 0):
        _local.depth += 1
        try:
            yield
        finally:
            _local.depth -= 1
        return
    try:
        with _lock:
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
    finally:
        _run_after_release()


def after_release(callback, key=None):
    """Run ``callback`` once this thread leaves its outermost coordinated().

    Every account and the download queue share this lock, so follow-up work
    that can be slow (portable exports, storage provider uploads) must not
    hold it. Callbacks still run on this thread, before the outermost call
    returns. Registering the same ``key`` twice in one hold runs it once.
    """
    if not getattr(_local, 'depth', 0):
        callback()
        return
    pending = _local.__dict__.setdefault('after', {})
    pending.setdefault(key if key is not None else object(), callback)


def _run_after_release():
    pending, _local.after = getattr(_local, 'after', None) or {}, {}
    for callback in pending.values():
        try:
            callback()
        except Exception:
            log.warning('Post-commit follow-up failed', exc_info=True)


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
        conn.execute('CREATE TABLE IF NOT EXISTS audio_cleanup_migrations (name TEXT PRIMARY KEY)')
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


def _record(conn, payload):
    key = payload['key']
    if Path(key).name != key.removeprefix('tracks/') or '..' in Path(key).parts:
        raise ValueError('Unsafe managed audio key')
    target = json.dumps([payload['music_dir'], payload['provider'], key], sort_keys=True)
    conn.execute('INSERT OR REPLACE INTO audio_cleanup VALUES (?, ?)', (target, json.dumps(payload)))


def _payload(track, provider):
    from shared.app_config import get_output_dir
    from shared.path_resolver import track_storage_key
    root = get_output_dir()
    return {'key': track_storage_key(track), 'track_id': track.id, 'file_hash': track.file_hash,
            'format': track.format, 'music_dir': str(Path(root).resolve()) if root else None,
            'provider': provider_identity(provider), 'cover': track.cover_art_key}


@serialized
def retire(track, provider=None):
    with operation_db() as conn:
        _record(conn, _payload(track, provider))


@serialized
def retire_library(db_path):
    """Record an intent for every file a library uses, before the library is removed.

    For an account being deleted. Files another account uses stay, because
    `drain()` checks every remaining library first.
    """
    from types import SimpleNamespace
    with closing(sqlite3.connect(f'{Path(db_path).resolve().as_uri()}?mode=ro', uri=True)) as conn:
        rows = conn.execute('SELECT id, file_hash, format, cover_art_key FROM tracks').fetchall()
    with operation_db() as conn:
        for track_id, file_hash, file_format, cover in rows:
            _record(conn, _payload(SimpleNamespace(id=track_id, file_hash=file_hash, format=file_format,
                                                   cover_art_key=cover), None))
    return len(rows)


class _Retained(Exception):
    """Something this pass cannot read may still use the audio."""


def _has_table(conn, name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _described(conn):
    """The account ran the migration that reads leftover files as evidence."""
    from shared.collection_repair import MIGRATION
    return _has_table(conn, 'collection_migrations') and conn.execute(
        'SELECT 1 FROM collection_migrations WHERE name=?', (MIGRATION,)).fetchone() is not None


def _collection_ready(conn):
    return _has_table(conn, 'collection_state') and conn.execute(
        'SELECT 1 FROM collection_state WHERE singleton=1').fetchone() is not None


def _format(value):
    # Same default as `track_storage_key`.
    return (value or 'mp3').strip('.')


@contextmanager
def _canonical_libraries():
    """Read-only connections to every account library, and ids downloads may still commit.

    Yields `(path, connection)` pairs. Raises `_Retained` when an account, or
    an acquisition in progress, cannot be read: an unreadable library is never
    an empty one.
    """
    root = get_config_dir()
    paths = set((root / 'users').glob('*/library.db'))
    downloads = set()
    instance = root / 'instance.db'
    if instance.exists():
        with closing(sqlite3.connect(f'{instance.resolve().as_uri()}?mode=ro', uri=True)) as conn:
            if _has_table(conn, 'users'):
                # Disabled accounts count as well.
                for (uid,) in conn.execute('SELECT id FROM users'):
                    directory = root / 'users' / uid
                    db = directory / 'library.db'
                    if db.exists():
                        paths.add(db)
                    elif (directory / 'library.json').exists():
                        raise _Retained(f'account {uid} has no library.db yet')
            # An acquisition can be between publishing audio and committing its
            # personal reference. Conservatively postpone cleanup during jobs.
            if _has_table(conn, 'download_jobs'):
                for status, raw in conn.execute(
                        "SELECT status, payload FROM download_jobs WHERE status IN ('pending','downloading','failed')"):
                    result = json.loads(raw).get('result')
                    if not result and status == 'downloading':
                        raise _Retained('a download has not reported its file yet')
                    if result:
                        downloads.update(value for value in (result.get('id'), result.get('file_hash')) if value)
    connections = []
    try:
        for path in sorted(paths):
            conn = sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True)
            connections.append((path, conn))
            try:
                conn.execute('SELECT 1 FROM sqlite_master').fetchone()
            except sqlite3.DatabaseError as error:
                raise _Retained(f'{path} cannot be read: {error}') from error
        yield connections, downloads
    finally:
        for _, conn in connections:
            conn.close()


def _legacy_saved_ids(db_path):
    """File ids an account's `favourites.json` names, read only before its collection exists.

    Until then that file and `playlist_tracks` are the account's live data.
    """
    path = Path(db_path).with_name('favourites.json')
    if not path.exists():
        return set()
    try:
        saved = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise _Retained(f'{path} cannot be read: {error}') from error
    entries = saved.get('saved', saved.get('favourites', [])) if isinstance(saved, dict) else saved
    ids = set()
    for entry in entries if isinstance(entries, list) else []:
        if isinstance(entry, str):
            ids.add(entry)
        elif isinstance(entry, dict):
            ids.update(key[4:] for key in entry.get('keys') or [] if isinstance(key, str) and key.startswith('lib:'))
    return ids


def _file_ids(db_path, conn, evidence=True):
    """File ids this library uses or, with `evidence`, may still need, whatever their format.

    A migrated collection uses a file only through `collection_files`; a saved
    song's `lib:` key is a description. Until `described-saved-songs` has run,
    a `lib:` key is the evidence that migration will read from the file's tags.
    """
    ids = set()
    if _has_table(conn, 'collection_files'):
        ids.update(row[0] for row in conn.execute('SELECT file_id FROM collection_files'))
    if not _collection_ready(conn):
        # Before the collection model a playlist slot held the file id itself.
        ids.update(row[0] for row in conn.execute('SELECT track_id FROM playlist_tracks'))
        ids |= _legacy_saved_ids(db_path)
    elif evidence and not _described(conn):
        ids.update(row[0][4:] for row in conn.execute("SELECT key FROM collection_keys WHERE key LIKE 'lib:%'"))
    return ids


def _holds(db_path, conn, ids, file_format):
    """This library uses the file, or may still need it as evidence (`_file_ids`)."""
    # IDs and hashes are both used by the local path resolver.
    if conn.execute('''SELECT 1 FROM tracks WHERE (id IN (?, ?) OR file_hash IN (?, ?))
            AND COALESCE(format, 'mp3')=? LIMIT 1''', (*ids, *ids, file_format)).fetchone():
        return True
    return not _file_ids(db_path, conn).isdisjoint(ids)


def _referenced(payload):
    ids = (payload['track_id'], payload['file_hash'])
    try:
        with _canonical_libraries() as (libraries, downloads):
            if downloads.intersection(ids):
                return True
            return any(_holds(path, conn, ids, _format(payload['format'])) for path, conn in libraries)
    except _Retained as reason:
        log.debug('Audio cleanup postponed: %s', reason)
        return True


def _forget_pool_entry(payload):
    """Reconcile the portable pool catalog and any live downloader snapshot."""
    import sys
    from shared.models import LibraryMetadata
    from shared.atomic_file import publish, text_pieces
    if not payload['music_dir']:
        return
    root = Path(payload['music_dir'])
    path = root / 'library.json'
    if path.exists():
        metadata = LibraryMetadata.from_json(path.read_text())
        if metadata.remove_track(payload['track_id']):
            publish(path, text_pieces(metadata.iter_json()))
    api = sys.modules.get('shared.api')
    downloader = getattr(api, 'downloader_service', None)
    if downloader is not None and Path(downloader.output_dir).resolve() == root:
        downloader.library.remove_track(payload['track_id'])


@serialized
def drain(provider=None, limit=32):
    """Best effort. Unknown references/storage keep the intent and the bytes."""
    removed = []
    try:
        with operation_db() as conn:
            rows = conn.execute('SELECT target, payload FROM audio_cleanup ORDER BY rowid LIMIT ?', (limit,)).fetchall()
    except Exception:
        log.warning('Audio cleanup store unavailable; intents retained', exc_info=True)
        return removed
    for row in rows:
        try:
            # Rotate every attempted entry, including unreachable providers.
            with operation_db() as conn:
                conn.execute('DELETE FROM audio_cleanup WHERE target=?', (row['target'],))
                conn.execute('INSERT INTO audio_cleanup VALUES (?, ?)', (row['target'], row['payload']))
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
            _forget_pool_entry(payload)
            # Shared artwork is deliberately retained; its existing store owns
            # reference accounting, not this audio cleanup operation.
            with operation_db() as conn:
                conn.execute('DELETE FROM audio_cleanup WHERE target=?', (row['target'],))
            removed.append(payload['track_id'])
        except Exception:
            log.warning('Audio cleanup deferred; keeping retirement intent', exc_info=True)
    return removed


#: Prefix of the `audio_cleanup_migrations` row recorded per music folder.
RECONCILED = 'unreferenced-managed-audio'
_MANAGED_NAME = re.compile(r'([0-9a-f]{64})\.([A-Za-z0-9]{1,16})')
#: A newer file may belong to an acquisition or repair that has not committed
#: its reference yet. Status-change time, because a copy can keep an old mtime.
SETTLED_SECONDS = 24 * 3600


@serialized
def reconcile(now=None):
    """Record a retirement intent for managed audio that no account uses.

    Deleting a track before intents existed (#221) never removed its file, and
    nothing would ever ask for those files again. This pass runs once per music
    folder, once every registered library can be read; until then it does
    nothing and is retried. It applies the same per-library rule as `drain()`,
    which checks every reference again before deleting. Returns the number of
    intents recorded, or None when the pass has to wait.
    """
    from shared.app_config import get_output_dir
    root = get_output_dir()
    if not root:
        return None
    music_dir = str(Path(root).resolve())
    name = f'{RECONCILED}:{music_dir}'
    with operation_db() as conn:
        if conn.execute('SELECT 1 FROM audio_cleanup_migrations WHERE name=?', (name,)).fetchone():
            return 0
        pending = {(payload.get('music_dir'), payload.get('key')) for payload in
                   (json.loads(raw) for (raw,) in conn.execute('SELECT payload FROM audio_cleanup'))}
    held, any_format = set(), set()
    try:
        with _canonical_libraries() as (libraries, downloads):
            any_format |= downloads
            for path, conn in libraries:
                for track_id, file_hash, file_format in conn.execute('SELECT id, file_hash, format FROM tracks'):
                    held.update((value, _format(file_format)) for value in (track_id, file_hash) if value)
                # Evidence gets an intent too: `drain()` keeps it until the
                # account has described its saved songs, then removes it.
                any_format |= _file_ids(path, conn, evidence=False)
    except _Retained as reason:
        log.info('Unreferenced audio reconciliation postponed: %s', reason)
        return None
    cutoff = (time.time() if now is None else now) - SETTLED_SECONDS
    pool = Path(music_dir) / 'tracks'
    found = []
    if pool.is_dir():
        with os.scandir(pool) as entries:
            for entry in entries:
                match = _MANAGED_NAME.fullmatch(entry.name)
                # Never a symlink: it may point at a borrowed external original.
                if not match or entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    continue
                file_id, file_format = match.groups()
                if ((file_id, file_format) in held or file_id in any_format
                        or (music_dir, f'tracks/{entry.name}') in pending
                        or entry.stat(follow_symlinks=False).st_ctime > cutoff):
                    continue
                found.append((file_id, file_format))
    with operation_db() as conn:
        for file_id, file_format in sorted(found):
            _record(conn, {'key': f'tracks/{file_id}.{file_format}', 'track_id': file_id,
                           'file_hash': file_id, 'format': file_format, 'music_dir': music_dir,
                           'provider': None, 'cover': None})
        conn.execute('INSERT INTO audio_cleanup_migrations VALUES (?)', (name,))
    log.info('Recorded %d unreferenced managed audio files in %s for cleanup', len(found), pool)
    return len(found)
