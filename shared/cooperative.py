"""The station's process model: one cooperative gevent loop, and its watchdog.

The engine serves every request from a single gevent hub in the main thread.
Two rules follow from that, and both are enforced here rather than at each
call site.

No multi-threaded native pool may live in this process. gevent starts every
subprocess with a real `os.fork()`, and `fork()` runs the `pthread_atfork`
handlers of the libraries loaded in the process. OpenBLAS's handler deadlocks
when another thread is inside a multi-threaded BLAS call: the forking thread
— the hub — never returns, holding the GIL, while one OpenBLAS thread spins.
Measured on 2026-10-28 with a gevent fork loop beside three threads running
NumPy matrix products: three hangs in three runs within 20 seconds, none in
three runs of ~13,000 forks each once OpenBLAS has one thread. Heavy numerical
work belongs in its own process (see `shared.dj.worker`); the limit below keeps
any NumPy left in this process single-threaded.

A stalled loop must end the process. The station is unreachable while the hub
does not run, yet the process stays alive, so a service manager never restarts
it. `start_loop_watchdog` re-arms `faulthandler`'s timer from the hub; the
timer runs on its own C thread and needs no GIL, so it fires even when the hub
is stuck inside native code. It writes every thread's stack to stderr and exits
with status 1, which `Restart=on-failure` (systemd) or a container restart
policy turns into a fresh engine.
"""

from __future__ import annotations

import faulthandler
import os
import sys

#: How long the loop may go without running before the process exits. A
#: request loop blocked this long is already a station no client can reach.
STALL_EXIT_SECONDS = 60.0
_REARM_SECONDS = 5.0

_watchdog = None


def patch_process() -> None:
    """Make this process cooperative. Call before importing anything else.

    The thread limit must be in the environment before NumPy loads OpenBLAS,
    and gevent must patch before the server's modules import socket or
    threading.
    """
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    from gevent import monkey

    monkey.patch_all()


def _cooperative() -> bool:
    monkey = sys.modules.get("gevent.monkey")
    return monkey is not None and monkey.is_module_patched("threading")


def off_loop(fn, *args, **kwargs):
    """Run blocking work on a native thread when the engine serves under gevent.

    Under `patch_process` a `ThreadPoolExecutor` worker is a greenlet on the
    hub, not a thread. File reads and SQLite statements never yield, so work
    that reads a network share or writes a large transaction holds every
    request — and the watchdog — while it runs (#492). gevent's native pool
    runs it on a real thread; the GIL is released around file I/O and SQLite
    calls, and the caller's greenlet waits without blocking the loop.

    The caller waits for the work even when it is interrupted, then re-raises
    the interruption: the work may hold a pooled connection or an open
    transaction that must not be handed back while a thread still uses it.

    `fn` must not use gevent primitives or greenlet-local state, which belong
    to the hub's thread. Outside a cooperative process it runs where called.
    """
    if not _cooperative():
        return fn(*args, **kwargs)
    from gevent import get_hub

    result = get_hub().threadpool.spawn(fn, *args, **kwargs)
    interrupted = None
    while not result.ready():
        try:
            result.wait()
        except BaseException as exc:  # noqa: BLE001 - re-raised once the work has finished
            interrupted = interrupted or exc
    if interrupted is not None:
        raise interrupted
    return result.get()


def start_loop_watchdog(stall_seconds: float = STALL_EXIT_SECONDS, *, rearm_seconds: float = _REARM_SECONDS) -> None:
    """Exit with status 1 once the cooperative loop has not run for `stall_seconds`.

    Does nothing in a process that is not cooperative: its threads are real,
    and no single loop carries every request.
    """
    global _watchdog
    if not _cooperative() or _watchdog is not None:
        return
    import gevent

    def rearm() -> None:
        while True:
            faulthandler.dump_traceback_later(stall_seconds, exit=True, file=sys.stderr)
            gevent.sleep(rearm_seconds)

    _watchdog = gevent.spawn(rearm)


def stop_loop_watchdog() -> None:
    """Disarm before a deliberate shutdown, which may legitimately take a while."""
    global _watchdog
    if _watchdog is not None:
        _watchdog.kill(block=False)
        _watchdog = None
    faulthandler.cancel_dump_traceback_later()
