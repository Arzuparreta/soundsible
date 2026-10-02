"""One coalescing export worker; SQLite commits never wait on cloud storage.

Exports are derived artifacts. Each job reads the newest committed snapshot
under the manager's export lock, so a queued old job cannot restore old JSON.
Boot and explicit sync also regenerate exports after a crash or export failure.
"""
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import logging
import threading

from shared.request_scope import request_scope

_logger = logging.getLogger(__name__)
_lock = threading.RLock()
_executor = None
_pending = {}
_futures = set()


def schedule_export(manager):
    global _executor
    key = str(manager.db.db_path)
    with _lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="library-export")
        already_pending = key in _pending
        _pending[key] = manager
        if already_pending:
            return
        context = copy_context()
        future = _executor.submit(context.run, _drain, key)
        _futures.add(future)
        future.add_done_callback(_forget)


def _forget(future):
    with _lock:
        _futures.discard(future)


def _drain(key):
    while True:
        with _lock:
            manager = _pending[key]
            _pending[key] = None
        try:
            with request_scope():
                manager.export_committed_library()
        except Exception:
            _logger.exception("Library export failed; SQLite remains canonical: %s", key)
        with _lock:
            if _pending[key] is None:
                del _pending[key]
                return


def flush_exports():
    """Join pending exports; used by orderly shutdown and isolated tests."""
    while True:
        with _lock:
            futures = list(_futures)
            _futures.clear()
        if not futures:
            return
        for future in futures:
            future.result()


def stop_exports():
    global _executor
    flush_exports()
    with _lock:
        executor, _executor = _executor, None
    if executor is not None:
        executor.shutdown(wait=True)
