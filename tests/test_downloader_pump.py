"""
Tests for the orchestrator-owned downloader pump supervisor (plan T2 / 5A).

Covers the three semantics changes flagged in the Outside Voice review
(plan lines 376–378):

1. Idempotency — calling the pump trigger twice does not start two pumps.
2. Cancellation/shutdown — orchestrator.shutdown() exits the pump cleanly
   and releases the `is_processing` flag.
3. Partial-write cleanup — a download failure mid-flight still releases
   the orchestrator task slot (`active_jobs` is cleaned).
"""

import threading
import time

import pytest

from shared.api.orchestrator import JobOrchestrator, PROFILE_SSD


@pytest.fixture
def orch():
    o = JobOrchestrator(profile=PROFILE_SSD)
    yield o
    o.shutdown(wait=False)


# ---------- 1. Idempotency ----------

def test_start_downloader_pump_is_idempotent(orch):
    started = threading.Event()
    release = threading.Event()

    def pump(stop_event):
        started.set()
        # Hold the supervisor thread until the test releases it.
        release.wait(timeout=2)

    assert orch.start_downloader_pump(pump) is True
    assert started.wait(timeout=1)

    # Second call must NOT start a second pump.
    assert orch.start_downloader_pump(pump) is False
    assert orch.pump_is_running()

    release.set()
    orch.stop_downloader_pump(wait=True)
    assert not orch.pump_is_running()


def test_pump_is_still_idempotent_as_watchdog(orch):
    """With the always-on watchdog, a pump never auto-exits — stop_downloader_pump is required."""
    runs = []

    def pump(stop_event):
        runs.append(1)
        # Simulate watchdog: sleep until signalled.
        stop_event.wait(timeout=2)

    assert orch.start_downloader_pump(pump) is True
    # Give it time to enter.
    time.sleep(0.1)
    assert orch.pump_is_running()

    # Second start must be rejected while pump is alive.
    assert orch.start_downloader_pump(pump) is False

    orch.stop_downloader_pump(wait=True)
    assert not orch.pump_is_running()

    # After explicit stop, a new pump can start.
    assert orch.start_downloader_pump(pump) is True
    orch.stop_downloader_pump(wait=True)
    assert runs == [1, 1]


# ---------- 2. Cancellation / shutdown ----------

def test_shutdown_signals_pump_and_joins(orch):
    is_processing = {"flag": False}
    stop_observed = threading.Event()

    def pump(stop_event):
        is_processing["flag"] = True
        try:
            # Mirror the real pump's interruptible sleep loop.
            while not stop_event.wait(timeout=0.05):
                pass
            stop_observed.set()
        finally:
            is_processing["flag"] = False

    orch.start_downloader_pump(pump)
    # Let the pump enter its loop.
    time.sleep(0.1)
    assert is_processing["flag"] is True

    orch.shutdown(wait=True)
    assert stop_observed.is_set(), "shutdown did not deliver stop_event to pump"
    assert is_processing["flag"] is False, "pump left is_processing=True after shutdown"
    assert not orch.pump_is_running()


def test_stop_downloader_pump_releases_supervisor(orch):
    entered = threading.Event()

    def pump(stop_event):
        entered.set()
        stop_event.wait(timeout=5)

    orch.start_downloader_pump(pump)
    assert entered.wait(timeout=1)
    orch.stop_downloader_pump(wait=True, timeout=2)
    assert not orch.pump_is_running()


# ---------- 3. Partial-write / failure cleanup ----------

def test_failed_background_task_releases_active_jobs_slot(orch):
    """
    A download failing mid-flight must not leave its task_id stuck in
    active_jobs. The pump filters pending items by `active_jobs`; a leak
    here would silently stall the queue.
    """

    def boom():
        raise RuntimeError("partial write: disk full")

    fut = orch.submit_background("dl_partial", boom)
    with pytest.raises(RuntimeError):
        fut.result(timeout=2)
    assert "dl_partial" not in orch.active_jobs


def test_pump_continues_after_individual_task_failure(orch):
    """
    Pump submits N tasks; one fails. After the failure, the slot is freed
    and the pump can submit a follow-up task with the same id.
    """
    results = []

    def good():
        results.append("ok")

    def bad():
        raise RuntimeError("nope")

    f1 = orch.submit_background("dl_x", bad)
    with pytest.raises(RuntimeError):
        f1.result(timeout=2)

    # Slot freed → resubmission with same id is a fresh submit, not a dedupe.
    f2 = orch.submit_background("dl_x", good)
    f2.result(timeout=2)
    assert results == ["ok"]
    assert "dl_x" not in orch.active_jobs
