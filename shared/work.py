"""Demand-owned background work. Cached results outlive demand; jobs do not.

Owners are account-local client instances. A monotonically increasing epoch
retires their previous session, including requests which arrive out of order.
Resource interests are reconciled from the actual playback runway. Jobs shared
by several owners stop only when the last interested owner releases them.
"""

from __future__ import annotations

from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar, copy_context
import logging
import re
import threading
import time

from shared.runtime import get_cache_dir
from shared.user_context import current_user_id, user_context

logger = logging.getLogger(__name__)
_current: ContextVar[Owner | None] = ContextVar("work_owner", default=None)
_job: ContextVar[Job | None] = ContextVar("work_job", default=None)
_lock = threading.RLock()
_owners: dict[tuple, Owner] = {}
_reaper_stop = threading.Event()
_reaper_thread: threading.Thread | None = None
_KEY = re.compile(r"^[A-Za-z0-9_.-]{1,96}$")
# A crashed/disconnected client cannot leave work resident forever. Healthy
# clients renew on the same playback publications as their device state.
LEASE_SECONDS = 120.0


class WorkCancelled(CancelledError):
    pass


class WorkInterrupted(BaseException):
    """Internal unwind: provider retry handlers must not swallow cancellation."""


class Owner:
    def __init__(self, key: tuple, epoch: int):
        self.key, self.epoch = key, epoch
        self.user = current_user_id()
        self.expires = time.monotonic() + LEASE_SECONDS
        self.closed = False
        self.retired = False
        self.jobs: set[Job] = set()
        self.callbacks: set = set()
        self.children: dict[str, Owner] = {}
        self.cancelled_requests: dict[str, float] = {}
        self.parent: Owner | None = None

    def active(self) -> bool:
        return not self.closed and time.monotonic() < self.expires and (self.parent is None or self.parent.active())

    def retain(self, kind: str, keys: set[str]) -> None:
        with _lock:
            removed = [job for job in self.jobs if job.kind == kind and job.key not in keys]
        for job in removed:
            job.release(self)

    def finish_request(self, request_id: str) -> None:
        # Longer than the HTTP timeout: delayed requests cannot restart work,
        # while a long-lived session does not accumulate every past request ID.
        now = time.monotonic()
        self.cancelled_requests = {key: until for key, until in self.cancelled_requests.items() if until > now}
        self.cancelled_requests[request_id] = now + 2 * LEASE_SECONDS

    def close(self, *, retire: bool = True) -> None:
        with _lock:
            self.closed = True
            self.retired = self.retired or retire
            jobs = list(self.jobs)
            children = list(self.children.values())
            callbacks = list(self.callbacks)
        for job in jobs:
            job.release(self)
        for child in children:
            child.close()
        for callback in callbacks:
            callback()


def owner(client: str, epoch: int, *, active: bool = True) -> Owner:
    if not _KEY.fullmatch(client) or type(epoch) is not int or not 0 <= epoch < 10**12:
        raise ValueError("invalid work owner")
    key = (str(get_cache_dir()), current_user_id(), client)
    with _lock:
        previous = _owners.get(key)
        if previous is not None and epoch < previous.epoch:
            raise WorkCancelled("obsolete work epoch")
        if previous is None or epoch > previous.epoch:
            if previous is not None:
                previous.close()
            previous = Owner(key, epoch)
            _owners[key] = previous
        # A closed epoch cannot be resurrected by a delayed request.
        if previous.retired and active:
            raise WorkCancelled("closed work epoch")
        if active:
            previous.closed = False
        previous.expires = time.monotonic() + LEASE_SECONDS
        if not active:
            previous.close()
        if len(_owners) > 256:
            for stale_key, stale in list(_owners.items()):
                if not stale.active() and stale_key != key:
                    stale.close()
                    _owners.pop(stale_key, None)
        return previous


def current() -> Owner | None:
    return _current.get()


def current_job():
    return _job.get()


def context_call(fn, *args, **kwargs):
    """Carry cancellation into a provider's bounded parallel metadata calls."""
    context = copy_context()

    def run():
        def invoke():
            from shared.cooperative import _cooperative

            running = [True]

            def interrupt():
                import gevent

                def deliver():
                    if running[0]:
                        target.throw(WorkInterrupted())

                gevent.spawn(deliver)

            if _cooperative():
                import gevent

                target = gevent.getcurrent()
            else:

                def interrupt():
                    pass

            try:
                demand = current()
                lifetime = interruptible(demand) if demand is not None and current_job() is None else nullcontext()
                with cancelling(interrupt), lifetime:
                    check()
                    return fn(*args, **kwargs)
            finally:
                running[0] = False

        return context.run(invoke)

    return run


@contextmanager
def using(value: Owner | None):
    token = _current.set(value)
    try:
        if value is not None and not value.active():
            raise WorkCancelled()
        yield value
    finally:
        _current.reset(token)


@contextmanager
def interruptible(demand: Owner):
    """Interrupt inline HTTP planning as well as its queued provider jobs."""
    from shared.cooperative import _cooperative

    if not _cooperative():
        yield
        return
    import gevent

    target = gevent.getcurrent()
    running = True

    def interrupt():
        def deliver():
            if running:
                target.throw(WorkInterrupted())

        gevent.spawn(deliver)

    with _lock:
        demand.callbacks.add(interrupt)
    try:
        check()
        yield
    except WorkInterrupted:
        raise WorkCancelled() from None
    finally:
        running = False
        with _lock:
            demand.callbacks.discard(interrupt)


def check() -> None:
    job = _job.get()
    if job is not None and not job.wanted():
        raise WorkCancelled()
    demand = current()
    if demand is not None and not demand.active():
        raise WorkCancelled()


@contextmanager
def cancelling(callback):
    job = _job.get()
    if job is None:
        yield
        return
    with _lock:
        job.callbacks.add(callback)
    try:
        check()
        yield
    finally:
        with _lock:
            job.callbacks.discard(callback)


class Job:
    def __init__(self, kind, key, fn, args, kwargs, demand):
        self.kind, self.key = kind, key
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.owners: set[Owner] = set()
        self.unowned = demand is None
        self.user = current_user_id()
        self.callbacks: set = set()
        self.future: Future | None = None
        self.cancelled = False
        self.running = False
        if demand is not None:
            self.add(demand)

    def add(self, demand):
        if demand.active():
            self.owners.add(demand)
            demand.jobs.add(self)

    def wanted(self):
        return not self.cancelled and (self.unowned or any(o.active() for o in self.owners))

    def release(self, demand):
        with _lock:
            self.owners.discard(demand)
            demand.jobs.discard(self)
            if self.wanted():
                return
            self.cancelled = True
            callbacks = list(self.callbacks)
            if self.future is not None:
                self.future.cancel()
        for callback in callbacks:
            try:
                callback()
            except Exception:
                logger.debug("Work cancellation failed", exc_info=True)

    def run(self):
        token = _job.set(self)
        self.running = True
        # gevent's worker threads are greenlets. Interrupt blocking network
        # extraction too, rather than merely ignoring its answer. In ordinary
        # threaded tools cancellation uses checkpoints and registered closers.
        interrupt = None
        from shared.cooperative import _cooperative

        if _cooperative():
            import gevent

            running = gevent.getcurrent()

            def interrupt():
                def deliver():
                    if self.running:
                        running.throw(WorkInterrupted())

                gevent.spawn(deliver)

        try:
            with _lock:
                if interrupt is not None:
                    self.callbacks.add(interrupt)
            check()
            with user_context(self.user):
                # Shared jobs must not inherit just the first owner's lifetime.
                with using(None):
                    result = self.fn(*self.args, **self.kwargs)
                    check()
                    return result
        except WorkInterrupted:
            raise WorkCancelled() from None
        finally:
            self.running = False
            _job.reset(token)


class Executor:
    """Bounded, shared jobs with removable interests; one future per resource."""

    def __init__(self, kind: str, workers: int, limit: int = 64):
        self.kind, self.limit = kind, limit
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=kind)
        self.jobs: dict[tuple, Job] = {}

    def submit(self, key: str, fn, *args, demand: Owner | None = None, **kwargs) -> Future:
        demand = current() if demand is None else demand
        check()
        resource = (str(get_cache_dir()), key)
        with _lock:
            job = self.jobs.get(resource)
            if job is not None and job.wanted() and not job.future.done():
                if demand is None:
                    job.unowned = True
                else:
                    job.add(demand)
                return job.future
            if len(self.jobs) >= self.limit:
                raise RuntimeError("work queue full")
            job = Job(self.kind, key, fn, args, kwargs, demand)
            self.jobs[resource] = job
            future = self.pool.submit(job.run)
            job.future = future

        def finished(_):
            with _lock:
                if self.jobs.get(resource) is job:
                    self.jobs.pop(resource, None)
                for interested in job.owners:
                    interested.jobs.discard(job)
                job.owners.clear()
                job.callbacks.clear()

        future.add_done_callback(finished)
        return future

    def pending(self, key: str) -> bool:
        with _lock:
            job = self.jobs.get((str(get_cache_dir()), key))
            return job is not None and job.wanted() and not job.future.done()

    def interest(self, key: str, demand: Owner) -> None:
        with _lock:
            job = self.jobs.get((str(get_cache_dir()), key))
            if job is not None and job.wanted():
                job.add(demand)


def expire() -> None:
    with _lock:
        expired = [o for o in _owners.values() if not o.active() and not o.closed]
        expired += [
            child for o in _owners.values() for child in o.children.values() if not child.active() and not child.closed
        ]
    for value in expired:
        value.close(retire=False)


def start_reaper() -> None:
    global _reaper_thread
    if _reaper_thread is not None and _reaper_thread.is_alive():
        return
    _reaper_stop.clear()

    def run():
        while not _reaper_stop.wait(10):
            expire()

    _reaper_thread = threading.Thread(target=run, name="work-leases", daemon=True)
    _reaper_thread.start()


def stop() -> None:
    _reaper_stop.set()
    root = str(get_cache_dir())
    with _lock:
        owned = [value for value in _owners.values() if value.key[0] == root]
    for value in owned:
        value.close()
    if _reaper_thread is not None:
        _reaper_thread.join(timeout=3)


def reset_runtime() -> None:
    """Retire a disposable runtime; no task may write into its successor."""
    root = str(get_cache_dir())
    with _lock:
        removed = [key for key in _owners if key[0] == root]
        for key in removed:
            _owners.pop(key).close()
