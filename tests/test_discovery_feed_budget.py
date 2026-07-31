"""How often one discovery feed build re-reads the same files.

`load_listening_event_rollups` reads the listening-event log and re-parses up to
2000 JSON objects; `load_discovery_settings` opens and parses a small JSON file.
One `_build_discovery_feed_body` call reached the first five times and the
second far more, because the helpers it composes each load their own copy.
Both are memoized for the life of a request now, so these tests count reads
rather than measure milliseconds.
"""

import pytest

import shared.discovery_intelligence as di
from shared import request_scope
from shared.models import LibraryMetadata, Track


@pytest.fixture()
def read_counts(monkeypatch):
    counts = {"rollup": 0, "settings": 0}

    real_rollup = di._read_listening_event_rollups
    real_settings = di._read_discovery_settings

    def counting_rollup(*args, **kwargs):
        counts["rollup"] += 1
        return real_rollup(*args, **kwargs)

    def counting_settings(*args, **kwargs):
        counts["settings"] += 1
        return real_settings(*args, **kwargs)

    monkeypatch.setattr(di, "_read_listening_event_rollups", counting_rollup)
    monkeypatch.setattr(di, "_read_discovery_settings", counting_settings)
    return counts


@pytest.fixture()
def library():
    """A library with enough rows that recommendation building does real work."""
    tracks = [
        Track(
            id=f"t{i}",
            title=f"Song {i}",
            artist=f"Artist {i % 5}",
            album=f"Album {i % 3}",
            duration=180,
            file_hash=f"hash-t{i}",
            original_filename=f"t{i}.mp3",
            compressed=False,
            file_size=1000,
            bitrate=320,
            format="mp3",
        )
        for i in range(24)
    ]
    return LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})


def _build_feed(library):
    """Drive the composition the feed route performs, without the HTTP layer."""
    feed = di.build_music_recommendations(library, set(), limit=24)
    return di.compose_discovery_feed(
        feed,
        rollup=di.load_listening_event_rollups(),
        max_sections=6,
        section_size=8,
    )


def test_feed_build_reads_each_source_once(library, read_counts):
    with request_scope.request_scope():
        _build_feed(library)

    assert read_counts["rollup"] == 1, (
        f"feed build read the listening log {read_counts['rollup']} times"
    )
    assert read_counts["settings"] == 1, (
        f"feed build read discovery settings {read_counts['settings']} times"
    )


def test_without_a_scope_every_call_still_reads(library, read_counts):
    """The memo is an optimisation, not a requirement — CLI paths have no scope."""
    _build_feed(library)

    assert read_counts["rollup"] >= 1
    assert read_counts["settings"] >= 1


def test_scope_does_not_leak_between_requests(library, read_counts):
    with request_scope.request_scope():
        _build_feed(library)
    first = read_counts["rollup"]

    with request_scope.request_scope():
        _build_feed(library)

    assert read_counts["rollup"] == first + 1, "a new request must read afresh"


def test_saving_settings_invalidates_the_memo():
    """A write inside a request must be visible to a later read in the same one."""
    with request_scope.request_scope():
        before = di.load_discovery_settings()["learning_enabled"]
        di.save_discovery_settings({"learning_enabled": not before})

        assert di.load_discovery_settings()["learning_enabled"] is (not before)


def test_recording_an_event_invalidates_the_rollup(read_counts):
    with request_scope.request_scope():
        di.load_listening_event_rollups()
        after_first = read_counts["rollup"]

        di.emit_discovery_event("music_played_30s", {
            "title": "Song",
            "artist": "Artist",
            "track_id": "t1",
        })
        di.load_listening_event_rollups()

    assert read_counts["rollup"] > after_first
