"""The store is what stops the engine measuring the same file twice, and what
guarantees a measurement stops applying the moment its file changes.
"""

from __future__ import annotations

import time

import pytest

from shared.loudness import annotate_tracks
from shared.loudness.measure import LoudnessMeasurement
from shared.loudness.store import (
    MAX_ATTEMPTS,
    STATUS_FAILED,
    STATUS_OK,
    STATUS_UNMEASURABLE,
    LoudnessStore,
    identity_for,
    reset_connections,
    source_stamp,
)

MEASUREMENT = LoudnessMeasurement(lufs=-9.4, peak_dbtp=-0.8, lra=4.2)


@pytest.fixture(autouse=True)
def fresh_connections():
    # The runtime config dir moves per test; drop the thread-local handle so the
    # store opens the new file rather than the previous test's.
    reset_connections()
    yield
    reset_connections()


@pytest.fixture
def audio_file(tmp_path):
    path = tmp_path / "song.flac"
    path.write_bytes(b"audio bytes")
    return path


def test_a_measurement_round_trips(audio_file):
    store = LoudnessStore()
    store.put("abc", source_stamp(audio_file), MEASUREMENT)
    assert store.measured() == {"abc": (-9.4, -0.8)}


def test_rewriting_the_file_invalidates_its_measurement(audio_file):
    store = LoudnessStore()
    stamp = source_stamp(audio_file)
    store.put("abc", stamp, MEASUREMENT)
    assert store.is_current("abc", stamp)

    # A lossless upgrade rewrites the audio in place: same identity, new bytes.
    audio_file.write_bytes(b"a different, longer recording")
    assert not store.is_current("abc", source_stamp(audio_file))


def test_a_bumped_version_invalidates_everything(audio_file, monkeypatch):
    store = LoudnessStore()
    store.put("abc", source_stamp(audio_file), MEASUREMENT)
    assert store.measured()

    monkeypatch.setattr("shared.loudness.store.LOUDNESS_VERSION", 2)
    assert store.measured() == {}


def test_an_unmeasurable_file_is_a_verdict_not_a_retry(audio_file):
    # Silence and sub-gate fragments are read once and then left alone: they are
    # not failures, and reopening them every sweep would be pure disk churn.
    store = LoudnessStore()
    stamp = source_stamp(audio_file)
    store.put("abc", stamp, None)

    assert store.measured() == {}
    assert store.get("abc")["status"] == STATUS_UNMEASURABLE
    assert store.is_current("abc", stamp)


def test_a_failure_backs_off_and_then_gives_up(audio_file):
    store = LoudnessStore()
    stamp = source_stamp(audio_file)

    store.mark_failed("abc", stamp)
    row = store.get("abc")
    assert row["status"] == STATUS_FAILED
    assert row["next_attempt_at"] > time.time()
    # Still due later, so the sweep must skip it for now.
    assert store.is_current("abc", stamp)

    for _ in range(MAX_ATTEMPTS):
        store.mark_failed("abc", stamp)
    assert store.get("abc")["attempts"] >= MAX_ATTEMPTS
    # Out of attempts: permanently skipped rather than retried forever.
    assert store.is_current("abc", stamp)


def test_a_due_retry_is_pending_again(audio_file):
    store = LoudnessStore()
    stamp = source_stamp(audio_file)
    store.mark_failed("abc", stamp)
    from shared.loudness.store import _connect

    _connect().execute("UPDATE track_loudness SET next_attempt_at = 0 WHERE identity = 'abc'")
    _connect().commit()
    assert not store.is_current("abc", stamp)


def test_forget_drops_the_verdict(audio_file):
    store = LoudnessStore()
    stamp = source_stamp(audio_file)
    store.put("abc", stamp, MEASUREMENT)
    store.forget("abc")
    assert store.get("abc") is None
    assert not store.is_current("abc", stamp)


def test_pending_keeps_the_callers_order(audio_file):
    store = LoudnessStore()
    stamp = source_stamp(audio_file)
    store.put("known", stamp, MEASUREMENT)

    candidates = [("favourite", stamp), ("known", stamp), ("recent", stamp)]
    # Order is what makes levelling show up on the music somebody actually
    # plays within minutes instead of after the whole library.
    assert store.pending(candidates) == ["favourite", "recent"]


def test_coverage_counts_each_verdict(audio_file):
    store = LoudnessStore()
    stamp = source_stamp(audio_file)
    store.put("ok", stamp, MEASUREMENT)
    store.put("quiet", stamp, None)
    store.mark_failed("broken", stamp)

    assert store.coverage() == {"measured": 1, "unmeasurable": 1, "failed": 1}


def test_identity_prefers_the_content_hash():
    class Track:
        id = "track-id"
        file_hash = "content-hash"

    assert identity_for(Track()) == "content-hash"

    class Downloaded:
        id = "track-id"
        file_hash = None

    assert identity_for(Downloaded()) == "track-id"


def test_annotate_adds_nothing_for_unmeasured_tracks(audio_file):
    LoudnessStore().put("measured", source_stamp(audio_file), MEASUREMENT)
    tracks = [
        {"id": "measured", "file_hash": "measured", "title": "One"},
        {"id": "unknown", "file_hash": "unknown", "title": "Two"},
    ]
    annotate_tracks(tracks)

    assert tracks[0]["loudness_lufs"] == -9.4
    assert tracks[0]["loudness_peak_dbtp"] == -0.8
    # Absent, not null: the player treats "no key" and "no measurement" alike,
    # and the payload stays as small as it was.
    assert "loudness_lufs" not in tracks[1]


def test_annotate_survives_a_broken_cache(monkeypatch):
    def explode(self):
        raise RuntimeError("disk gone")

    monkeypatch.setattr(LoudnessStore, "measured", explode)
    tracks = [{"id": "a", "file_hash": "a"}]
    # Levelling is an enhancement. A cache that cannot be read costs the
    # listener their volume knob, never their library.
    annotate_tracks(tracks)
    assert tracks == [{"id": "a", "file_hash": "a"}]


def test_status_constants_are_distinct():
    assert len({STATUS_OK, STATUS_UNMEASURABLE, STATUS_FAILED}) == 3
