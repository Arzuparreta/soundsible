from flask import Flask

from shared.api.routes import car as car_routes
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _track(track_id: str, title: str, *, artist: str = "Artist", album: str = "Album") -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        album=album,
        duration=180,
        file_hash=f"hash-{track_id}",
        original_filename=f"{track_id}.mp3",
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


class _FakeLibrary:
    def __init__(self, metadata):
        self.metadata = metadata

    def refresh_if_stale(self):
        return None

    def sync_library(self):
        return True


class _FakeFavourites:
    def __init__(self, ids):
        self._ids = ids

    def get_all(self):
        return list(self._ids)

    def get_entries(self):
        return [{"keys": [f"lib:{tid}"]} for tid in self._ids]


def _make_runtime(tmp_path):
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=True,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        path.mkdir(parents=True, exist_ok=True)


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(car_routes.car_bp)
    return app


def _patch_api(monkeypatch, metadata, *, favourites=None, playback_state=None):
    fake_lib = _FakeLibrary(metadata)
    by_id = {track.id: track for track in metadata.tracks}
    fake_favourites = _FakeFavourites(favourites or [])

    def fake_get_api():
        return {
            "get_core": lambda: (fake_lib, None, None),
            "get_track_by_id": lambda _lib, track_id: by_id.get(track_id),
            "get_playback_state": lambda _scope: playback_state,
            "get_scope_from_request": lambda: "default",
            "favourites_manager": fake_favourites,
            # Only favourites we hold a file for reach a head unit.
            "favourite_library_ids": lambda: [
                tid for tid in fake_favourites.get_all() if tid in by_id
            ],
        }

    monkeypatch.setattr(car_routes, "_get_api", fake_get_api)


def test_car_home_exposes_stable_root_collections(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "One"), _track("t2", "Two")],
        playlists={"Road": ["t1", "t2"]},
        settings={},
    )
    _patch_api(monkeypatch, metadata)

    response = _make_app().test_client().get("/api/car/home")

    assert response.status_code == 200
    body = response.get_json()
    ids = [item["id"] for item in body["items"]]
    assert ids == ["recently-played", "favourites", "playlists", "podcasts", "radio", "all-tracks"]
    assert body["items"][0]["is_browsable"] is True
    assert body["items"][0]["is_playable"] is False


def test_car_playlist_returns_playable_track_items(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "One"), _track("t2", "Two")],
        playlists={"Road": ["t2", "missing", "t1"]},
        settings={},
    )
    _patch_api(monkeypatch, metadata)

    response = _make_app().test_client().get("/api/car/items/playlist:Road")

    assert response.status_code == 200
    items = response.get_json()["items"]
    assert [item["track_id"] for item in items] == ["t2", "t1"]
    assert items[0]["stream_url"] == "/api/static/stream/t2"
    assert items[0]["artwork_url"] == "/api/static/cover/t2"
    assert items[0]["is_playable"] is True


def test_car_favourites_and_recently_played_use_existing_state(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "One"), _track("t2", "Two")],
        playlists={},
        settings={},
    )
    _patch_api(
        monkeypatch,
        metadata,
        favourites=["t2", "missing"],
        playback_state={"track_id": "t1", "position_sec": 42, "is_playing": True},
    )
    client = _make_app().test_client()

    favourites = client.get("/api/car/items/favourites")
    recent = client.get("/api/car/items/recently-played")

    assert favourites.status_code == 200
    assert [item["track_id"] for item in favourites.get_json()["items"]] == ["t2"]
    assert recent.status_code == 200
    recent_body = recent.get_json()
    assert recent_body["items"][0]["track_id"] == "t1"
    assert recent_body["playback_state"]["position_sec"] == 42


def test_a_head_unit_browses_the_newest_songs_first(tmp_path, monkeypatch):
    """`all-tracks` is cut to `MAX_CAR_ITEMS`. Cut straight from the manifest,
    which is stored oldest first, that list could never contain the song added
    this morning — the one most likely to be reached for from a car."""
    reset_runtime()
    _make_runtime(tmp_path)
    old = _track("t1", "Added in January")
    old.added_at = "2026-01-04T09:00:00"
    new = _track("t2", "Added today")
    new.added_at = "2026-08-17T10:06:52"
    metadata = LibraryMetadata(version=1, tracks=[old, new], playlists={}, settings={})
    _patch_api(monkeypatch, metadata)

    response = _make_app().test_client().get("/api/car/items/all-tracks")

    assert [item["track_id"] for item in response.get_json()["items"]] == ["t2", "t1"]


def test_car_acquired_podcast_retains_progress_identity(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    episode = _track("episode-file", "Downloaded episode")
    episode.media_kind = "podcast_episode"
    episode.podcast_feed_id = "private-feed"
    episode.podcast_episode_guid = "episode-guid"
    episode.local_path = "/private/music/episode.mp3"
    metadata = LibraryMetadata(version=1, tracks=[episode], playlists={}, settings={})
    _patch_api(monkeypatch, metadata)

    response = _make_app().test_client().get("/api/car/items/podcasts")

    assert response.status_code == 200
    item = response.get_json()["items"][0]
    assert item["kind"] == "podcast_episode"
    assert item["podcast_feed_id"] == "private-feed"
    assert item["podcast_episode_guid"] == "episode-guid"
    assert item["stream_url"] == "/api/static/stream/episode-file"
    assert "local_path" not in item


def test_car_radio_excludes_podcasts_before_applying_limit(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    episodes = [_track(f"podcast-{index:03d}", "Episode") for index in range(200)]
    for episode in episodes:
        episode.media_kind = "podcast_episode"
    music = _track("music", "Music seed")
    metadata = LibraryMetadata(version=1, tracks=[music, *episodes], playlists={}, settings={})
    _patch_api(monkeypatch, metadata)

    response = _make_app().test_client().get("/api/car/items/radio")

    assert response.status_code == 200
    assert [(item["track_id"], item["kind"]) for item in response.get_json()["items"]] == [("music", "radio_seed")]


def test_car_podcast_feed_browses_only_its_acquired_episodes(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    episode = _track("acquired", "Acquired episode")
    episode.media_kind = "podcast_episode"
    episode.podcast_feed_id = "feed / one"
    episode.podcast_episode_guid = "guid-one"
    other = _track("other", "Other episode")
    other.media_kind = "podcast_episode"
    other.podcast_feed_id = "other-feed"
    metadata = LibraryMetadata(version=1, tracks=[episode, other], playlists={}, settings={})
    metadata.podcast_subscriptions = [{"id": "feed / one", "title": "One"}, {"id": "empty", "title": "Empty"}]
    _patch_api(monkeypatch, metadata)
    client = _make_app().test_client()
    home = client.get("/api/car/items/podcasts").get_json()["items"]
    assert home[0]["id"] == "podcast:feed%20%2F%20one"
    response = client.get("/api/car/items/" + home[0]["id"])
    assert response.status_code == 200
    assert [item["track_id"] for item in response.get_json()["items"]] == ["acquired"]
    assert response.get_json()["items"][0]["podcast_episode_guid"] == "guid-one"
    assert client.get("/api/car/items/podcast:empty").get_json()["items"] == []
    assert client.get("/api/car/items/podcast:other-feed").status_code == 404


def test_car_search_matches_acquired_library_before_limiting(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    old = _track("found", "Canción antigua", artist="Única artista")
    old.added_at = "2020-01-01"
    new = [_track(f"other-{i}", "Unrelated") for i in range(210)]
    for track in new:
        track.added_at = "2026-01-01"
    metadata = LibraryMetadata(version=1, tracks=[old, *new], playlists={}, settings={})
    _patch_api(monkeypatch, metadata)
    client = _make_app().test_client()
    response = client.get("/api/car/search", query_string={"q": " CANCIÓN  única "})
    assert response.status_code == 200
    assert [item["track_id"] for item in response.get_json()["items"]] == ["found"]
    assert client.get("/api/car/search?q=unrelated").get_json()["items"][-1]["track_id"] == "other-199"
    assert client.get("/api/car/search?q=missing").get_json()["items"] == []
    assert client.get("/api/car/search?q=").status_code == 400
    assert client.get("/api/car/search", query_string={"q": "x" * 257}).status_code == 400


def test_large_car_collections_are_paged_without_changing_legacy_response(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(version=1, tracks=[], settings={},
        playlists={f"List {i}": [] for i in range(405)},
        podcast_subscriptions=[{"id": f"feed-{i}", "title": f"Show {i}"} for i in range(405)])
    _patch_api(monkeypatch, metadata)
    client = _make_app().test_client()
    for parent in ("playlists", "podcasts"):
        path = f"/api/car/items/{parent}"
        assert len(client.get(path).get_json()["items"]) == 405
        pages = [client.get(f"{path}?page={page}&page_size=200").get_json() for page in range(4)]
        assert [len(page["items"]) for page in pages] == [200, 200, 5, 0]
        assert all(page["total"] == 405 for page in pages)
        assert len({row["id"] for page in pages for row in page["items"]}) == 405
        for query in ("page=-1", "page=bad", "page_size=201", "page_size=0"):
            assert client.get(f"{path}?{query}").status_code == 400
