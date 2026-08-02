"""The sweep must be invisible: it may never measure while somebody is
listening, and it must reach the music they actually play first.

Everything here injects a fake meter, so no test spawns ffmpeg.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from shared.loudness.measure import LoudnessMeasurement, MeasurementError
from shared.loudness.service import LoudnessService, loudness_analysis_enabled
from shared.loudness.store import MAX_ATTEMPTS, LoudnessStore, reset_connections

MEASUREMENT = LoudnessMeasurement(lufs=-9.4, peak_dbtp=-0.8, lra=4.2)


@pytest.fixture(autouse=True)
def fresh_connections():
    reset_connections()
    yield
    reset_connections()


def make_track(track_id: str):
    return SimpleNamespace(id=track_id, file_hash=track_id)


@pytest.fixture
def library(tmp_path):
    """Three playable files, old enough not to look half-written."""
    entries = []
    for name in ("alpha", "beta", "gamma"):
        path = tmp_path / f"{name}.flac"
        path.write_bytes(b"audio" * 100)
        old = time.time() - 3600
        import os

        os.utime(path, (old, old))
        entries.append((make_track(name), str(path)))
    return entries


def build(library, **kwargs):
    kwargs.setdefault("inventory", lambda: iter(library))
    kwargs.setdefault("foreground_busy", lambda: False)
    kwargs.setdefault("measure", lambda path, **_: MEASUREMENT)
    kwargs.setdefault("quiet_seconds", 0)
    kwargs.setdefault("notify", lambda: None)
    return LoudnessService(**kwargs)


def test_it_never_measures_while_something_is_playing(library):
    service = build(library, foreground_busy=lambda: True)

    assert service.run_once() is False
    assert service.status()["activity"] == "waiting"
    assert LoudnessStore().measured() == {}


def test_it_sweeps_once_the_instance_goes_quiet(library):
    service = build(library)

    assert service.run_once() is True
    assert set(LoudnessStore().measured()) == {"alpha", "beta", "gamma"}


def test_the_quiet_period_must_elapse_first(library):
    service = build(library, quiet_seconds=60)

    # First pass only starts the clock; nothing may be measured yet.
    assert service.run_once() is False
    assert LoudnessStore().measured() == {}


def test_playback_starting_resets_the_quiet_clock(library):
    busy = {"value": False}
    service = build(library, quiet_seconds=60, foreground_busy=lambda: busy["value"])

    service.run_once()
    busy["value"] = True
    service.run_once()
    busy["value"] = False
    # The clock restarts from zero, so a listener who pauses briefly between
    # songs never lets a sweep slip in behind them.
    assert service.run_once() is False
    assert LoudnessStore().measured() == {}


def test_a_second_sweep_does_no_work(library):
    calls = []
    service = build(library, measure=lambda path, **_: calls.append(path) or MEASUREMENT)

    service.run_once()
    assert len(calls) == 3
    service._last_inventory_at = None  # force it to look again
    service.run_once()
    # Measured files are current, so re-inventorying costs a stat and nothing more.
    assert len(calls) == 3


def test_priority_work_ignores_the_idle_gate(library):
    # A listener is about to reach an unmeasured track. Waiting for a quiet disk
    # would mean the song plays unlevelled; a handful of files is worth the
    # interruption.
    service = build(library, foreground_busy=lambda: True, quiet_seconds=60)
    service.request(["beta"])

    assert service.run_once() is True
    assert set(LoudnessStore().measured()) == {"beta"}


def test_priority_skips_what_is_already_known(library):
    service = build(library)
    service.run_once()

    service.request(["alpha"])
    assert service._priority == []


def test_a_failed_attempt_backs_off_rather_than_concluding_anything(library):
    def explode(path, **_):
        raise MeasurementError("disk went away")

    service = build(library, measure=explode)
    service.run_once()

    store = LoudnessStore()
    assert store.measured() == {}
    row = store.get("alpha")
    assert row["status"] == "failed"
    assert row["next_attempt_at"] > time.time()


def test_a_file_with_nothing_to_measure_is_never_reopened(library):
    calls = []

    def silent(path, **_):
        calls.append(path)
        return None

    service = build(library, measure=silent)
    service.run_once()
    assert len(calls) == 3

    service._last_inventory_at = None
    service.run_once()
    # Silence is a verdict, not a failure: reopening it every sweep would be
    # pure disk churn for a number that will never change.
    assert len(calls) == 3


def test_it_gives_up_on_a_permanently_broken_file(library):
    def explode(path, **_):
        raise MeasurementError("corrupt")

    service = build(library, measure=explode)
    store = LoudnessStore()

    for _ in range(MAX_ATTEMPTS + 2):
        service._last_inventory_at = None
        # Make the backoff due so the next sweep really does retry.
        from shared.loudness.store import _connect

        _connect().execute("UPDATE track_loudness SET next_attempt_at = 0")
        _connect().commit()
        service.run_once()

    assert store.get("alpha")["attempts"] >= MAX_ATTEMPTS


def test_a_file_still_being_written_is_left_alone(tmp_path):
    path = tmp_path / "downloading.flac"
    path.write_bytes(b"partial")  # mtime is now, so it is still moving
    service = build([(make_track("downloading"), str(path))])

    assert service.run_once() is False
    assert LoudnessStore().measured() == {}


def test_favourites_are_queued_before_the_rest(library, monkeypatch):
    monkeypatch.setattr(LoudnessService, "_favourite_ids", staticmethod(lambda: ["gamma"]))
    service = build(library)

    service._refresh_queue()
    # Levelling has to show up on the music somebody actually plays within
    # minutes, not after the whole library has been swept. Asserted on the queue
    # rather than on completion order, because a batch may be measured by
    # several workers at once.
    assert [identity for identity, _ in service._queue][0] == "gamma"


def test_invalidating_forgets_a_measurement(library):
    service = build(library)
    service.run_once()
    assert "alpha" in LoudnessStore().measured()

    service.invalidate("alpha")
    assert "alpha" not in LoudnessStore().measured()


def test_measure_now_does_one_file_immediately(library):
    service = build(library, foreground_busy=lambda: True, quiet_seconds=600)
    service.measure_now("beta")
    # A freshly downloaded song is levelled the first time it plays rather than
    # after the next sweep.
    assert set(LoudnessStore().measured()) == {"beta"}


def test_the_kill_switch_stops_new_measurements(library, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOUDNESS_ANALYSIS", "false")
    service = build(library)

    assert loudness_analysis_enabled() is False
    assert service.run_once() is False
    assert service.start() is False
    assert LoudnessStore().measured() == {}


def test_the_kill_switch_leaves_existing_measurements_working(library, monkeypatch):
    build(library).run_once()
    monkeypatch.setenv("SOUNDSIBLE_LOUDNESS_ANALYSIS", "off")
    # Turning analysis off stops measuring; it does not un-level the library,
    # because the player reads the stored numbers without asking the engine.
    assert set(LoudnessStore().measured()) == {"alpha", "beta", "gamma"}


def test_notifications_are_rare(library):
    sent = []
    service = build(library, notify=lambda: sent.append(1))

    service.run_once()
    service._last_inventory_at = None
    service.run_once()
    # Clients refetch the whole library on this event, so a long sweep must not
    # turn into a stream of them.
    assert len(sent) <= 1


def test_status_reports_progress(library):
    service = build(library)
    service.run_once()

    status = service.status()
    assert status["measured"] == 3
    assert status["enabled"] is True


def test_stop_is_safe_when_never_started(library):
    build(library).stop()
