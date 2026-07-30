from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.path_resolver import track_storage_key
from shared.track_identity import preserve_track_identity


def _track() -> Track:
    return Track(
        id="stable-id",
        title="Song",
        artist="Artist",
        album="Album",
        duration=180,
        file_hash="flac-hash",
        original_filename="song.flac",
        compressed=False,
        file_size=10,
        bitrate=900,
        format="flac",
        youtube_id="dQw4w9WgXcQ",
        audio_quality="lossless",
        audio_source="jamendo",
        audio_source_url="https://www.jamendo.com/track/42",
        audio_license_url="https://creativecommons.org/licenses/by/4.0/",
        audio_identity_verified=True,
    )


def test_lossless_provenance_round_trips_through_sqlite(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(
        LibraryMetadata(version=1, tracks=[_track()], playlists=[], settings={})
    )
    stored = db.get_track("stable-id")
    assert stored is not None
    assert stored.file_hash == "flac-hash"
    assert stored.audio_quality == "lossless"
    assert stored.audio_source == "jamendo"
    assert stored.audio_identity_verified is True


def test_storage_key_keeps_logical_id_and_uses_current_format():
    assert track_storage_key(_track()) == "tracks/stable-id.flac"


def test_metadata_rehash_preserves_lossless_provenance():
    original = _track()
    refreshed = Track.from_dict(
        {
            **original.to_dict(),
            "id": "new-id",
            "file_hash": "new-id",
            "audio_quality": "unknown",
            "audio_source": None,
            "audio_source_url": None,
            "audio_license_url": None,
            "audio_identity_verified": False,
        }
    )
    preserve_track_identity(original, refreshed)
    assert refreshed.audio_quality == "lossless"
    assert refreshed.audio_source == "jamendo"
    assert refreshed.audio_identity_verified is True
