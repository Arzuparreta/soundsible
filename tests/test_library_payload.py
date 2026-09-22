"""Public snapshots retain the portable contract without an intermediate JSON."""
from copy import deepcopy
from dataclasses import asdict
import json
from types import SimpleNamespace

from flask import Flask
import pytest

from shared.models import LibraryMetadata, Track


def metadata():
    song = Track(
        id="song", title="Canción 🎵", artist="Artista", album="Álbum", duration=240,
        file_hash="hash", original_filename="song.flac", compressed=False,
        file_size=1000, bitrate=900, format="flac", artists=["Uno", "Dos"],
        local_path="/private/music/song.flac", local_mtime_ns=12345,
        metadata_modified_by_user=True, added_at="2026-01-01T12:00:00",
    )
    episode = Track(
        id="episode", title="Episodio", artist="Autor", album="Programa", duration=1200,
        file_hash="episode-hash", original_filename="episode.mp3", compressed=False,
        file_size=2000, bitrate=128, format="mp3", media_kind="podcast_episode",
        podcast_feed_id="feed", podcast_episode_guid="guid", podcast_rss_url="https://example.org/rss",
    )
    return LibraryMetadata(
        1, [song, episode], {"Favoritas": ["song"]},
        {"playlist_covers": {"Favoritas": "cover"}, "nested": {"flags": [True, None]}},
        last_updated="2026-01-01T12:00:00",
        podcast_subscriptions=[{"id": "feed", "title": "Programa"}],
        podcast_episode_cache={"feed": {"episodes": [{"title": "Episodio"}]}},
    )


def legacy_payload(model):
    # Independent oracle: the pre-optimization serializer's exact field set.
    return json.loads(json.dumps({
        "version": model.version,
        "tracks": [
            {k: v for k, v in asdict(track).items() if k not in {"local_path", "local_mtime_ns"}}
            for track in model.tracks
        ],
        "playlists": model.playlists,
        "settings": model.settings,
        "last_updated": model.last_updated,
        "podcast_subscriptions": list(model.podcast_subscriptions),
        "podcast_episode_cache": dict(model.podcast_episode_cache),
    }, indent=2))


@pytest.mark.parametrize("empty", [False, True])
def test_public_payload_matches_legacy_json(empty):
    model = LibraryMetadata(1, [], {}, {}) if empty else metadata()
    expected = legacy_payload(model)
    assert model.to_public_dict() == expected
    assert json.loads(model.to_json()) == expected
    assert json.loads(model.to_json(indent=None)) == expected


def test_public_snapshot_cannot_mutate_canonical_metadata():
    model = metadata()
    before = deepcopy(model)
    payload = model.to_public_dict()
    payload["tracks"][0]["artists"].append("Other")
    payload["tracks"][0]["title"] = "Changed"
    payload["playlists"]["Favoritas"].clear()
    payload["settings"]["nested"]["flags"].append(False)
    payload["podcast_subscriptions"][0]["title"] = "Changed"
    payload["podcast_episode_cache"]["feed"]["episodes"].clear()
    assert model == before
    assert model.to_public_dict() == legacy_payload(before)


def test_endpoint_uses_fresh_direct_snapshot_and_annotations(monkeypatch):
    from shared.api.routes import library
    from shared.artwork import artwork_store

    model = metadata()
    expected = legacy_payload(model)
    lib = SimpleNamespace(metadata=model, refresh_if_stale=lambda: None)
    monkeypatch.setattr(library, "_get_api", lambda: {"get_core": lambda: (lib, None, None)})
    monkeypatch.setattr(LibraryMetadata, "to_json", lambda *_: pytest.fail("intermediate JSON"))
    monkeypatch.setattr(Track, "to_dict", lambda *_: pytest.fail("recursive track serialization"))

    def loudness(tracks):
        for track in tracks:
            if track["id"] == "song":
                track["loudness"] = {"gain_db": -2}

    monkeypatch.setattr(library, "annotate_tracks", loudness)
    store = artwork_store()
    store.bind("song", None, "none")
    app = Flask(__name__)
    app.register_blueprint(library.library_bp)
    client = app.test_client()
    expected["tracks"][0].update(loudness={"gain_db": -2}, artwork_revision="none-1",
                                  artwork_width=None, artwork_height=None)
    assert client.get("/api/library").get_json() == expected
    assert "loudness" not in model.tracks[0].__dict__

    model.tracks[0].title = "Edited"
    store.bind("song", "new-hash", "manual")
    second = client.get("/api/library").get_json()
    assert second["tracks"][0]["title"] == "Edited"
    assert second["tracks"][0]["artwork_revision"] == "new-hash-2"

    # A different bound library must not receive another snapshot's tracks.
    lib.metadata = LibraryMetadata(1, [], {"Private": []}, {})
    assert client.get("/api/library").get_json() == lib.metadata.to_public_dict()


@pytest.fixture
def revision_endpoint(monkeypatch):
    from shared.api.routes import library
    from shared.artwork import artwork_store

    lib = SimpleNamespace(metadata=metadata(), refresh_if_stale=lambda: None)
    annotations = {"gain": -2}
    monkeypatch.setattr(library, "_get_api", lambda: {"get_core": lambda: (lib, None, None)})

    def annotate(tracks):
        for track in tracks:
            track["loudness"] = {"gain_db": annotations["gain"]}

    monkeypatch.setattr(library, "annotate_tracks", annotate)
    app = Flask(__name__)
    app.register_blueprint(library.library_bp)
    return app.test_client(), lib, annotations, artwork_store()


def test_revision_revalidates_without_body_and_is_account_scoped(revision_endpoint):
    from shared.user_context import user_context

    client, _, _, _ = revision_endpoint
    with user_context("alice"):
        first = client.get("/api/library")
        etag = first.headers["ETag"]
        unchanged = client.get("/api/library", headers={"If-None-Match": etag})
        assert unchanged.status_code == 304
        assert unchanged.data == b""
        assert unchanged.headers["ETag"] == etag
        assert unchanged.headers["Cache-Control"] == "private, no-cache"
        assert "Cookie" in unchanged.vary
        assert "X-Soundsible-Admin-Token" in unchanged.vary
        # HTTP weak matching also accepts lists and the strong spelling.
        assert client.get("/api/library", headers={"If-None-Match": '"other", ' + etag[2:]}).status_code == 304
        assert client.get("/api/library", headers={"If-None-Match": '"unknown"'}).status_code == 200
    with user_context("bob"):
        other = client.get("/api/library", headers={"If-None-Match": etag})
        assert other.status_code == 200
        assert other.headers["ETag"] != etag
        assert other.get_json() == first.get_json()


@pytest.mark.parametrize("change", ["edit", "remove", "add", "order", "playlist", "settings", "subscription", "episodes", "artwork", "loudness"])
def test_revision_covers_all_public_snapshot_changes(revision_endpoint, change):
    client, lib, annotations, artwork = revision_endpoint
    etag = client.get("/api/library").headers["ETag"]
    model = lib.metadata
    if change == "edit": model.tracks[0].title = "Edited"
    elif change == "remove": model.tracks.pop()
    elif change == "add":
        added = deepcopy(model.tracks[0])
        added.id = "new"
        model.tracks.append(added)
    elif change == "order": model.tracks.reverse()
    elif change == "playlist": model.playlists["Favoritas"].clear()
    elif change == "settings": model.settings["nested"]["flags"].append(False)
    elif change == "subscription": model.podcast_subscriptions.clear()
    elif change == "episodes": model.podcast_episode_cache.clear()
    elif change == "artwork": artwork.bind("song", "new-revision-hash", "manual")
    elif change == "loudness": annotations["gain"] = -5
    changed = client.get("/api/library", headers={"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["ETag"] != etag
    assert client.get("/api/library", headers={"If-None-Match": changed.headers["ETag"]}).status_code == 304


def test_private_file_changes_do_not_invalidate_public_revision(revision_endpoint):
    client, lib, _, _ = revision_endpoint
    etag = client.get("/api/library").headers["ETag"]
    lib.metadata.tracks[0].local_path = "/different/private/file"
    lib.metadata.tracks[0].local_mtime_ns += 1
    assert client.get("/api/library", headers={"If-None-Match": etag}).status_code == 304
