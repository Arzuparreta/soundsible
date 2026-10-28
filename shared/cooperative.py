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
