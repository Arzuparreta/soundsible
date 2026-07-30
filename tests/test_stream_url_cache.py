"""The durable stream-URL cache: what makes a resolution worth paying for.

A signed googlevideo URL is good for about six hours, but resolving one costs a
multi-second yt-dlp extraction — and on a relayed station, roughly 1.5 MB
dragged through the residential egress. The in-process memo forgot after five
minutes and forgot everything on restart, so a station kept re-buying URLs it
already owned.

Two properties carry that:
- a URL survives until its own signature expires, across processes,
- a URL resolved through one egress is never served to the other, because the
  CDN signs the resolving address into it.
"""

import time

import pytest

from shared.database import DatabaseManager

VID = "dQw4w9WgXcQ"


@pytest.fixture
def db(tmp_path):
    return DatabaseManager(str(tmp_path / "test.db"))


def test_round_trip_within_expiry(db):
    now = time.time()
    db.set_cached_stream_url(VID, "https://cdn.invalid/a", "relay", now, now + 3600)

    row = db.get_cached_stream_url(VID, "relay")

    assert row is not None
    assert row["url"] == "https://cdn.invalid/a"
    assert row["egress"] == "relay"


def test_expired_row_is_a_miss(db):
    now = time.time()
    db.set_cached_stream_url(VID, "https://cdn.invalid/old", "relay", now - 7200, now - 60)

    assert db.get_cached_stream_url(VID, "relay") is None


def test_already_expired_url_is_not_stored(db):
    now = time.time()
    db.set_cached_stream_url(VID, "https://cdn.invalid/dead", "direct", now - 10, now - 5)

    assert db.get_cached_stream_url(VID, "direct") is None


def test_egress_is_part_of_the_key(db):
    """A relay-resolved URL 403s from the station's own address, so it must not
    be handed to a direct fetch just because the video id matches."""
    now = time.time()
    db.set_cached_stream_url(VID, "https://cdn.invalid/via-relay", "relay", now, now + 3600)

    assert db.get_cached_stream_url(VID, "direct") is None
    assert db.get_cached_stream_url(VID, "relay") is not None


def test_resolving_again_replaces_the_row(db):
    now = time.time()
    db.set_cached_stream_url(VID, "https://cdn.invalid/first", "relay", now, now + 600)
    db.set_cached_stream_url(VID, "https://cdn.invalid/second", "relay", now, now + 3600)

    row = db.get_cached_stream_url(VID, "relay")

    assert row["url"] == "https://cdn.invalid/second"


def test_invalidate_drops_a_rejected_url(db):
    now = time.time()
    db.set_cached_stream_url(VID, "https://cdn.invalid/a", "relay", now, now + 3600)

    db.invalidate_cached_stream_url(VID)

    assert db.get_cached_stream_url(VID, "relay") is None


def test_prune_clears_only_the_dead(db):
    now = time.time()
    db.set_cached_stream_url("aaaaaaaaaa1", "https://cdn.invalid/live", "relay", now, now + 3600)
    db.set_cached_stream_url("aaaaaaaaaa2", "https://cdn.invalid/dead", "relay", now - 7200, now + 1)
    time.sleep(1.1)

    removed = db.prune_stream_urls()

    assert removed == 1
    assert db.get_cached_stream_url("aaaaaaaaaa1", "relay") is not None
    assert db.get_cached_stream_url("aaaaaaaaaa2", "relay") is None


def test_survives_a_new_connection(db, tmp_path):
    """The whole point: a restart must not throw the URL away."""
    now = time.time()
    db.set_cached_stream_url(VID, "https://cdn.invalid/persisted", "relay", now, now + 3600)

    reopened = DatabaseManager(str(tmp_path / "test.db"))

    assert reopened.get_cached_stream_url(VID, "relay")["url"] == "https://cdn.invalid/persisted"
