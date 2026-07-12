"""Tests for the persistent related_mix_cache in DatabaseManager."""

import json
import tempfile

import pytest

from shared.database import DatabaseManager


def _make_db():
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    return DatabaseManager(tmp.name)


def test_set_and_get_related_mix_roundtrip():
    db = _make_db()
    results = [
        {"id": "abc11111111", "title": "Track A", "channel": "Artist", "duration": 200},
        {"id": "def22222222", "title": "Track B", "channel": "Other", "duration": 180},
    ]
    db.set_related_mix("abc11111111", results)
    got = db.get_related_mix("abc11111111")
    assert got is not None
    assert len(got) == 2
    assert got[0]["id"] == "abc11111111"


def test_get_related_mix_miss_returns_none():
    db = _make_db()
    assert db.get_related_mix("nonexistent000") is None


def test_get_related_mix_empty_video_id_returns_none():
    db = _make_db()
    assert db.get_related_mix("") is None


def test_set_related_mix_upsert_overwrites():
    db = _make_db()
    db.set_related_mix("vid111111111", [{"id": "old", "title": "Old"}])
    db.set_related_mix("vid111111111", [{"id": "new", "title": "New"}])
    got = db.get_related_mix("vid111111111")
    assert len(got) == 1
    assert got[0]["id"] == "new"


def test_set_related_mix_empty_list_still_cached():
    """An empty result is cached so a known-empty seed isn't re-fetched for a week."""
    db = _make_db()
    db.set_related_mix("vid222222222", [])
    got = db.get_related_mix("vid222222222")
    assert got is not None
    assert got == []


def test_set_related_mix_ignores_none():
    db = _make_db()
    db.set_related_mix("vid333333333", None)  # type: ignore[arg-type]
    assert db.get_related_mix("vid333333333") is None


def test_related_mix_survives_new_db_manager_instance():
    """The cache is persistent (SQLite), so a new DatabaseManager pointing at
    the same file reads what a previous one wrote — simulating a server restart."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    db1 = DatabaseManager(tmp.name)
    db1.set_related_mix("vid444444444", [{"id": "x", "title": "Persisted"}])
    db2 = DatabaseManager(tmp.name)
    got = db2.get_related_mix("vid444444444")
    assert got is not None
    assert got[0]["id"] == "x"


def test_related_mix_ttl_expires_old_entries():
    """Entries older than 7 days should not be returned."""
    import sqlite3
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    db = DatabaseManager(tmp.name)
    db.set_related_mix("vid555555555", [{"id": "old", "title": "Old"}])
    # Manually backdate the entry past the 7-day TTL.
    conn = sqlite3.connect(tmp.name)
    conn.execute(
        "UPDATE related_mix_cache SET last_updated = datetime('now', '-8 days') WHERE video_id = ?",
        ("vid555555555",),
    )
    conn.commit()
    conn.close()
    assert db.get_related_mix("vid555555555") is None


def test_related_mix_within_ttl_is_fresh():
    """Entries just under 7 days should still be returned."""
    import sqlite3
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    db = DatabaseManager(tmp.name)
    db.set_related_mix("vid666666666", [{"id": "fresh", "title": "Fresh"}])
    conn = sqlite3.connect(tmp.name)
    conn.execute(
        "UPDATE related_mix_cache SET last_updated = datetime('now', '-6 days') WHERE video_id = ?",
        ("vid666666666",),
    )
    conn.commit()
    conn.close()
    got = db.get_related_mix("vid666666666")
    assert got is not None
    assert got[0]["id"] == "fresh"
