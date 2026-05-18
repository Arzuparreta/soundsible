"""Tests for JobOrchestrator HDD profile + two executor pools (plan T1)."""

import threading
import time

import pytest

import sys
import shared.api.orchestrator  # noqa: F401  (ensure module registered)
orch_mod = sys.modules["shared.api.orchestrator"]
from shared.api.orchestrator import (
    JobOrchestrator,
    PROFILE_HDD,
    PROFILE_SSD,
    PROFILE_AUTO,
    _PROFILE_BACKGROUND_WORKERS,
    detect_rotational_disk,
)


@pytest.fixture
def orch():
    o = JobOrchestrator(profile=PROFILE_SSD)
    yield o
    o.shutdown(wait=False)


def test_default_profile_is_ssd_with_three_background_workers(orch):
    assert orch.profile == PROFILE_SSD
    assert orch.background_workers == 3
    assert orch.background_executor._max_workers == 3
    assert orch.metadata_executor._max_workers == 1


def test_hdd_profile_caps_background_at_one():
    o = JobOrchestrator(profile=PROFILE_HDD)
    try:
        assert o.profile == PROFILE_HDD
        assert o.background_workers == 1
        assert o.background_executor._max_workers == 1
        # Metadata stays serialized regardless of profile.
        assert o.metadata_executor._max_workers == 1
    finally:
        o.shutdown(wait=False)


def test_configure_disk_profile_rebuilds_background_pool(orch):
    initial = orch.background_executor
    resolved = orch.configure_disk_profile(PROFILE_HDD)
    assert resolved == PROFILE_HDD
    assert orch.background_executor is not initial
    assert orch.background_executor._max_workers == 1
    # Metadata executor is preserved (not torn down).
    # No assertion on identity required — but worker count must remain 1.
    assert orch.metadata_executor._max_workers == 1


def test_configure_disk_profile_noop_when_size_unchanged(orch):
    initial = orch.background_executor
    orch.configure_disk_profile(PROFILE_SSD)
    assert orch.background_executor is initial


def test_configure_disk_profile_auto_resolves(orch, monkeypatch):
    monkeypatch.setattr(orch_mod, "detect_rotational_disk", lambda p=None: True)
    assert orch.configure_disk_profile(PROFILE_AUTO) == PROFILE_HDD

    monkeypatch.setattr(orch_mod, "detect_rotational_disk", lambda p=None: False)
    assert orch.configure_disk_profile(PROFILE_AUTO) == PROFILE_SSD


def test_unknown_profile_falls_back_to_ssd(orch, caplog):
    assert orch.configure_disk_profile("garbage") == PROFILE_SSD


def test_submit_background_runs_task(orch):
    result = []
    fut = orch.submit_background("t1", lambda: result.append("ok"))
    fut.result(timeout=2)
    assert result == ["ok"]
    # Task is removed from active_jobs after completion.
    assert "t1" not in orch.active_jobs


def test_submit_task_alias_routes_to_background(orch):
    fut = orch.submit_task("t2", lambda: 42)
    assert fut.result(timeout=2) == 42


def test_duplicate_task_id_returns_same_future(orch):
    started = threading.Event()
    release = threading.Event()

    def slow():
        started.set()
        release.wait(timeout=2)
        return "done"

    f1 = orch.submit_background("dup", slow)
    started.wait(timeout=2)
    f2 = orch.submit_background("dup", slow)
    assert f1 is f2
    release.set()
    f1.result(timeout=2)


def test_hdd_background_pool_serializes_disk_jobs():
    o = JobOrchestrator(profile=PROFILE_HDD)
    try:
        overlap = {"max": 0, "current": 0}
        lock = threading.Lock()
        release = threading.Event()

        def worker(i):
            with lock:
                overlap["current"] += 1
                overlap["max"] = max(overlap["max"], overlap["current"])
            release.wait(timeout=1)
            with lock:
                overlap["current"] -= 1

        futs = [o.submit_background(f"j{i}", worker, i) for i in range(3)]
        time.sleep(0.1)
        release.set()
        for f in futs:
            f.result(timeout=2)
        assert overlap["max"] == 1, "HDD profile must cap background concurrency at 1"
    finally:
        o.shutdown(wait=False)


def test_metadata_lane_is_serialized_even_under_concurrent_submits(orch):
    overlap = {"max": 0, "current": 0}
    lock = threading.Lock()

    def writer():
        with lock:
            overlap["current"] += 1
            overlap["max"] = max(overlap["max"], overlap["current"])
        time.sleep(0.05)
        with lock:
            overlap["current"] -= 1

    futs = [orch.submit_metadata(f"m{i}", writer) for i in range(4)]
    for f in futs:
        f.result(timeout=3)
    assert overlap["max"] == 1


def test_background_and_metadata_pools_are_independent():
    """A blocked metadata commit must not stall background jobs."""
    o = JobOrchestrator(profile=PROFILE_SSD)
    try:
        meta_release = threading.Event()
        bg_done = threading.Event()

        def slow_meta():
            meta_release.wait(timeout=2)

        def bg():
            bg_done.set()

        o.submit_metadata("meta_block", slow_meta)
        time.sleep(0.05)
        o.submit_background("bg1", bg)
        assert bg_done.wait(timeout=1), "background pool blocked by metadata lane"
        meta_release.set()
    finally:
        o.shutdown(wait=False)


def test_run_serialized_still_works(orch):
    out = []
    orch.run_serialized(lambda: out.append(1))
    assert out == [1]


def test_schedule_metadata_commit_debounces(orch):
    orch.commit_debounce_sec = 0.05
    counter = {"n": 0}

    def commit():
        counter["n"] += 1

    for _ in range(5):
        orch.schedule_metadata_commit(commit)
        time.sleep(0.005)
    time.sleep(0.2)
    assert counter["n"] == 1


def test_failing_task_clears_active_jobs(orch):
    def boom():
        raise RuntimeError("nope")

    fut = orch.submit_background("explode", boom)
    with pytest.raises(RuntimeError):
        fut.result(timeout=2)
    assert "explode" not in orch.active_jobs


def test_detect_rotational_disk_returns_bool(tmp_path):
    # Best-effort: just assert it returns a bool without raising. Real value
    # depends on host disk; we don't care about correctness in CI.
    assert isinstance(detect_rotational_disk(tmp_path), bool)


def test_profile_constants_have_expected_worker_counts():
    assert _PROFILE_BACKGROUND_WORKERS[PROFILE_HDD] == 1
    assert _PROFILE_BACKGROUND_WORKERS[PROFILE_SSD] == 3
