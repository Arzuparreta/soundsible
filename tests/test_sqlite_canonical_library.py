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


def test_track_replacement_atomically_rekeys_playlists_covers_and_user_state(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    original = LibraryMetadata(
        version=1,
        tracks=[_track("old", youtube_id="video")],
        playlists={"Mix": ["old", "preview", "old"]},
        settings={"playlist_covers": {"Mix": "old"}},
    )
    db.replace_library(original)
    db.set_track_rating("old", 5)

    replacement = LibraryMetadata(
        version=2,
        tracks=[_track("new", youtube_id="video")],
        # This was the library-repair bug: the technical track was replaced,
        # while every reference in the initiating account still named `old`.
        playlists={"Mix": ["old", "preview", "old"]},
        settings={"playlist_covers": {"Mix": "old"}},
    )
    db.replace_library(replacement, id_replacements={"old": "new"})

    restored = db.load_library_metadata()
    assert replacement.playlists == {"Mix": ["new", "preview", "new"]}
    assert replacement.settings["playlist_covers"] == {"Mix": "new"}
    assert restored.playlists == {"Mix": ["new", "preview", "new"]}
    assert restored.settings["playlist_covers"] == {"Mix": "new"}
    assert db.get_track_user_state("new")["rating"] == 5


def test_track_aliases_stop_a_stale_client_from_reviving_old_playlist_ids(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    intermediate = LibraryMetadata(
        version=1,
        tracks=[_track("middle")],
        playlists={"Mix": ["old"]},
        settings={"playlist_covers": {"Mix": "old"}},
    )
    db.replace_library(intermediate, id_replacements={"old": "middle"})
    current = LibraryMetadata(
        version=2,
        tracks=[_track("new")],
        playlists={"Mix": ["middle"]},
        settings={"playlist_covers": {"Mix": "middle"}},
    )
    db.replace_library(current, id_replacements={"middle": "new"})

    stale = LibraryMetadata(
        version=3,
        tracks=[_track("new")],
        playlists={"Mix": ["old"]},
        settings={"playlist_covers": {"Mix": "old"}},
    )
    db.replace_library(stale)

    restored = db.load_library_metadata()
    assert restored.playlists == {"Mix": ["new"]}
    assert restored.settings["playlist_covers"] == {"Mix": "new"}
    assert stale.playlists == {"Mix": ["new"]}


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


def test_pre_alias_broken_playlist_recovers_only_by_unique_strong_identity(monkeypatch):
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: None)
    manager = LibraryManager(silent=True)
    current = LibraryMetadata(
        version=2,
        tracks=[
            _track("new", youtube_id="video-one"),
            _track("ambiguous-a", youtube_id="duplicate"),
            _track("ambiguous-b", youtube_id="duplicate"),
        ],
        playlists={"Mix": ["old", "preview", "ambiguous-old"]},
        settings={"playlist_covers": {"Mix": "old"}},
    )
    manager.db.replace_library(current)
    legacy = LibraryMetadata(
        version=1,
        tracks=[
            _track("old", youtube_id="video-one"),
            _track("ambiguous-old", youtube_id="duplicate"),
        ],
        playlists={"Mix": ["old", "preview", "ambiguous-old"]},
        settings={},
    )
    backup = manager.manifest_path.with_name("library.json.pre-sqlite.bak")
    backup.write_text(legacy.to_json(), encoding="utf-8")

    restarted = LibraryManager(silent=True)
    assert restarted.sync_library() is True

    # The exact provider identity is recovered. A saved/preview-only id is
    # retained, and a non-unique identity is deliberately left untouched.
    assert restarted.metadata.playlists == {
        "Mix": ["new", "preview", "ambiguous-old"]
    }
    assert restarted.metadata.settings["playlist_covers"] == {"Mix": "new"}
    assert json.loads(restarted.manifest_path.read_text())["playlists"] == {
        "Mix": ["new", "preview", "ambiguous-old"]
    }

    stale = LibraryMetadata(
        version=3,
        tracks=current.tracks,
        playlists={"Mix": ["old"]},
        settings={},
    )
    restarted.db.replace_library(stale)
    assert restarted.db.load_library_metadata().playlists == {"Mix": ["new"]}


def test_per_user_manifest_wins_over_portable_manifest_during_migration(monkeypatch, tmp_path):
    manager = LibraryManager(silent=True)
    user_library = _library(_track("real-song"))
    portable_library = _library(_track("track-1"), _track("track-2"))
    portable_dir = tmp_path / "portable"
    portable_dir.mkdir()
    (portable_dir / "library.json").write_text(portable_library.to_json(), encoding="utf-8")
    manager.manifest_path.write_text(user_library.to_json(), encoding="utf-8")
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: portable_dir)

    assert manager.sync_library() is True

    canonical = manager.db.load_library_metadata()
    assert canonical is not None
    assert [track.id for track in canonical.tracks] == ["real-song"]
    backup = manager.manifest_path.with_name("library.json.pre-sqlite.bak")
    assert json.loads(backup.read_text())["tracks"][0]["id"] == "real-song"


def test_an_empty_per_user_manifest_does_not_erase_the_portable_one(monkeypatch, tmp_path):
    """Authoritative only while it has something to say.

    Adopting an empty manifest would make emptiness canonical, and the export
    that follows writes it straight over the library in the music folder — the
    loss the per-user preference exists to prevent, running the other way.
    """
    manager = LibraryManager(silent=True)
    portable_library = _library(_track("track-1"), _track("track-2"))
    portable_dir = tmp_path / "portable"
    portable_dir.mkdir()
    portable_manifest = portable_dir / "library.json"
    portable_manifest.write_text(portable_library.to_json(), encoding="utf-8")
    empty = LibraryMetadata(version=1, tracks=[], playlists={"Kept": []}, settings={})
    manager.manifest_path.write_text(empty.to_json(), encoding="utf-8")
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: portable_dir)

    assert manager.sync_library() is True

    canonical = manager.db.load_library_metadata()
    assert canonical is not None
    assert [track.id for track in canonical.tracks] == ["track-1", "track-2"]
    assert [t["id"] for t in json.loads(portable_manifest.read_text())["tracks"]] == [
        "track-1",
        "track-2",
    ]
    # The music folder's manifest may ship without playlists; the per-user one
    # is where they were. Adopting the first must not drop the second's.
    assert "Kept" in canonical.playlists


def test_a_manifest_from_another_machine_does_not_become_canonical(monkeypatch, tmp_path):
    """Its tracks resolve to nothing here, and nothing is what it would play."""
    manager = LibraryManager(silent=True)
    elsewhere = _library(*[_track(f"gone-{i}") for i in range(6)])
    manager.manifest_path.write_text(elsewhere.to_json(), encoding="utf-8")
    portable_library = _library(_track("present"))
    portable_dir = tmp_path / "portable"
    portable_dir.mkdir()
    (portable_dir / "library.json").write_text(portable_library.to_json(), encoding="utf-8")
    monkeypatch.setattr("player.library._output_dir_for_library", lambda: portable_dir)

    assert manager.sync_library() is True

    canonical = manager.db.load_library_metadata()
    assert canonical is not None
    assert [track.id for track in canonical.tracks] == ["present"]


def test_test_runtime_output_dir_cannot_escape_to_environment(monkeypatch, tmp_path, isolated_runtime):
    external_dir = tmp_path / "external-music"
    external_dir.mkdir()
    external_manifest = external_dir / "library.json"
    sentinel = '{"do_not_touch": true}'
    external_manifest.write_text(sentinel, encoding="utf-8")
    monkeypatch.setenv("OUTPUT_DIR", str(external_dir))

    manager = LibraryManager(silent=True)
    manager.metadata = _library(_track("isolated"))
    assert manager._save_metadata() is True

    assert external_manifest.read_text() == sentinel
    exported = isolated_runtime.music_dir / "library.json"
    assert json.loads(exported.read_text())["tracks"][0]["id"] == "isolated"


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
