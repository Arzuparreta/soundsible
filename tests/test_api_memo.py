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
