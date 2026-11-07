"""Disposable disk-only artwork variants with cross-process quota admission."""
from contextlib import contextmanager
from dataclasses import dataclass
import logging
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import threading
import time

log = logging.getLogger(__name__)
DEFAULT_LIMIT = 512 * 1024 * 1024
NAME = re.compile(r'[0-9a-f]{64}-(160|320|640|960|1280)-(square|original)-[a-zA-Z0-9_-]+\.jpg\Z')


class VariantDeadline(OSError):
    pass


def checkpoint(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise VariantDeadline('Artwork cache deadline exceeded')


@dataclass
class Variant:
    file: object
    size: int
    modified: float
    etag: str


class VariantCache:
    def __init__(self, root, originals):
        self.root = Path(root)
        self.lock = threading.Lock()
        self.ready = False
        # Only names and deadlines, never image bytes. The index stamp makes
        # another process's admission, eviction or interrupted write a miss.
        self._recent = {}
        self._stamp = None
        self.limit = DEFAULT_LIMIT
        raw = os.getenv('SOUNDSIBLE_ARTWORK_CACHE_MB', '512')
        try:
            value = int(raw)
            if value < 0:
                raise ValueError()
            self.limit = value * 1024 * 1024
        except ValueError:
            log.warning('Invalid SOUNDSIBLE_ARTWORK_CACHE_MB; using 512 MiB')
        cache, source = self.root.resolve(), Path(originals).resolve()
        self.safe = not (cache == source or cache in source.parents or source in cache.parents)
        if not self.safe:
            self.limit = 0
            log.warning('Artwork cache overlaps originals; retention disabled')

    @contextmanager
    def coordinated(self, deadline=None):
        deadline = deadline if deadline is not None else time.monotonic() + 30
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ('.quota.lock', 'variants.sqlite3', 'variants.sqlite3-journal'):
            if (self.root / name).is_symlink():
                raise OSError('Symlink in artwork cache bookkeeping')
        if not self.lock.acquire(timeout=max(0, deadline - time.monotonic())):
            raise VariantDeadline('Artwork cache lock deadline exceeded')
        try:
            with self._file_lock(deadline):
                yield
        finally:
            self.lock.release()

    @contextmanager
    def _file_lock(self, deadline):
        with open(self.root / '.quota.lock', 'a+b') as handle:
            handle.seek(0, 2)
            if not handle.tell():
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            while True:
                checkpoint(deadline)
                try:
                    if os.name == 'nt':
                        import msvcrt
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as exc:
                    import errno
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    time.sleep(min(.01, max(0, deadline - time.monotonic())))
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _connect_index(self):
        path = self.root / 'variants.sqlite3'
        # The quota lease serializes cooperating writers. Never let SQLite's
        # native busy handler sleep inside the gevent hub on an external writer.
        db = sqlite3.connect(path, timeout=0)
        try:
            db.execute('PRAGMA cache_size=-512')
            try:
                if self.ready:
                    db.execute('SELECT dirty FROM state').fetchone()
                    return db
            except sqlite3.OperationalError as exc:
                if 'no such table' not in str(exc):
                    raise
            db.executescript("""
                CREATE TABLE IF NOT EXISTS variants(name TEXT PRIMARY KEY, bytes INTEGER, used REAL);
                CREATE INDEX IF NOT EXISTS variants_lru ON variants(used,name);
                CREATE TABLE IF NOT EXISTS state(singleton INTEGER PRIMARY KEY,bytes INTEGER,dirty INTEGER);
                INSERT OR IGNORE INTO state VALUES(1,0,1);
            """)
            return db
        except BaseException:
            db.close()
            raise

    @contextmanager
    def index(self, deadline=None):
        clean = False
        try:
            checkpoint(deadline)
            db = self._connect_index()
        except sqlite3.DatabaseError as exc:
            if getattr(exc, 'sqlite_errorcode', None) not in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB):
                raise
            # This disposable index uses rollback journals, never WAL. All
            # users hold the directory lock and close connections before release.
            self.ready = False
            (self.root / 'variants.sqlite3').unlink(missing_ok=True)
            (self.root / 'variants.sqlite3-journal').unlink(missing_ok=True)
            db = self._connect_index()
        try:
            db.set_progress_handler(lambda: int(deadline is not None and time.monotonic() >= deadline), 1000)
            if not self.ready or db.execute('SELECT dirty FROM state').fetchone()[0]:
                db.execute('UPDATE state SET dirty=1')
                db.commit()
                db.execute('PRAGMA temp_store=FILE')
                db.execute('PRAGMA temp.cache_size=-512')
                db.execute('CREATE TEMP TABLE seen(name TEXT PRIMARY KEY)')
                total = 0
                with os.scandir(self.root) as entries:
                    for count, entry in enumerate(entries):
                        checkpoint(deadline)
                        if count % 100 == 0:
                            time.sleep(0)
                        if entry.is_symlink():
                            continue
                        if NAME.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                            stat = entry.stat(follow_symlinks=False)
                            db.execute('INSERT INTO variants VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes',
                                       (entry.name, stat.st_size, stat.st_mtime))
                            db.execute('INSERT INTO seen VALUES(?)', (entry.name,))
                            total += stat.st_size
                        elif re.fullmatch(r'\.variant-[a-z0-9_]{8}', entry.name) and entry.is_file(follow_symlinks=False):
                            # Publication staging only exists while holding the
                            # same cross-process lock; these are crash leftovers.
                            Path(entry.path).unlink(missing_ok=True)
                db.execute('DELETE FROM variants WHERE name NOT IN (SELECT name FROM seen)')
                db.execute('DROP TABLE seen')
                db.execute('UPDATE state SET bytes=?,dirty=0', (total,))
                db.commit()
                self.ready = True
            yield db
            total, dirty = db.execute('SELECT bytes,dirty FROM state').fetchone()
            clean = self.ready and not dirty and total <= self.limit
        finally:
            db.close()
            self._stamp = self._index_stamp() if clean else None

    def _index_stamp(self):
        try:
            if (self.root / '.quota.lock').is_symlink() or os.path.lexists(self.root / 'variants.sqlite3-journal'):
                return None
            info = (self.root / 'variants.sqlite3').lstat()
            if not stat.S_ISREG(info.st_mode):
                return None
            return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, self.limit
        except OSError:
            return None

    def _recent_hit(self, name):
        if not self.ready or self.limit <= 0 or self._recent.get(name, 0) <= time.monotonic():
            return None
        if self._stamp is None or self._stamp != self._index_stamp():
            return None
        path = self.root / name
        if path.is_symlink():
            return None
        try:
            handle = open(path, 'rb')
        except OSError:
            return None
        try:
            info = os.fstat(handle.fileno())
        except BaseException:
            handle.close()
            raise
        return Variant(handle, info.st_size, info.st_mtime, name)

    def evict(self, db, incoming=0, *, deadline=None):
        checkpoint(deadline)
        total = db.execute('SELECT bytes FROM state').fetchone()[0]
        if total + incoming <= self.limit:
            return True
        target = max(incoming, int(self.limit * .9)) - incoming
        db.execute('UPDATE state SET dirty=1')
        db.commit()
        # Iterate via indexed keyset pages. Failed unlinks advance too.
        last = (-1.0, '')
        while total > target:
            checkpoint(deadline)
            time.sleep(0)
            rows = db.execute('SELECT name,bytes,used FROM variants WHERE (used,name)>(?,?) '
                              'ORDER BY used,name LIMIT 100', last).fetchall()
            if not rows:
                break
            for name, size, used in rows:
                last = (used, name)
                if not NAME.fullmatch(name) or (self.root / name).is_symlink():
                    continue
                try:
                    (self.root / name).unlink(missing_ok=True)
                except OSError:
                    continue
                db.execute('DELETE FROM variants WHERE name=?', (name,))
                total -= size
                if total <= target:
                    break
        db.execute('UPDATE state SET bytes=?,dirty=0', (total,))
        db.commit()
        return total + incoming <= self.limit

    def hit(self, db, name):
        path = self.root / name
        if path.is_symlink():
            return None
        try:
            handle = open(path, 'rb')
        except FileNotFoundError:
            row = db.execute('SELECT bytes FROM variants WHERE name=?', (name,)).fetchone()
            if row:
                db.execute('DELETE FROM variants WHERE name=?', (name,))
                db.execute('UPDATE state SET bytes=bytes-?', (row[0],))
                db.commit()
            return None
        try:
            stat = os.fstat(handle.fileno())
            now = time.time()
            db.execute('UPDATE variants SET used=? WHERE name=? AND used<=?', (now, name, now - 60))
            db.commit()
            row = db.execute('SELECT used FROM variants WHERE name=?', (name,)).fetchone()
            if row is not None:
                self._recent[name] = time.monotonic() + max(0, min(60, row[0] + 60 - now))
                if len(self._recent) > 256:
                    self._recent.pop(next(iter(self._recent)))
            return Variant(handle, stat.st_size, stat.st_mtime, name)
        except BaseException:
            handle.close()
            raise

    def open(self, name, generate, *, deadline=None):
        deadline = deadline if deadline is not None else time.monotonic() + 30
        checkpoint(deadline)
        if not NAME.fullmatch(name):
            raise ValueError('Invalid variant filename')
        if self.safe:
            try:
                found = self._recent_hit(name)
                if found:
                    return found
                with self.coordinated(deadline), self.index(deadline) as db:
                    self.evict(db, deadline=deadline)
                    if self.limit:
                        found = self.hit(db, name)
                        if found:
                            return found
            except VariantDeadline:
                raise
            except (OSError, sqlite3.Error):
                checkpoint(deadline)
                self.ready = False
                log.warning('Artwork variant index unavailable; serving temporary image', exc_info=True)
        # TemporaryFile is anonymous/delete-on-close; never retained in RAM.
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryFile(dir=self.root)
        try:
            checkpoint(deadline)
            generate(temporary)
            checkpoint(deadline)
            size = temporary.tell()
            temporary.seek(0)
            if self.safe and 0 < size <= self.limit:
                try:
                    with self.coordinated(deadline), self.index(deadline) as db:
                        found = self.hit(db, name)
                        if found:
                            temporary.close()
                            return found
                        if not (self.root / name).is_symlink() and self.evict(db, size, deadline=deadline):
                            db.execute('UPDATE state SET dirty=1')
                            db.commit()
                            fd, staging = tempfile.mkstemp(prefix='.variant-', dir=self.root)
                            try:
                                with os.fdopen(fd, 'wb') as output:
                                    import shutil
                                    shutil.copyfileobj(temporary, output, length=64 * 1024)
                                    output.flush()
                                    os.fsync(output.fileno())
                                checkpoint(deadline)
                                os.replace(staging, self.root / name)
                            finally:
                                Path(staging).unlink(missing_ok=True)
                            db.execute('INSERT INTO variants VALUES(?,?,?)', (name, size, time.time()))
                            db.execute('UPDATE state SET bytes=bytes+?,dirty=0', (size,))
                            db.commit()
                            found = self.hit(db, name)
                            if found:
                                temporary.close()
                                return found
                except VariantDeadline:
                    raise
                except (OSError, sqlite3.Error):
                    checkpoint(deadline)
                    self.ready = False
                    log.warning('Artwork variant admission failed; serving temporary image', exc_info=True)
            temporary.seek(0)
            return Variant(temporary, size, os.fstat(temporary.fileno()).st_mtime, name)
        except BaseException:
            temporary.close()
            raise
