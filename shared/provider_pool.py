"""Bounded provider lanes with a total response deadline.

A slow provider retains only its own bounded slots. Late work releases its own
request-scoped resources and never mutates a response already sent to a client.
"""
from concurrent.futures import ThreadPoolExecutor, wait
from contextvars import copy_context
import threading
import time

from shared.request_scope import request_scope


class ProviderPool:
    def __init__(self, workers=2, capacity=4):
        self._workers = workers
        self._capacity = capacity
        self._lock = threading.Lock()
        self._lanes = {}

    def _submit(self, name, function):
        with self._lock:
            if name not in self._lanes:
                self._lanes[name] = (ThreadPoolExecutor(max_workers=self._workers, thread_name_prefix=f"provider-{name}"), threading.BoundedSemaphore(self._capacity))
            executor, slots = self._lanes[name]
        if not slots.acquire(blocking=False):
            return None
        context = copy_context()

        def run():
            with request_scope():
                started = time.monotonic()
                result = function()
                return result, round((time.monotonic() - started) * 1000, 1)

        try:
            future = executor.submit(context.run, run)
        except Exception:
            slots.release()
            raise
        future.add_done_callback(lambda _: slots.release())
        return future

    def collect(self, providers, *, budget):
        started = time.monotonic()
        futures = {}
        failures = []
        for name, function in providers:
            future = self._submit(name, function)
            if future is None:
                failures.append({"source": name, "error": "Provider busy", "reason": "capacity"})
            else:
                futures[future] = name
        done, pending = wait(futures, timeout=max(0, budget - (time.monotonic() - started)))
        rows, timings = {}, {}
        for future in done:
            name = futures[future]
            try:
                rows[name], timings[name] = future.result()
            except Exception:
                # Remote diagnostics belong in server logs, never in the public
                # response (provider exceptions may include credentials/URLs).
                import logging
                logging.getLogger(__name__).exception("Search provider failed: %s", name)
                failures.append({"source": name, "error": "Provider unavailable", "reason": "failed"})
        for future in pending:
            future.cancel()
            failures.append({"source": futures[future], "error": "Provider exceeded the search deadline", "reason": "deadline"})
        return rows, sorted(failures, key=lambda row: row["source"]), timings

    def shutdown(self):
        with self._lock:
            lanes, self._lanes = self._lanes, {}
        for executor, _ in lanes.values():
            executor.shutdown(wait=False, cancel_futures=True)


search_providers = ProviderPool()
