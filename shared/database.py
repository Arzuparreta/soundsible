"""
SQLite Database Manager for Soundsible.
Handles canonical library storage, rapid searching, and derived catalog data.
"""

import sqlite3
import logging
import queue
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Optional
from uuid import uuid4
from shared.runtime import get_config_dir

from shared.db.schema import (  # noqa: F401  # re-exported for callers of shared.database
    RETIRED_TABLES,
    RETIRED_TRACK_COLUMNS,
    _SCHEMA_READY,
    SchemaMixin,
)
from shared.db.library import LibraryStore, StaleLibraryWrite  # noqa: F401  # re-exported
from shared.db.catalog import CatalogQueries
from shared.db.user_state import TrackUserState
from shared.db.discovery import DiscoveryStore
from shared.db.discovery_graph import DiscoveryGraphStore
from shared.db.media_cache import MediaCache
from shared.db.lyrics import LyricsStore
from shared.db.accounts import AccountStore
from shared.db.pairing import PairingStore
from shared.db.tv_auth import TvAuthStore

logger = logging.getLogger(__name__)

# How long a writer waits for a competing write lock before giving up. Every
# request builds a DatabaseManager (see `instance_db`), so brief overlap between
# a request and a background cache write is normal rather than exceptional.
BUSY_TIMEOUT_MS = 10_000

#: One `DatabaseManager` per database file, shared process-wide. See
#: :func:`_manager_for`.
_MANAGERS: dict[str, "DatabaseManager"] = {}
_MANAGERS_LOCK = threading.Lock()

# The engine keeps two SQLite files. `instance.db` holds everything that belongs
# to the machine — accounts, credentials, pairing, and the content-addressed
# caches every user benefits from. `users/<id>/library.db` holds one person's
# track index. Both files carry the full schema so an older single-user
# `library.db` keeps working untouched while its instance rows are migrated out.
INSTANCE_DB_FILENAME = "instance.db"
USER_DB_FILENAME = "library.db"

# Tables that live in `instance.db` and get copied out of a pre-multiuser
# `library.db` on first boot (see shared/multiuser_migration.py).
INSTANCE_TABLES = (
    "users",
    "invites",
    "auth_tokens",
    "agent_tokens",
    "subsonic_credentials",
    "pairing_sessions",
    "tv_auth_requests",
    "youtube_resolution_cache",
    "related_mix_cache",
    "stream_url_cache",
    "track_lyrics",
    "artist_graph_nodes",
    "artist_similarity_edges",
    "artist_releases_cache",
    "artist_discography_snapshots",
)


#: Hard ceiling on live connections per `DatabaseManager` (there are only two
#: files: instance.db and one library.db per user). Not a concurrency target —
#: this app serves a handful of people at once — it exists so a burst of
#: requests recycles a bounded set of warm connections instead of growing one
#: forever, which is the failure this pool replaces (see `ConnectionPool`).
_POOL_MAX_SIZE = 16
#: If every pooled connection is checked out this long, fail loudly rather
#: than hang — the same instinct as the SQLite `busy_timeout` above, applied
#: to the pool itself so an exhausted pool cannot reproduce the "buffering
#: forever" symptom it exists to prevent.
_POOL_ACQUIRE_TIMEOUT_SEC = BUSY_TIMEOUT_MS / 1000


class ConnectionPool:
    """A hard-capped pool of warm SQLite connections.

    Connections belong to active database blocks, not to threads or requests.
    A caller returns its loan after commit/rollback, including outside HTTP.
    """

    def __init__(self, factory, max_size: int):
        self._factory = factory
        self._max_size = max_size
        self._idle: "queue.LifoQueue" = queue.LifoQueue()
        self._created = 0
        self._available = threading.Condition()

    def acquire(self):
        deadline = time.monotonic() + _POOL_ACQUIRE_TIMEOUT_SEC
        with self._available:
            while True:
                try:
                    return self._idle.get_nowait()
                except queue.Empty:
                    pass
                if self._created < self._max_size:
                    self._created += 1
                    try:
                        return self._factory()
                    except BaseException:
                        self._created -= 1
                        self._available.notify()
                        raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        f"Database connection pool exhausted ({self._max_size} in use)"
                    )
                self._available.wait(remaining)

    def release(self, conn) -> None:
        with self._available:
            self._idle.put(conn)
            self._available.notify()

    def discard(self, conn) -> None:
        """Retire an unusable connection and wake a waiter to replace it."""
        try:
            conn.close()
        finally:
            with self._available:
                self._created -= 1
                self._available.notify()

    def stats(self) -> dict:
        """Point-in-time view for `/api/health`: how close this pool is to
        exhaustion. `created == max_size and idle == 0` means the next
        `acquire()` blocks for `_POOL_ACQUIRE_TIMEOUT_SEC` and then raises."""
        return {
            "created": self._created,
            "idle": self._idle.qsize(),
            "max_size": self._max_size,
        }
class _DatabaseConnection(sqlite3.Connection):
    @property
    def read_stamp(self):
        """Connection-scoped cache key that observes local and external commits."""
        if not hasattr(self, '_read_identity'):
            self._read_identity = uuid4().hex
        return self._read_identity, self.total_changes, self.execute('PRAGMA data_version').fetchone()[0]


class DatabaseManager(
    SchemaMixin,
    LibraryStore,
    CatalogQueries,
    TrackUserState,
    DiscoveryStore,
    DiscoveryGraphStore,
    MediaCache,
    LyricsStore,
    AccountStore,
    PairingStore,
    TvAuthStore,
):
    """One SQLite database file: a user's library index or the instance database.

    Each area of the schema is a mixin in `shared/db/`; this class owns the file, its
    connection pool and the schema bootstrap.
    """

    def __init__(self, db_path: Optional[str] = None):
        """Open a database. With no path this is the bound user's library index;
        use :func:`instance_db` for accounts, credentials, and shared caches."""
        if db_path is None:
            from shared.user_context import user_config_dir

            self.db_path = user_config_dir() / USER_DB_FILENAME
        else:
            self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # Only an active nested database block keeps a local loan. With the
        # engine's early gevent patch this local belongs to a greenlet; without
        # the patch it belongs to a native thread.
        self._connections = threading.local()
        self._pool = ConnectionPool(self._open_connection, _POOL_MAX_SIZE)

        self._init_db()

    def _open_connection(self):
        conn = sqlite3.connect(self.db_path, timeout=BUSY_TIMEOUT_MS / 1000, check_same_thread=False,
                               factory=_DatabaseConnection)
        try:
            # busy_timeout first: switching journal mode can need a write lock.
            conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
            try:
                conn.execute("PRAGMA journal_mode=WAL")
            except sqlite3.OperationalError:
                logger.debug("Could not set WAL on %s; already set by another connection", self.db_path)
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
        except BaseException:
            conn.close()
            raise
        return conn

    def pool_stats(self) -> dict:
        """See `ConnectionPool.stats` — used by `/api/health` to detect a
        connection leak before it hits every request as a `TimeoutError`."""
        return self._pool.stats()

    @contextmanager
    def _get_connection(self):
        """Borrow for a database block, returning only after commit/rollback.

        Nested blocks reuse the active loan and retain sqlite3's existing
        transaction-context semantics (they are not savepoints). Only the
        outer block returns the connection. No request scope is required.
        """
        existing = getattr(self._connections, "conn", None)
        if existing is not None:
            with existing:
                yield existing
            return

        conn = self._pool.acquire()
        self._connections.conn = conn
        try:
            with conn:
                yield conn
        finally:
            del self._connections.conn
            try:
                # sqlite3 normally leaves no transaction here. A failed
                # commit/rollback must never pass dirty state to another job.
                if conn.in_transaction:
                    conn.rollback()
                if conn.in_transaction:
                    raise sqlite3.OperationalError("connection still has an open transaction")
            except BaseException:
                try:
                    self._pool.discard(conn)
                except BaseException:
                    logger.exception("Could not close discarded SQLite connection")
            else:
                self._pool.release(conn)

    def get_stats(self) -> Dict[str, int]:
        """Track counts in one pass.

        `is_local` is unindexed, so separate COUNT(*) queries would each be a
        full scan — on a liveness probe that the desktop shell and the player
        poll continuously.
        """
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(is_local = 1), 0) FROM tracks"
            ).fetchone()
            return {"tracks": row[0], "local": row[1]}

    def clear_all(self):
        """Wipe all data from the local database."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("DELETE FROM track_artists")
                conn.execute("DELETE FROM collection_files")
                conn.execute("DELETE FROM collection_user_state")
                conn.execute("DELETE FROM track_user_state")
                conn.execute("DELETE FROM tracks")
                conn.execute("DELETE FROM albums")
                conn.execute("DELETE FROM artists")
                conn.execute("DELETE FROM library_info")
                conn.execute("DELETE FROM library_tracks")
                conn.execute("DELETE FROM playlist_tracks")
                conn.execute("DELETE FROM playlists")
                conn.execute("DELETE FROM library_state")
                # Note: FTS5 table cleanup
                try:
                    conn.execute("DELETE FROM tracks_fts")
                except sqlite3.OperationalError:
                    pass
                conn.execute("COMMIT")
                conn.execute("VACUUM")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e


def _manager_for(db_path: Path) -> DatabaseManager:
    """A shared manager for ``db_path``, built once per path per process.

    These factories are called from ~57 sites, several of them on the path that
    resolves the caller of every request. Building a manager reconciles the
    schema, so handing back the same one turns that from per-call work into
    per-process work. Managers hold no per-request state; their connections are
    thread-local.
    """
    key = str(db_path)
    cached = _MANAGERS.get(key)
    if cached is not None:
        return cached
    with _MANAGERS_LOCK:
        cached = _MANAGERS.get(key)
        if cached is None:
            cached = DatabaseManager(key)
            _MANAGERS[key] = cached
        return cached


def reset_database_managers() -> None:
    """Drop every cached manager. Tests use this when they swap runtime dirs."""
    with _MANAGERS_LOCK:
        _MANAGERS.clear()
    _SCHEMA_READY.clear()


def instance_db() -> DatabaseManager:
    """Database holding accounts, credentials, pairing, and shared caches."""
    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    return _manager_for(config_dir / INSTANCE_DB_FILENAME)


def user_db(user_id: Optional[str] = None) -> DatabaseManager:
    """Track index for ``user_id`` (default: the bound user)."""
    from shared.user_context import user_config_dir

    return _manager_for(user_config_dir(user_id) / USER_DB_FILENAME)
