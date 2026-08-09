import json

import pytest

from player.library import LibraryManager
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context


def _track(track_id: str, **overrides) -> Track:
    values = {
        "id": track_id,
        "title": f"Song {track_id}",
        "artist": "Artist",
        "artists": ["Artist", "Guest"],
        "album": "Album",
        "duration": 180,
        "file_hash": track_id,
        "original_filename": f"{track_id}.flac",
        "compressed": False,
        "file_size": 10,
        "bitrate": 900,
        "format": "flac",
    }
    values.update(overrides)
    return Track(**values)


def _library(*tracks: Track) -> LibraryMetadata:
    return LibraryMetadata(
        version=7,
        tracks=list(tracks),
        playlists={"Later": [tracks[-1].id, tracks[0].id, tracks[-1].id], "Empty": []},
        settings={"crossfade": 3},
        last_updated="2026-08-09T12:00:00",
        podcast_subscriptions=[{"feed_id": "feed", "title": "A show"}],
        podcast_episode_cache={"feed": {"fetched_at": "now", "episodes": [{"id": "episode"}]}},
    )


def test_complete_library_round_trips_through_sqlite(tmp_path):
    episode = _track(
        "episode",
        media_kind="podcast_episode",
        podcast_feed_id="feed",
        podcast_episode_guid="guid",
        podcast_rss_url="https://example.test/feed.xml",
    )
    song = _track("song")
    expected = _library(song, episode)
    db = DatabaseManager(str(tmp_path / "library.db"))

    assert db.replace_library(expected) == 1
    restored = db.load_library_metadata()

    assert restored is not None
    assert json.loads(restored.to_json()) == json.loads(expected.to_json())
    assert restored.playlists["Later"] == ["episode", "song", "episode"]
    assert restored.tracks[1].podcast_episode_guid == "guid"
    assert restored.tracks[0].artists == ["Artist", "Guest"]


def test_replace_is_atomic_and_preserves_user_state(tmp_path, monkeypatch):
    db = DatabaseManager(str(tmp_path / "library.db"))
    original = _library(_track("keep"))
    db.replace_library(original)
    db.set_track_rating("keep", 5)

    def fail_projection(_conn, _tracks):
        raise RuntimeError("projection failed")

    monkeypatch.setattr(db, "_replace_catalog_projection", fail_projection)
    with pytest.raises(RuntimeError, match="projection failed"):
        db.replace_library(_library(_track("replacement")))

    assert [track.id for track in db.load_library_metadata().tracks] == ["keep"]
    assert db.get_library_revision() == 1
    assert db.get_track_user_state("keep")["rating"] == 5


def test_legacy_manifest_migrates_once_and_sqlite_wins_afterwards(monkeypatch):
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: None)
    manager = LibraryManager(silent=True)
    legacy = _library(_track("legacy"))
    manager.manifest_path.write_text(legacy.to_json(), encoding="utf-8")

    assert manager.sync_library() is True
    backup = manager.manifest_path.with_name("library.json.pre-sqlite.bak")
    assert backup.exists()
    assert [track.id for track in manager.db.load_library_metadata().tracks] == ["legacy"]

    manager.manifest_path.write_text(_library(_track("manual-edit")).to_json(), encoding="utf-8")
    restarted = LibraryManager(silent=True)
    assert restarted.sync_library() is True
    assert [track.id for track in restarted.metadata.tracks] == ["legacy"]
    assert [track["id"] for track in json.loads(restarted.manifest_path.read_text())["tracks"]] == ["legacy"]
    assert json.loads(backup.read_text())["tracks"][0]["id"] == "legacy"


@pytest.mark.parametrize("legacy_content", [None, "{not-json"])
def test_fresh_or_corrupt_legacy_install_becomes_empty_canonical_library(legacy_content, monkeypatch):
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: None)
    manager = LibraryManager(silent=True)
    if legacy_content is not None:
        manager.manifest_path.write_text(legacy_content, encoding="utf-8")

    assert manager.sync_library() is True
    assert manager.db.has_canonical_library() is True
    assert manager.metadata.tracks == []


def test_export_failure_does_not_roll_back_canonical_write(monkeypatch):
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: None)
    manager = LibraryManager(silent=True)
    manager.metadata = _library(_track("committed"))

    def fail_export(_path, _content):
        raise OSError("read-only")

    monkeypatch.setattr(manager, "_atomic_write", fail_export)
    assert manager._save_metadata() is True
    assert [track.id for track in manager.db.load_library_metadata().tracks] == ["committed"]


def test_refresh_uses_sqlite_revision_not_manifest_mtime(monkeypatch):
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: None)
    first = LibraryManager(silent=True)
    second = LibraryManager(silent=True)
    first.metadata = _library(_track("one"))
    assert first._save_metadata() is True

    assert second.refresh_if_stale() is True
    assert [track.id for track in second.metadata.tracks] == ["one"]
    second.manifest_path.write_text(_library(_track("json-only")).to_json(), encoding="utf-8")
    assert second.refresh_if_stale() is False
    assert [track.id for track in second.metadata.tracks] == ["one"]


def test_canonical_libraries_are_isolated_per_user(monkeypatch):
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: None)
    with user_context("alice"):
        alice = LibraryManager(silent=True)
        alice.metadata = _library(_track("alice-track"))
        assert alice._save_metadata() is True
    with user_context("bob"):
        bob = LibraryManager(silent=True)
        bob.metadata = _library(_track("bob-track"))
        assert bob._save_metadata() is True

    with user_context("alice"):
        restarted = LibraryManager(silent=True)
        assert restarted.sync_library() is True
        assert [track.id for track in restarted.metadata.tracks] == ["alice-track"]
    with user_context("bob"):
        restarted = LibraryManager(silent=True)
        assert restarted.sync_library() is True
        assert [track.id for track in restarted.metadata.tracks] == ["bob-track"]
