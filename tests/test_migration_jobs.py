import io
import hashlib
import json
import uuid
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from flask import Flask

from shared.api.routes.migration import migration_bp
from shared.database import instance_db
from shared.hardening import SCOPE_LIBRARY_READ
from shared.migration.match import LibraryMatcher
from shared.migration.models import MigrationManifest, SourcePlaylist, SourceTrack
from shared.migration.parsers import ParseError, parse_upload
from shared.migration.service import MigrationRunner
from shared.migration.store import MigrationStore
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context
from tests.conftest import TEST_USER_ID


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "migration"


def _track(index: int) -> Track:
    return Track(
        id=f"track-{index}",
        title=f"Song {index}",
        artist="Bounded Artist",
        album="Scale",
        duration=180,
        file_hash=f"hash-{index}",
        original_filename=f"{index}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=192,
        format="mp3",
    )


def test_spotify_account_export_preserves_playlists_and_liked_songs():
    manifest = parse_upload(
        "Playlist1.json",
        (FIXTURES / "spotify_account_data.json").read_bytes(),
    )
    assert manifest.provider == "spotify"
    assert [playlist.name for playlist in manifest.playlists] == ["Road trip", "Liked Songs"]
    assert len(manifest.tracks) == 3
    assert manifest.playlists[0].track_keys[0] == "spotify:spotify-alpha"
    assert manifest.tracks[manifest.playlists[0].track_keys[1]].local_only is True
    assert manifest.favourite_keys == manifest.playlists[1].track_keys


def test_spotify_zip_export_is_autodetected_and_safe():
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("Spotify Account Data/Playlist1.json", (FIXTURES / "spotify_account_data.json").read_bytes())
        archive.writestr("Spotify Account Data/StreamingHistory_music_0.json", b"[]")
    manifest = parse_upload("my-data.zip", payload.getvalue())
    assert len(manifest.playlists) == 2
    assert all("Talk episode" not in track.title for track in manifest.tracks.values())


def test_apple_xml_preserves_playlist_and_excludes_podcasts():
    manifest = parse_upload("Library.xml", (FIXTURES / "apple_library.xml").read_bytes())
    assert manifest.provider == "apple_music"
    assert len(manifest.tracks) == 1
    assert manifest.library_keys == ["apple_music:APPLEALPHA"]
    assert [playlist.name for playlist in manifest.playlists] == ["Focus"]
    assert manifest.playlists[0].track_keys == manifest.library_keys


def test_upload_rejects_empty_and_invalid_xml():
    for filename, payload in (("empty.csv", b""), ("Library.xml", b"<plist>")):
        try:
            parse_upload(filename, payload)
        except ParseError:
            pass
        else:
            raise AssertionError("Expected ParseError")


def test_matcher_scores_a_bounded_candidate_pool():
    tracks = [_track(index) for index in range(2000)]
    matcher = LibraryMatcher(tracks)
    source = SourceTrack(title="Song 1999", artist="Bounded Artist", album="Scale")
    assert len(matcher.candidates(source)) <= 120
    assert matcher.match(source).matched_track_id == "track-1999"


def test_store_is_durable_deduplicated_and_user_scoped(tmp_path):
    manifest = MigrationManifest(
        provider="spotify",
        source_name="Export",
        tracks={"spotify:a": SourceTrack("A", "Artist", duration=200)},
        playlists=[SourcePlaylist("p1", "Mix", ["spotify:a"])],
        library_keys=["spotify:a"],
    )
    path = tmp_path / "jobs.sqlite3"
    store = MigrationStore(path)
    matches = [{"source_key": "spotify:a", "matched_track_id": None, "confidence": 0, "auto_accept": False}]
    first, created = store.create_job(manifest, matches)
    duplicate, duplicate_created = MigrationStore(path).create_job(manifest, matches)
    assert created is True
    assert duplicate_created is False
    assert duplicate["id"] == first["id"]

    configured = store.configure(first["id"], include_library=True, playlist_ids=["p1"])
    assert configured["selected_track_count"] == 1
    assert configured["estimated_download_bytes"] == 4_800_000
    store.update_track(first["id"], "spotify:a", state="completed", matched_track_id="local-a")
    assert MigrationStore(path).get_job(first["id"])["tracks"][0]["matched_track_id"] == "local-a"

    with user_context("somebody-else"):
        assert MigrationStore().list_jobs() == []


def test_job_upload_api_accepts_empty_destination_library():
    app = Flask(__name__)
    app.register_blueprint(migration_bp)
    client = app.test_client()
    token = "migration-read"
    instance_db().create_auth_token(
        str(uuid.uuid4()),
        hashlib.sha256(token.encode()).hexdigest(),
        kind="agent",
        scopes=[SCOPE_LIBRARY_READ],
        name="migration",
        device_type="test",
        user_id=TEST_USER_ID,
    )
    mock_lib = MagicMock()
    mock_lib.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    mock_lib.refresh_if_stale = MagicMock()
    payload = (FIXTURES / "spotify_account_data.json").read_bytes()

    with patch("shared.api.routes.migration._get_core_lib", return_value=mock_lib):
        response = client.post(
            "/api/migration/jobs",
            data={"file": (io.BytesIO(payload), "Playlist1.json")},
            content_type="multipart/form-data",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 201
    job = response.get_json()["job"]
    assert job["manifest"]["track_count"] == 3
    assert job["counts"]["pending"] == 3


def test_runner_preserves_playlist_order_and_maps_liked_songs(tmp_path):
    import shared.api as api

    first = _track(1)
    second = _track(2)
    core = api.get_user_core(TEST_USER_ID)
    core.library.metadata.tracks = [first, second]
    core.library._save_metadata()
    manifest = MigrationManifest(
        provider="spotify",
        source_name="Export",
        tracks={
            "spotify:a": SourceTrack(first.title, first.artist, first.album),
            "spotify:b": SourceTrack(second.title, second.artist, second.album),
        },
        playlists=[SourcePlaylist("mix", "My mix", ["spotify:b", "spotify:a"])],
        library_keys=["spotify:a", "spotify:b"],
        favourite_keys=["spotify:a"],
    )
    store = MigrationStore(tmp_path / "runner.sqlite3")
    job, _ = store.create_job(
        manifest,
        [
            {
                "source_key": "spotify:a",
                "matched_track_id": first.id,
                "confidence": 1,
                "auto_accept": True,
            },
            {
                "source_key": "spotify:b",
                "matched_track_id": second.id,
                "confidence": 1,
                "auto_accept": True,
            },
        ],
    )
    store.configure(job["id"], include_library=True, playlist_ids=["mix"])

    MigrationRunner(store, job["id"], TEST_USER_ID).run()

    completed = store.get_job(job["id"])
    target_name = completed["playlist_names"]["mix"]
    assert completed["state"] == "completed"
    assert core.library.metadata.playlists[target_name] == [second.id, first.id]
    assert core.favourites.is_favourite(first.id)


def test_runner_auto_downloads_only_high_confidence_and_stops_for_review(tmp_path):
    manifest = MigrationManifest(
        provider="apple_music",
        source_name="Library",
        tracks={
            "apple_music:a": SourceTrack("Certain", "Artist"),
            "apple_music:b": SourceTrack("Doubtful", "Artist"),
        },
        library_keys=["apple_music:a", "apple_music:b"],
    )
    store = MigrationStore(tmp_path / "runner.sqlite3")
    job, _ = store.create_job(
        manifest,
        [
            {"source_key": key, "matched_track_id": None, "confidence": 0, "auto_accept": False}
            for key in manifest.tracks
        ],
    )
    store.configure(job["id"], include_library=True, playlist_ids=[])
    runner = MigrationRunner(store, job["id"], TEST_USER_ID)
    runner._match_shared_pool = MagicMock(return_value=None)
    runner._resolve = MagicMock(
        side_effect=[
            (
                {"video_id": "12345678901", "confidence": 0.91},
                [{"video_id": "12345678901", "confidence": 0.91}],
            ),
            (
                {"video_id": "abcdefghijk", "confidence": 0.61},
                [{"video_id": "abcdefghijk", "confidence": 0.61}],
            ),
        ]
    )
    runner._download = MagicMock(return_value=("downloaded-track", None))

    runner.run()

    finished = store.get_job(job["id"])
    by_key = {row["source_key"]: row for row in finished["tracks"]}
    assert finished["state"] == "needs_review"
    assert by_key["apple_music:a"]["state"] == "completed"
    assert by_key["apple_music:b"]["state"] == "needs_review"
    runner._download.assert_called_once()
