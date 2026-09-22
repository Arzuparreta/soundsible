"""Coverage for shared.api.memo — the bounded TTL cache + single-flight used by
every expensive yt-dlp path in the API."""

import threading
import time

import pytest

from shared.api.memo import Memo


def test_get_returns_none_after_ttl_expires():
    memo: Memo[str] = Memo(ttl_sec=0.05)
    memo.put("k", "v")
    assert memo.get("k") == "v"
    time.sleep(0.08)
    assert memo.get("k") is None


def test_resolve_computes_once_then_serves_from_cache():
    calls = []
    memo: Memo[str] = Memo(ttl_sec=60)

    def compute():
        calls.append(1)
        return "value"

    assert memo.resolve("k", compute) == "value"
    assert memo.resolve("k", compute) == "value"
    assert len(calls) == 1


def test_concurrent_resolves_share_one_computation():
    """The whole point: while a slow call is in flight the cache still reads as a
    miss, so without single-flight every concurrent caller starts its own."""
    memo: Memo[str] = Memo(ttl_sec=60)
    started = threading.Event()
    release = threading.Event()
    calls = []

    def slow():
        calls.append(1)
        started.set()
        release.wait(5)
        return "shared"

    results: list[str] = []
    threads = [threading.Thread(target=lambda: results.append(memo.resolve("k", slow))) for _ in range(8)]
    threads[0].start()
    assert started.wait(5)
    for thread in threads[1:]:
        thread.start()
    time.sleep(0.05)
    release.set()
    for thread in threads:
        thread.join(5)

    assert len(calls) == 1
    assert results == ["shared"] * 8


def test_failed_resolve_propagates_to_every_waiter_and_is_retryable():
    memo: Memo[str] = Memo(ttl_sec=60)
    started = threading.Event()
    release = threading.Event()

    def boom():
        started.set()
        release.wait(5)
        raise RuntimeError("upstream down")

    errors: list[BaseException] = []

    def call():
        try:
            memo.resolve("k", boom)
        except BaseException as exc:  # noqa: BLE001 — recording for the assert
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(3)]
    threads[0].start()
    assert started.wait(5)
    for thread in threads[1:]:
        thread.start()
    time.sleep(0.05)
    release.set()
    for thread in threads:
        thread.join(5)

    assert len(errors) == 3
    assert all(isinstance(e, RuntimeError) for e in errors)
    # A failure is not cached: the next caller gets a fresh attempt.
    assert memo.resolve("k", lambda: "recovered") == "recovered"


def test_negative_ttl_applies_to_falsy_values_only():
    memo: Memo[str] = Memo(ttl_sec=60, negative_ttl_sec=0.05)
    memo.put("miss", "")
    memo.put("hit", "url")
    time.sleep(0.08)
    assert memo.get("miss") is None
    assert memo.get("hit") == "url"


def test_cache_is_bounded():
    memo: Memo[int] = Memo(ttl_sec=60, maxsize=10)
    for i in range(100):
        memo.put(f"k{i}", i)
    assert len(memo) <= 10
    # The most recent writes survive; the oldest are what got dropped.
    assert memo.get("k99") == 99
    assert memo.get("k0") is None


def test_waiter_times_out_instead_of_blocking_forever():
    memo: Memo[str] = Memo(ttl_sec=60, wait_timeout_sec=0.05)
    started = threading.Event()
    release = threading.Event()

    def hang():
        started.set()
        release.wait(5)
        return "eventually"

    leader = threading.Thread(target=lambda: memo.resolve("k", hang))
    leader.start()
    assert started.wait(5)
    try:
        with pytest.raises(TimeoutError):
            memo.resolve("k", hang)
    finally:
        release.set()
        leader.join(5)


@pytest.mark.parametrize('published', ['ready', '', False, 0])
def test_delayed_miss_rechecks_cache_before_starting_work(published):
    """Pause a caller just before coordination; another request publishes first.

    On the old implementation get() takes the first lock, sees a miss, then
    resolve() takes a second lock to elect a leader. The publishing thread runs
    precisely between them. With atomic lookup/election, publication happens
    before the single critical section instead. No scheduler sleeps are needed.
    """
    memo = Memo(ttl_sec=60, negative_ttl_sec=10)
    real_lock = memo._lock
    get_lock_finished = threading.Event()
    published_ready = threading.Event()
    local = threading.local()
    calls = []

    class CoordinatedLock:
        def __enter__(self):
            # The old get() is distinguishable from resolve() without altering
            # either production method or depending on a particular line number.
            import sys
            caller = sys._getframe(1).f_code.co_name
            if threading.current_thread().name == 'delayed-request':
                if caller != 'get':
                    get_lock_finished.set()
                    assert published_ready.wait(5)
                local.in_get = caller == 'get'
            real_lock.acquire()
            return self

        def __exit__(self, *_):
            real_lock.release()
            if threading.current_thread().name == 'delayed-request' and getattr(local, 'in_get', False):
                local.in_get = False
                get_lock_finished.set()
                assert published_ready.wait(5)

    memo._lock = CoordinatedLock()
    # Use a named thread and a Future so failures propagate to the test.
    from concurrent.futures import Future
    result = Future()

    def delayed():
        try:
            result.set_result(memo.resolve('key', lambda: calls.append('duplicate') or 'duplicate'))
        except BaseException as exc:
            result.set_exception(exc)

    thread = threading.Thread(target=delayed, name='delayed-request')
    thread.start()
    try:
        assert get_lock_finished.wait(5)
        assert memo.resolve('key', lambda: published) == published
    finally:
        published_ready.set()
        thread.join(5)
    assert not thread.is_alive()
    assert result.result(timeout=1) == published
    assert calls == []


def test_independent_keys_do_not_wait_for_another_computation():
    from concurrent.futures import ThreadPoolExecutor

    memo = Memo(ttl_sec=60)
    started = threading.Event()
    release = threading.Event()

    def slow():
        started.set()
        assert release.wait(5)
        return 'slow'

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(memo.resolve, 'slow', slow)
        try:
            assert started.wait(5)
            assert pool.submit(memo.resolve, 'other', lambda: 'other').result(timeout=2) == 'other'
        finally:
            release.set()
        assert first.result(timeout=2) == 'slow'
    assert memo._flights == {}


def test_expired_entry_is_recomputed_under_coordination(monkeypatch):
    import shared.api.memo as module

    now = [100.0]
    monkeypatch.setattr(module.time, 'time', lambda: now[0])
    memo = Memo(ttl_sec=10)
    memo.put('key', 'old')
    now[0] = 110.0
    assert memo.resolve('key', lambda: 'new') == 'new'
    assert memo.get('key') == 'new'
    memo.invalidate('key')
    assert memo.resolve('key', lambda: 'after invalidation') == 'after invalidation'
    memo.clear()
    assert memo.resolve('key', lambda: 'after clear') == 'after clear'


def test_catalog_consumer_keeps_account_isolation_and_copy_on_read():
    from shared.api.routes.catalog import _memo_resolve
    from shared.user_context import user_context

    memo = Memo(ttl_sec=60)
    calls = []

    def compute():
        calls.append(1)
        return {'title': 'Original'}

    with user_context('alice'):
        first, cached = _memo_resolve(memo, 'query', compute)
        assert not cached
        first['title'] = 'Caller mutation'
        second, cached = _memo_resolve(memo, 'query', compute)
        assert cached and second == {'title': 'Original'}
    with user_context('bob'):
        third, cached = _memo_resolve(memo, 'query', compute)
        assert not cached and third == {'title': 'Original'}
    assert len(calls) == 2
