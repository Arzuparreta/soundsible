import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from flask import Flask

from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("catalog_routes_under_test", _ROOT / "shared/api/routes/catalog.py")
catalog_routes = importlib.util.module_from_spec(_SPEC)
sys.modules["catalog_routes_under_test"] = catalog_routes
_SPEC.loader.exec_module(catalog_routes)
catalog_bp = catalog_routes.catalog_bp


def _make_runtime(tmp_path) -> RuntimeConfig:
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
        advanced_mode=False,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)
    return runtime


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(catalog_bp)
    return app


class _FakeLibrary:
    def __init__(self, metadata):
        self.metadata = metadata

    def refresh_if_stale(self):
        return None


def _track(track_id: str, title: str, artist: str) -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        album="Album",
        duration=180,
        file_hash=f"hash-{track_id}",
        original_filename=f"{track_id}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
        youtube_id=f"yt{track_id}".ljust(11, "0")[:11],
    )


def _fake_api(metadata):
    queue = MagicMock()
    queue.is_processing = False
    queue.add.return_value = {"id": "q-1"}
    return {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "get_downloader": MagicMock(),
        "queue_manager_dl": queue,
        "start_downloader_pump": MagicMock(),
        "parse_intake_item": lambda item: ({**item, "output_dir": None}, None),
    }


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    catalog_routes._CATALOG_CACHE.clear()
    yield
    catalog_routes._CATALOG_CACHE.clear()
    reset_runtime()


def test_catalog_search_combines_local_deezer_and_sections(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track("local-1", "Rosalia Local", "Rosalia")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_search",
        lambda q, limit: [
            catalog_routes._catalog_item(
                item_id="deezer:track:10",
                item_type="track",
                source="deezer",
                title="Rosalia Global",
                subtitle="Rosalia",
                artist="Rosalia",
                external_ids={"deezer_id": "10"},
                popularity=900000,
            )
        ],
    )
    monkeypatch.setattr(catalog_routes, "_musicbrainz_search", lambda q, limit: [])

    body = _make_app().test_client().get("/api/catalog/search?q=rosalia").get_json()

    assert body["cached"] is False
    assert body["items"][0]["type"] == "artist"
    assert any(item["type"] == "library_track" for item in body["items"])
    assert any(item["id"] == "deezer:track:10" for item in body["items"])
    assert body["sections"][0]["id"] == "top"
    assert any(section["id"] == "songs" for section in body["sections"])


def test_catalog_search_returns_partial_failures(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_deezer_search", lambda q, limit: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(catalog_routes, "_musicbrainz_search", lambda q, limit: [])

    body = _make_app().test_client().get("/api/catalog/search?q=queen").get_json()

    assert body["items"] == []
    assert body["partial_failures"] == [{"source": "deezer", "error": "down"}]


def test_catalog_save_confirmed_video_queues_download(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    fake_api = _fake_api(metadata)
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: fake_api)

    res = _make_app().test_client().post(
        "/api/catalog/save",
        json={"artist": "Queen", "title": "Bohemian Rhapsody", "confirm_video_id": "abcdefghijk"},
    )

    body = res.get_json()
    assert res.status_code == 200
    assert body["status"] == "queued"
    assert body["video_id"] == "abcdefghijk"
    fake_api["queue_manager_dl"].add.assert_called_once()
    fake_api["start_downloader_pump"].assert_called_once()
