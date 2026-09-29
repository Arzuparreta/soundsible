"""Saving and downloading a whole album: the songs go in as one, the download
runs through the import machinery, and what arrives is filed on the record."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from player.favourites_manager import FavouritesManager
from shared.migration import collections
from shared.migration.models import MigrationManifest, SourceTrack
from shared.migration.service import MigrationRunner
from shared.migration.store import MigrationStore
from shared.models import Track
from tests.conftest import TEST_USER_ID


def _row(track_id: int, title: str, position: int) -> dict:
    return {
        "id": f"deezer:track:{track_id}", "type": "track", "source": "deezer",
        "title": title, "artist": "Daft Punk", "album": "Discovery", "duration": 300,
        "external_ids": {"deezer_id": str(track_id)},
        "raw": {"deezer_id": str(track_id), "deezer_album_id": "302127", "track_number": position, "disc_number": 1},
    }


PROFILE = {
    "title": "Discovery", "artist": "Daft Punk", "year": 2001,
    "tracklist": [_row(1, "One More Time", 1), _row(2, "Aerodynamic", 2), _row(3, "Digital Love", 3)],
}


def _library_track(track_id: str, title: str) -> Track:
    return Track(
        id=track_id, title=title, artist="Daft Punk", album="Discovery", duration=300,
        file_hash=f"hash-{track_id}", original_filename=f"{track_id}.mp3", compressed=False,
        file_size=1000, bitrate=320, format="mp3",
    )


def _pending(manifest: MigrationManifest) -> list[dict]:
    return [
        {"source_key": key, "matched_track_id": None, "confidence": 0, "auto_accept": False}
        for key in manifest.tracks
    ]


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr("player.favourites_manager.user_config_dir", lambda: tmp_path)
    return FavouritesManager()


# ── Saving many songs at once ──


def test_saving_many_keeps_the_record_order_and_skips_what_is_held(manager):
    manager.toggle_saved({"keys": ["deezer:2"], "title": "Aerodynamic", "artist": "Daft Punk"})
    entries = [{"keys": [f"deezer:{n}"], "title": f"Song {n}", "artist": "Daft Punk"} for n in (1, 2, 3)]

    changed = manager.set_saved(entries, True)

    assert [entry["keys"] for entry in changed] == [["deezer:3"], ["deezer:1"]]
    # Newest first, and the album reads in its own order at the top.
    assert [entry["keys"][0] for entry in manager.get_entries()] == ["deezer:1", "deezer:3", "deezer:2"]
    assert manager.set_saved(entries, True) == []


def test_taking_many_out_keeps_hearts_and_files(manager):
    manager.toggle_saved({"keys": ["deezer:1"], "title": "Streamed", "artist": "A"})
    manager.set_favourite({"keys": ["deezer:2"], "title": "Marked", "artist": "A"}, True)
    manager.toggle_saved({"keys": ["deezer:3", "lib:track-3"], "title": "Downloaded", "artist": "A"})
    entries = [{"keys": [f"deezer:{n}"]} for n in (1, 2, 3, 4)]

    changed = manager.set_saved(entries, False)

    assert [entry["keys"][0] for entry in changed] == ["deezer:1"]
    assert sorted(entry["keys"][0] for entry in manager.get_entries()) == ["deezer:2", "deezer:3"]


def test_the_batch_route_saves_and_never_flips(monkeypatch):
    from shared.api import app
    from shared.api.routes import library

    resolved = []
    monkeypatch.setattr(library, "_schedule_favourite_resolve", lambda entry: resolved.append(entry["keys"][0]))
    app.config["TESTING"] = True
    client = app.test_client()
    entries = [{"keys": [f"deezer:{n}"], "title": f"Song {n}", "artist": "A"} for n in (1, 2)]

    assert client.post("/api/library/saved/set", json={"entries": entries, "saved": True}).get_json()["changed"] == 2
    assert client.post("/api/library/saved/set", json={"entries": entries, "saved": True}).get_json()["changed"] == 0
    assert sorted(resolved) == ["deezer:1", "deezer:2"]
    assert client.post("/api/library/saved/set", json={"entries": entries, "saved": "yes"}).status_code == 400
    assert client.post("/api/library/saved/set", json={"entries": [{}] * 501, "saved": True}).status_code == 400


# ── An album as an import ──


def test_a_catalog_row_is_keyed_the_way_the_player_keys_it():
    item = {"id": "deezer:track:3", "external_ids": {"deezer_id": "3", "isrc": "gb-duw 0000053"}, "track_id": None}
    assert collections.catalog_identity_keys(item) == ("cat:deezer:track:3", "isrc:GBDUW0000053", "deezer:3")


def test_the_album_manifest_places_every_song_on_the_record():
    manifest = collections.album_manifest("302127", PROFILE)

    assert manifest.provider == "album:302127"
    assert manifest.library_keys == list(manifest.tracks)
    third = manifest.tracks["album:302127:deezer:3"]
    assert (third.title, third.album, third.album_artist) == ("Digital Love", "Discovery", "Daft Punk")
    assert (third.track_number, third.disc_number, third.year) == (3, 1, 2001)
    assert third.identity_keys == ("cat:deezer:track:3", "deezer:3")


def test_placement_survives_the_store_and_leaves_exports_alone():
    placed = SourceTrack("Digital Love", "Daft Punk", "Discovery", album_artist="Daft Punk", track_number=3,
                         identity_keys=("deezer:3",))
    assert SourceTrack.from_dict(placed.to_dict()) == placed
    # An export's track serializes exactly as before, so its fingerprint holds.
    assert set(SourceTrack("Song", "Artist").to_dict()) == {
        "title", "artist", "album", "source_id", "source_uri", "duration", "isrc", "added_at", "local_only",
    }


def test_download_skips_what_is_held_reopens_an_open_job_resumes_a_stopped_one_and_starts_over_a_finished_one(
    tmp_path, monkeypatch,
):
    started = []
    monkeypatch.setattr("shared.migration.service.start_migration_job", lambda job_id, user_id: started.append(job_id))
    store = MigrationStore(tmp_path / "jobs.sqlite3")
    manifest = collections.album_manifest("302127", PROFILE)
    library = [_library_track("held-1", "One More Time")]

    job = collections.start_collection_download(manifest, library, TEST_USER_ID, store=store)
    states = {row["source_key"]: row["state"] for row in store.get_job(job["id"])["tracks"]}
    assert job["state"] == "queued"
    assert states["album:302127:deezer:1"] == "existing"
    assert states["album:302127:deezer:3"] == "pending"
    assert started == [job["id"]]

    again = collections.start_collection_download(manifest, library, TEST_USER_ID, store=store)
    assert again["id"] == job["id"]
    assert started == [job["id"]]

    store.update_track(job["id"], "album:302127:deezer:2", state="failed", error="network")
    store.set_job_state(job["id"], "partial")
    resumed = collections.start_collection_download(manifest, library, TEST_USER_ID, store=store)
    assert resumed["id"] == job["id"]
    assert resumed["state"] == "queued"
    assert store.get_track(job["id"], "album:302127:deezer:2")["state"] == "pending"
    assert started == [job["id"], job["id"]]

    store.set_job_state(job["id"], "completed")
    fresh = collections.start_collection_download(manifest, library, TEST_USER_ID, store=store)
    assert fresh["id"] != job["id"]
    assert store.get_job(job["id"])["state"] == "cancelled"
    assert collections.collection_job("album:302127", store=store)["id"] == fresh["id"]
    # The import screen lists exports, not album downloads.
    assert store.list_jobs(include_collections=False) == []
    assert len(store.list_jobs()) == 2


def test_the_runner_files_the_download_on_the_record_and_joins_the_saved_song(tmp_path, monkeypatch):
    import shared.api as api

    source = SourceTrack(
        "Digital Love", "Daft Punk", "Discovery", source_id="deezer:3", album_artist="Daft Punk",
        track_number=3, disc_number=1, year=2001, identity_keys=("cat:deezer:track:3", "deezer:3"),
    )
    manifest = MigrationManifest(provider="album:302127", source_name="Discovery",
                                 tracks={"album:302127:deezer:3": source}, library_keys=["album:302127:deezer:3"])
    store = MigrationStore(tmp_path / "runner.sqlite3")
    job, _ = store.create_job(manifest, [])
    runner = MigrationRunner(store, job["id"], TEST_USER_ID)

    captured = {}
    monkeypatch.setattr(api, "parse_intake_item", lambda raw: (captured.update(raw), (None, "stop here"))[1])
    runner._download({"video_id": "abcdefghijk"}, source)
    assert captured["identity_keys"] == ["cat:deezer:track:3", "deezer:3"]
    assert {key: captured["metadata_evidence"][key] for key in ("album", "album_artist", "track_number", "disc_number", "year")} == {
        "album": "Discovery", "album_artist": "Daft Punk", "track_number": 3, "disc_number": 1, "year": 2001,
    }

    favourites = api.get_favourites_manager(TEST_USER_ID)
    favourites.toggle_saved({"keys": ["cat:deezer:track:3", "deezer:3"], "title": "Digital Love", "artist": "Daft Punk"})
    runner._apply_track("album:302127:deezer:3", "track-3")
    assert favourites.is_saved_keys(["lib:track-3"])


def test_the_album_routes_download_from_the_catalog_and_report_progress(monkeypatch):
    from shared.api import app
    from shared.api.routes import catalog

    monkeypatch.setattr(catalog, "_deezer_album_profile", lambda deezer_id: PROFILE)
    monkeypatch.setattr(catalog, "_library_tracks", lambda: [])
    monkeypatch.setattr("shared.migration.service.start_migration_job", MagicMock())
    app.config["TESTING"] = True
    client = app.test_client()

    assert client.get("/api/catalog/album/download?deezer_id=302127").get_json() == {"job": None}
    response = client.post("/api/catalog/album/download", json={"deezer_id": "302127"})
    assert response.status_code == 202
    job = response.get_json()["job"]
    assert (job["provider"], job["source_name"], job["selected_track_count"]) == ("album:302127", "Discovery", 3)

    status = client.get("/api/catalog/album/download?deezer_id=302127").get_json()["job"]
    assert status["id"] == job["id"]
    assert [row["source"]["title"] for row in status["tracks"]] == ["One More Time", "Aerodynamic", "Digital Love"]
    assert client.post("/api/catalog/album/download", json={"deezer_id": "../etc"}).status_code == 400


def test_a_version_chosen_while_the_album_downloads_is_fetched_in_the_same_run(tmp_path):
    manifest = collections.album_manifest("302127", PROFILE)
    first, second, third = list(manifest.tracks)
    store = MigrationStore(tmp_path / "runner.sqlite3")
    job, _ = store.create_job(manifest, _pending(manifest))
    store.configure(job["id"], include_library=True, playlist_ids=[])
    store.update_track(job["id"], second, state="needs_review")
    runner = MigrationRunner(store, job["id"], TEST_USER_ID)
    runner._match_shared_pool = MagicMock(return_value=None)

    def resolve(source):
        if source.title == "One More Time":
            # The listener picks a version for the doubtful song meanwhile.
            store.update_track(job["id"], second, state="pending", selected={"kind": "catalog", "video_id": "abcdefghijk"})
        return {"video_id": "12345678901", "confidence": 0.99}, []

    runner._resolve = MagicMock(side_effect=resolve)
    runner._download = MagicMock(return_value=("downloaded", None))

    runner.run()

    states = {row["source_key"]: row["state"] for row in store.get_job(job["id"])["tracks"]}
    assert states == {first: "completed", second: "completed", third: "completed"}
    assert runner._download.call_count == 3


def test_a_failed_song_is_not_retried_in_a_loop(tmp_path):
    manifest = collections.album_manifest("302127", PROFILE)
    store = MigrationStore(tmp_path / "runner.sqlite3")
    job, _ = store.create_job(manifest, _pending(manifest))
    store.configure(job["id"], include_library=True, playlist_ids=[])
    runner = MigrationRunner(store, job["id"], TEST_USER_ID)
    runner._match_shared_pool = MagicMock(return_value=None)
    runner._resolve = MagicMock(return_value=({"video_id": "12345678901", "confidence": 0.99}, []))
    runner._download = MagicMock(return_value=(None, "network"))

    runner.run()

    assert runner._download.call_count == 3
    assert store.get_job(job["id"])["state"] == "partial"
