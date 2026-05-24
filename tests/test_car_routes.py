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
        compressed=False,
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

    def fake_get_api():
        return {
            "get_core": lambda: (fake_lib, None, None),
            "get_track_by_id": lambda _lib, track_id: by_id.get(track_id),
            "get_playback_state": lambda _scope: playback_state,
            "get_scope_from_request": lambda: "default",
            "favourites_manager": _FakeFavourites(favourites or []),
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
