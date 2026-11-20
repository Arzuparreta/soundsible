"""Disposable disk history of public hashes, never retained library bodies."""
from contextlib import contextmanager
from hashlib import sha256
import json
import sqlite3
import time

from shared.runtime import get_cache_dir

MAX_BYTES = 64 * 1024 * 1024
MAX_REVISIONS = 4
TTL = 86400


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()


def digest(value):
    return sha256(encoded(value)).digest()


def _open_write_db(path):
    db = sqlite3.connect(path, timeout=0.1)
    try:
        path.chmod(0o600)
        db.execute('PRAGMA foreign_keys=ON')
        if (db.execute('PRAGMA journal_mode').fetchone() or ('',))[0].lower() != 'wal':
            try:
                db.execute('PRAGMA journal_mode=WAL')
            except sqlite3.OperationalError:
                pass
        db.execute('PRAGMA synchronous=OFF')
        db.execute('PRAGMA cache_size=-512')
        db.execute('PRAGMA temp_store=FILE')
        db.execute('PRAGMA temp.cache_size=-512')
        page_size = db.execute('PRAGMA page_size').fetchone()[0]
        db.execute(f'PRAGMA max_page_count={MAX_BYTES // page_size}')
        if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='incremental_bases'"
        ).fetchone() is None:
            db.executescript('''
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS revisions (
                    id INTEGER PRIMARY KEY, account TEXT, revision TEXT, created REAL, bytes INTEGER,
                    UNIQUE(account, revision));
                CREATE TABLE IF NOT EXISTS rows (
                    revision_id INTEGER REFERENCES revisions(id) ON DELETE CASCADE, position INTEGER, id TEXT, hash BLOB,
                    PRIMARY KEY(revision_id, id));
                CREATE INDEX IF NOT EXISTS rows_order ON rows(revision_id, position);
                CREATE TABLE IF NOT EXISTS headers (
                    revision_id INTEGER REFERENCES revisions(id) ON DELETE CASCADE, name TEXT, hash BLOB,
                    PRIMARY KEY(revision_id, name));
                CREATE TABLE IF NOT EXISTS incremental_bases (
                    account TEXT, revision TEXT, created REAL, proof TEXT,
                    PRIMARY KEY(account, revision));
                COMMIT;
            ''')
        return db
    except BaseException:
        db.close()
        raise


@contextmanager
def connection(*, read_only=False):
    path = get_cache_dir() / 'library-deltas.sqlite3'
    if read_only:
        db = sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True, timeout=0.1)
        try:
            yield db
        finally:
            db.close()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        db = _open_write_db(path)
    except sqlite3.DatabaseError as exc:
        if isinstance(exc, sqlite3.OperationalError):
            raise
        # Disposable cache corrupted (e.g., power loss under synchronous=OFF): recreate cleanly.
        for suffix in ('', '-wal', '-shm'):
            try:
                path.with_name(path.name + suffix).unlink(missing_ok=True)
            except OSError:
                pass
        db = _open_write_db(path)
    try:
        with db:
            yield db
    finally:
        db.close()


def exchange(account, revision, payload, base=None):
    """Compare indexed hashes in batches, then atomically admit/trim history.

    Caller treats every failure as a full-response fallback. Byte quota measures
    retained logical records including conservative index/row overhead; SQLite
    free pages are reused, not vacuumed on the request path.
    """
    if len(account.encode()) > 256 or len(revision) > 128:
        return None
    now = time.time()
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('DELETE FROM revisions WHERE created < ?', (now - TTL,))
        exists = base and db.execute('SELECT id FROM revisions WHERE account=? AND revision=?', (account, base)).fetchone()
        current = db.execute('SELECT id FROM revisions WHERE account=? AND revision=?', (account, revision)).fetchone()
        size = 512 + len(account.encode()) + len(revision) + sum(3 * len(t['id'].encode()) + 160
                         for t in payload['tracks']) + 1024 * len(payload)
        if size > MAX_BYTES:
            return None
        # Compute each hash once into a file-backed temporary table. SQL joins
        # compare revisions without Python maps of the complete old/new library.
        if exists or not current:
            db.execute('CREATE TEMP TABLE current_rows (id TEXT PRIMARY KEY, position INTEGER, hash BLOB)')
            db.executemany('INSERT INTO current_rows VALUES (?, ?, ?)',
                           ((t['id'], i, digest(t)) for i, t in enumerate(payload['tracks'])))
        delta = None
        if exists:
            base_id = exists[0]
            tracks = payload['tracks']
            changed = db.execute('SELECT c.position FROM current_rows c LEFT JOIN rows r '
                                 'ON r.revision_id=? AND r.id=c.id WHERE r.hash IS NULL OR r.hash!=c.hash', (base_id,))
            upserts = []
            while batch := changed.fetchmany(500):
                upserts.extend(tracks[position] for (position,) in batch)
            removed = [row[0] for row in db.execute(
                'SELECT id FROM rows WHERE revision_id=? AND NOT EXISTS '
                '(SELECT 1 FROM current_rows WHERE current_rows.id=rows.id)', (base_id,))]
            old_order = db.execute('SELECT id FROM rows WHERE revision_id=? ORDER BY position', (base_id,))
            changed_order = False
            for track in tracks:
                row = old_order.fetchone()
                if row is None or row[0] != track['id']:
                    changed_order = True
                    break
            if not changed_order:
                changed_order = old_order.fetchone() is not None
            old_order.close()
            old_headers = dict(db.execute('SELECT name, hash FROM headers WHERE revision_id=?', (base_id,)))
            delta = {'kind': 'delta', 'base_revision': base, 'revision': revision,
                     'upserts': upserts, 'removed': removed,
                     'fields': {k: v for k, v in payload.items() if k != 'tracks' and old_headers.get(k) != digest(v)}}
            if changed_order:
                delta['order'] = [t['id'] for t in tracks]

        if not current:
            # Evict before inserting: no transient doubling of retained data.
            while db.execute('SELECT COUNT(*) FROM revisions WHERE account=?', (account,)).fetchone()[0] >= MAX_REVISIONS:
                db.execute('DELETE FROM revisions WHERE rowid=(SELECT rowid FROM revisions WHERE account=? ORDER BY created, rowid LIMIT 1)', (account,))
            while db.execute('SELECT COALESCE(SUM(bytes),0) FROM revisions').fetchone()[0] + size > MAX_BYTES:
                db.execute('DELETE FROM revisions WHERE rowid=(SELECT rowid FROM revisions ORDER BY created, rowid LIMIT 1)')
            current_id = db.execute('INSERT INTO revisions(account, revision, created, bytes) VALUES (?, ?, ?, ?)', (account, revision, now, size)).lastrowid
            db.execute('INSERT INTO rows SELECT ?, position, id, hash FROM current_rows', (current_id,))
            db.executemany('INSERT INTO headers VALUES (?, ?, ?)',
                           ((current_id, k, digest(v)) for k, v in payload.items() if k != 'tracks'))
        db.execute('DELETE FROM revisions WHERE account=? AND revision NOT IN '
                   '(SELECT revision FROM revisions WHERE account=? ORDER BY created DESC, revision DESC LIMIT ?)',
                   (account, account, MAX_REVISIONS))
        while db.execute('SELECT COALESCE(SUM(bytes),0) FROM revisions').fetchone()[0] > MAX_BYTES:
            db.execute('DELETE FROM revisions WHERE rowid=(SELECT rowid FROM revisions ORDER BY created, rowid LIMIT 1)')
        return delta
