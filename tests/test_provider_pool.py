import threading
import time
from shared.provider_pool import ProviderPool
from shared.request_scope import on_end


def test_slow_provider_does_not_block_fast_results_and_late_work_cleans_up():
    pool = ProviderPool(workers=1, capacity=1)
    release = threading.Event()
    cleaned = threading.Event()
    def slow():
        on_end(cleaned.set)
        release.wait(2)
        return ['late']
    try:
        started = time.monotonic()
        rows, failures, timings = pool.collect([('slow', slow), ('fast', lambda: ['ready'])], budget=0.05)
        assert time.monotonic() - started < 0.5
        assert rows == {'fast': ['ready']}
        assert failures[0]['source'] == 'slow'
        assert failures[0]['reason'] == 'deadline'
        assert 'fast' in timings
        _, busy, _ = pool.collect([('slow', slow)], budget=0.05)
        assert busy[0]['reason'] == 'capacity'
        release.set()
        assert cleaned.wait(1)
        assert rows == {'fast': ['ready']}
    finally:
        release.set()
        pool.shutdown()


def test_failure_does_not_disclose_provider_credentials():
    pool = ProviderPool()
    def fail():
        raise RuntimeError('https://secret:password@example.test')
    try:
        _, failures, _ = pool.collect([('provider', fail)], budget=1)
        assert failures == [{'source': 'provider', 'error': 'Provider unavailable', 'reason': 'failed'}]
    finally:
        pool.shutdown()
