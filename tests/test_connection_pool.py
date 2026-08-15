"""`ConnectionPool` in isolation: bounded growth, reuse, and no silent hang.

Written for the incident where `DatabaseManager` cached one SQLite connection
per calling thread forever. Under gevent that "thread" is a fresh greenlet per
request, so the cache never actually reused anything process-wide — it grew
one connection per request, for as long as the process stayed up, until the
pile of open handles started starving reads and writes on the same file.
`ConnectionPool` replaces the unbounded cache; these tests are the contract
that replacement has to hold.
"""

import queue
import threading

import pytest

from shared.database import ConnectionPool


def _counting_factory():
    counts = {"created": 0}

    def factory():
        counts["created"] += 1
        return object()

    return factory, counts


def test_acquire_creates_up_to_max_size_then_reuses():
    factory, counts = _counting_factory()
    pool = ConnectionPool(factory, max_size=3)

    a = pool.acquire()
    b = pool.acquire()
    c = pool.acquire()
    assert counts["created"] == 3

    pool.release(a)
    # A released connection is handed back out instead of growing the pool.
    d = pool.acquire()
    assert d is a
    assert counts["created"] == 3

    pool.release(b)
    pool.release(c)
    pool.release(d)


def test_never_exceeds_max_size_across_many_cycles():
    """The actual leak: unboundedly many borrow/return cycles must not grow
    the live connection count past the cap, no matter how many "requests"
    (acquire+release pairs) the pool serves over its lifetime."""
    factory, counts = _counting_factory()
    pool = ConnectionPool(factory, max_size=4)

    for _ in range(500):
        conn = pool.acquire()
        pool.release(conn)

    assert counts["created"] <= 4


def test_exhausted_pool_raises_instead_of_hanging_forever():
    """The lesson from the incident this pool fixes: a resource limit must
    fail loudly, not block a caller forever. Every slot is checked out and
    never returned, so the next acquire has to give up rather than hang."""
    factory, _ = _counting_factory()
    pool = ConnectionPool(factory, max_size=1)

    import shared.database as database

    original_timeout = database._POOL_ACQUIRE_TIMEOUT_SEC
    database._POOL_ACQUIRE_TIMEOUT_SEC = 0.2
    try:
        held = pool.acquire()
        with pytest.raises(TimeoutError):
            pool.acquire()
    finally:
        database._POOL_ACQUIRE_TIMEOUT_SEC = original_timeout
        pool.release(held)


def test_released_connection_is_available_to_a_different_thread():
    """Connections move between callers via the pool now, not just within one
    thread's cache — this is what `check_same_thread=False` exists for."""
    factory, counts = _counting_factory()
    pool = ConnectionPool(factory, max_size=2)

    conn = pool.acquire()
    pool.release(conn)

    seen = queue.Queue()

    def worker():
        seen.put(pool.acquire())

    t = threading.Thread(target=worker)
    t.start()
    t.join(timeout=2)

    assert seen.get_nowait() is conn
    assert counts["created"] == 1
