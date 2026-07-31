"""Opening a database must not be a write.

Every HTTP request builds a `DatabaseManager` (see `instance_db`, called from
`_bind_request_user`). Schema setup used to run on each of those constructions,
and because it recreates the FTS5 triggers it took a write lock every time — so
two overlapping requests raced, and the loser surfaced as a 500 with
``sqlite3.OperationalError: database is locked``.

These tests pin the two properties that keep that from coming back: reopening a
database performs no DDL, and concurrent writers queue instead of failing.
"""

import sqlite3
import threading

import pytest

from shared.database import DatabaseManager


def _schema_version(path) -> int:
    conn = sqlite3.connect(path)
    try:
        return int(conn.execute("PRAGMA schema_version").fetchone()[0])
    finally:
        conn.close()


def test_reopening_a_database_performs_no_schema_writes(tmp_path):
    path = tmp_path / "library.db"
    DatabaseManager(str(path))

    before = _schema_version(path)
    for _ in range(25):
        DatabaseManager(str(path))

    # Any DDL — including the DROP/CREATE TRIGGER pairs — bumps schema_version.
    assert _schema_version(path) == before


def test_reopening_a_database_does_not_touch_stored_rows(tmp_path):
    path = tmp_path / "library.db"
    DatabaseManager(str(path))
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO tracks (id, title, artist, format, local_path) VALUES (?, ?, ?, ?, ?)",
        ("t1", "Title", "Artist", "mp3", "/music/tracks/t1.mp3"),
    )
    conn.commit()
    conn.close()

    DatabaseManager(str(path))

    conn = sqlite3.connect(path)
    try:
        stored = conn.execute("SELECT local_path FROM tracks WHERE id = 't1'").fetchone()[0]
    finally:
        conn.close()
    assert stored == "/music/tracks/t1.mp3"


def test_schema_is_reconciled_when_the_file_changes_underneath(tmp_path):
    """A cached "already initialized" verdict must not outlive the schema it saw."""
    path = tmp_path / "legacy.db"
    DatabaseManager(str(path))

    conn = sqlite3.connect(path)
    conn.execute("ALTER TABLE tracks DROP COLUMN youtube_id")
    conn.commit()
    conn.close()

    DatabaseManager(str(path))

    conn = sqlite3.connect(path)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(tracks)")}
    finally:
        conn.close()
    assert "youtube_id" in columns


def test_one_shared_manager_serves_many_threads(tmp_path):
    """`instance_db()` hands the same manager to every caller.

    Its connections are thread-local, so eight threads driving one manager must
    each get their own — sharing a sqlite3 connection across threads raises
    ProgrammingError, and reopening per call is the cost this replaced.
    """
    path = tmp_path / "shared.db"
    manager = DatabaseManager(str(path))
    failures: list[BaseException] = []
    connections: set[int] = set()
    connections_lock = threading.Lock()

    def worker(n: int) -> None:
        try:
            for i in range(20):
                manager.set_related_mix(f"vid{n}_{i}", [{"id": "x", "title": "T"}])
                assert manager.get_related_mix(f"vid{n}_{i}") is not None
            with connections_lock:
                connections.add(id(manager._get_connection()))
        except BaseException as exc:  # noqa: BLE001 — the assertion reports it
            failures.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not failures, f"{len(failures)} worker(s) failed, first: {failures[0]!r}"
    assert len(connections) == 8, "each thread must hold its own connection"


def test_repeated_calls_on_one_thread_reuse_a_single_connection(tmp_path):
    manager = DatabaseManager(str(tmp_path / "reuse.db"))

    first = manager._get_connection()
    for i in range(10):
        manager.set_related_mix(f"vid{i}", [{"id": "x", "title": "T"}])

    assert manager._get_connection() is first


def test_concurrent_writers_do_not_hit_database_is_locked(tmp_path):
    path = tmp_path / "instance.db"
    DatabaseManager(str(path))
    failures: list[BaseException] = []

    def worker(n: int) -> None:
        try:
            for i in range(20):
                db = DatabaseManager(str(path))
                db.set_related_mix(f"vid{n}_{i}", [{"id": "x", "title": "T"}])
                db.get_related_mix(f"vid{n}_{i}")
        except BaseException as exc:  # noqa: BLE001 — the assertion reports it
            failures.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not failures, f"{len(failures)} writer(s) failed, first: {failures[0]!r}"
