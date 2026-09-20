"""Loans end with database work, even without a request or a persistent worker."""
import sqlite3
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from shared import request_scope
from shared.database import DatabaseManager


def assert_idle(db):
    stats = db.pool_stats()
    assert stats["idle"] == stats["created"]


def test_500_ephemeral_workers_do_not_consume_slots(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    assert_idle(db)
    errors = []

    def work():
        try:
            db.get_library_revision()
        except BaseException as exc:
            errors.append(exc)

    for _ in range(500):
        worker = threading.Thread(target=work)
        worker.start()
        worker.join(timeout=2)
        assert not worker.is_alive()
        assert_idle(db)
    assert not errors
    assert db.pool_stats()["created"] == 1


@pytest.mark.parametrize("failure", [RuntimeError, KeyboardInterrupt])
def test_exception_rolls_back_and_returns_loan(tmp_path, failure):
    db = DatabaseManager(str(tmp_path / "library.db"))
    with db._get_connection() as conn:
        conn.execute("CREATE TABLE lifecycle (value TEXT)")
    with pytest.raises(failure):
        with db._get_connection() as conn:
            conn.execute("INSERT INTO lifecycle VALUES ('lost')")
            raise failure()
    assert_idle(db)
    with db._get_connection() as conn:
        assert conn.execute("SELECT * FROM lifecycle").fetchall() == []
        conn.execute("INSERT INTO lifecycle VALUES ('kept')")
    with db._get_connection() as conn:
        assert conn.execute("SELECT * FROM lifecycle").fetchall() == [("kept",)]


def test_nested_blocks_and_scopes_do_not_return_active_loan(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    with request_scope.request_scope():
        with db._get_connection() as outer:
            with request_scope.request_scope():
                with db._get_connection() as inner:
                    assert inner is outer
                request_scope.release_resources()
            assert db.pool_stats()["idle"] == 0
            outer.execute("SELECT 1")
        assert_idle(db)
        request_scope.release_resources()
        with db._get_connection() as conn:
            assert conn.execute("SELECT 1").fetchone() == (1,)
    assert db.pool_stats()["created"] == db.pool_stats()["idle"] == 1


def test_request_and_unscoped_worker_have_distinct_active_loans(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    barrier = threading.Barrier(2)

    def work():
        with db._get_connection() as conn:
            barrier.wait(timeout=3)
            barrier.wait(timeout=3)
            return id(conn)

    with ThreadPoolExecutor(max_workers=1) as executor:
        with request_scope.request_scope(), db._get_connection() as conn:
            future = executor.submit(work)
            barrier.wait(timeout=3)
            assert db.pool_stats()["idle"] == 0
            barrier.wait(timeout=3)
            assert future.result(timeout=3) != id(conn)
    assert_idle(db)


def test_failed_pragma_closes_new_connection(tmp_path, monkeypatch):
    db = DatabaseManager(str(tmp_path / "library.db"))
    real_connect = sqlite3.connect
    opened = []

    class BrokenPragma(sqlite3.Connection):
        def execute(self, *args, **kwargs):
            raise KeyboardInterrupt("configuration cancelled")

    def connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs, factory=BrokenPragma)
        opened.append(conn)
        return conn

    monkeypatch.setattr(sqlite3, "connect", connect)
    with pytest.raises(KeyboardInterrupt):
        db._open_connection()
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        opened[0].cursor()


def test_unusable_connection_is_discarded_and_replaced(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    with pytest.raises(sqlite3.ProgrammingError):
        with db._get_connection() as conn:
            conn.close()
    assert db.pool_stats()["created"] == db.pool_stats()["idle"] == 0
    db.get_library_revision()
    assert db.pool_stats()["created"] == db.pool_stats()["idle"] == 1


def test_gevent_workers_and_cancellation_release_loans(tmp_path):
    # Match run.py/container_entrypoint: patch before importing database.
    code = """
from gevent import monkey
monkey.patch_all()
import gevent
from gevent.event import Event
from shared.database import DatabaseManager
import sys
db = DatabaseManager(sys.argv[1])
for _ in range(500):
    gevent.spawn(db.get_library_revision).get(timeout=2)
assert db.pool_stats()["created"] == db.pool_stats()["idle"] == 1
active = set()
def work():
    with db._get_connection() as conn:
        assert id(conn) not in active
        active.add(id(conn))
        gevent.sleep(.01)
        active.remove(id(conn))
jobs = [gevent.spawn(work) for _ in range(40)]
gevent.joinall(jobs, timeout=5, raise_error=True)
assert all(job.ready() for job in jobs)
assert not active
assert db.pool_stats()["created"] == db.pool_stats()["idle"] <= 16
with db._get_connection() as conn:
    conn.execute("CREATE TABLE cancellation (value TEXT)")
entered = Event()
def cancelled():
    with db._get_connection() as conn:
        conn.execute("INSERT INTO cancellation VALUES ('lost')")
        entered.set()
        gevent.sleep(10)
job = gevent.spawn(cancelled)
assert entered.wait(timeout=2)
job.kill(block=True)
assert db.pool_stats()["created"] == db.pool_stats()["idle"]
with db._get_connection() as conn:
    assert conn.execute("SELECT * FROM cancellation").fetchall() == []
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(tmp_path / "gevent.db")],
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_failed_commit_rolls_back_before_reuse(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    with db._get_connection() as conn:
        conn.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        conn.execute(
            "CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) "
            "DEFERRABLE INITIALLY DEFERRED)"
        )
    with pytest.raises(sqlite3.IntegrityError):
        with db._get_connection() as conn:
            conn.execute("INSERT INTO child VALUES (42)")
    assert_idle(db)
    with db._get_connection() as conn:
        assert not conn.in_transaction
        assert conn.execute("SELECT * FROM child").fetchall() == []
        conn.execute("INSERT INTO parent VALUES (42)")
        conn.execute("INSERT INTO child VALUES (42)")


def test_failed_rollback_discards_loan_without_masking_error(tmp_path):
    from shared.database import ConnectionPool

    db = DatabaseManager(str(tmp_path / "library.db"))

    class BrokenRollback:
        in_transaction = True
        closed = False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            raise sqlite3.OperationalError("transaction exit failed")

        def rollback(self):
            raise sqlite3.OperationalError("rollback failed")

        def close(self):
            self.closed = True

    broken = BrokenRollback()
    # Retire the initial warm connection before substituting the failing pool.
    db._pool.discard(db._pool.acquire())
    db._pool = ConnectionPool(lambda: broken, max_size=1)
    with pytest.raises(sqlite3.OperationalError, match="transaction exit failed"):
        with db._get_connection():
            raise RuntimeError("write failed")
    assert broken.closed
    assert db.pool_stats()["created"] == db.pool_stats()["idle"] == 0
    db._pool._factory = db._open_connection
    db.get_library_revision()
    assert db.pool_stats()["created"] == db.pool_stats()["idle"] == 1
