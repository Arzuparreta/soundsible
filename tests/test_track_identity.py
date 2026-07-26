from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.track_identity import preserve_track_identity


def _track(track_id: str = "track-1", youtube_id: str | None = "dQw4w9WgXcQ") -> Track:
    return Track(
        id=track_id,
        title="Song",
        artist="Artist",
        album="Album",
        duration=213,
        file_hash="hash",
        original_filename="song.opus",
        compressed=True,
        file_size=123,
        bitrate=128,
        format="opus",
        youtube_id=youtube_id,
    )


def test_database_sync_round_trips_youtube_identity(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(LibraryMetadata(version=1, tracks=[_track()], playlists={}, settings={}))

    [stored] = db.get_all_tracks()

    assert stored.youtube_id == "dQw4w9WgXcQ"


def test_database_migration_adds_youtube_identity_column(tmp_path):
    path = tmp_path / "legacy.db"
    import sqlite3

    DatabaseManager(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE tracks DROP COLUMN youtube_id")

    DatabaseManager(str(path))

    with sqlite3.connect(path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(tracks)")}
    assert "youtube_id" in columns


def test_metadata_rehash_preserves_authoritative_source_identity():
    original = _track()
    original.musicbrainz_id = "mbid"
    refreshed = _track(track_id="new-hash", youtube_id="9bZkp7q19f0")
    refreshed.musicbrainz_id = None

    result = preserve_track_identity(original, refreshed)

    assert result.youtube_id == "dQw4w9WgXcQ"
    assert result.musicbrainz_id == "mbid"
