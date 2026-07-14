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
    catalog_routes._ARTIST_CACHE.clear()
    catalog_routes._ALBUM_CACHE.clear()
    yield
    catalog_routes._CATALOG_CACHE.clear()
    catalog_routes._ARTIST_CACHE.clear()
    catalog_routes._ALBUM_CACHE.clear()
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


def test_resolve_candidates_warms_preview_stream_cache_for_best_id(monkeypatch, tmp_path):
    """Opción D: after catalog resolve selects a best video id, it pre-warms
    the playback route's in-process stream URL cache so the upcoming preview
    click never pays a second yt-dlp resolution."""
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    fake_api = _fake_api(metadata)
    fake_dl = MagicMock()
    fake_dl.downloader.search_youtube.return_value = [
        {
            "id": "abcdefghijk",
            "title": "Bohemian Rhapsody",
            "duration": 354,
            "thumbnail": "https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg",
            "webpage_url": "https://www.youtube.com/watch?v=abcdefghijk",
            "channel": "Queen",
            "artist": "Queen",
        }
    ]
    fake_dl.downloader.get_stream_url.return_value = "https://rr.googlevideo.com/warmed-url"
    fake_api["get_downloader"] = MagicMock(return_value=fake_dl)
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: fake_api)

    warm_calls = []

    def fake_warm(video_id, url, ttl_sec=None):
        warm_calls.append((video_id, url))

    monkeypatch.setattr(
        "shared.api.routes.playback.warm_preview_stream_cache",
        fake_warm,
    )

    best, ranked = catalog_routes._resolve_candidates("Queen", "Bohemian Rhapsody", 354)

    assert best["id"] == "abcdefghijk"
    assert best["confidence"] > 0
    fake_dl.downloader.get_stream_url.assert_called_once_with("abcdefghijk")
    assert warm_calls == [("abcdefghijk", "https://rr.googlevideo.com/warmed-url")]


def test_resolve_candidates_skips_warm_on_db_cache_hit(monkeypatch, tmp_path):
    """When resolution is already cached in the DB, the resolve short-circuits
    and must NOT trigger an extra yt-dlp call — the warm is a cold-path-only
    optimization. The first click falls back to the playback cold path, which
    is fine and self-warms on its own."""
    fake_db = MagicMock()
    cached_row = {
        "id": "cachedvideo_01",
        "title": "Cached Track",
        "duration": 200,
        "thumbnail": "https://example.test/x.jpg",
        "webpage_url": "https://www.youtube.com/watch?v=cachedvideo_01",
        "channel": "Artist",
        "confidence": 0.9,
        "confidence_reason": "title",
        "candidates": [],
    }
    fake_db.get_cached_resolution.return_value = cached_row
    monkeypatch.setattr(catalog_routes, "DatabaseManager", lambda: fake_db)

    fake_api = _fake_api(LibraryMetadata(version=1, tracks=[], playlists={}, settings={}))
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: fake_api)

    best, ranked = catalog_routes._resolve_candidates("Artist", "Cached Track", 200)

    assert best["id"] == "cachedvideo_01"
    fake_api["get_downloader"].assert_not_called()


# ── Artist & Album profile endpoint tests ──────────────────────────────────


def _track_full(track_id: str, title: str, artist: str, album: str = "Album") -> Track:
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
        youtube_id=f"yt{track_id}".ljust(11, "0")[:11],
    )


def _mock_deezer_artist_top(artist_id, limit=50, library_keys=None):
    return [
        catalog_routes._catalog_item(
            item_id="deezer:track:101",
            item_type="track",
            source="deezer",
            title="Gecko",
            subtitle="Oliver Heldens",
            artist="Oliver Heldens",
            external_ids={"deezer_id": "101"},
            popularity=800000,
        ),
    ]


def _mock_deezer_artist_albums(artist_id, album_type="album", limit=50):
    return [
        {"deezer_id": "201", "title": "Heldeep Sessions", "cover": "http://x/201.jpg", "year": 2020, "track_count": 12},
    ]


def _mock_deezer_related(artist_id, limit=20):
    return [
        {"deezer_id": "301", "name": "Tchami", "picture": "http://x/301.jpg", "nb_fans": 500000},
    ]


def _mock_deezer_artist_profile(artist_id):
    return {"name": "Oliver Heldens", "picture": "http://x/oh.jpg", "nb_fans": 1200000}


def _mock_resolve_artist_id(name, deezer_id=None):
    if deezer_id:
        return deezer_id, []
    return "27", []


def _mock_resolve_artist_id_ambiguous(name, deezer_id=None):
    if deezer_id:
        return deezer_id, []
    return "27", [
        {"deezer_id": "99", "name": "Nirvana", "picture": "", "nb_fans": 100, "nb_album": 2},
    ]


def test_artist_endpoint_with_deezer_id(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_albums", _mock_deezer_artist_albums)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens&deezer_id=27").get_json()

    assert body["resolved"] is True
    assert body["deezer_id"] == "27"
    assert body["metadata"]["name"] == "Oliver Heldens"
    assert body["metadata"]["nb_fans"] == 1200000
    assert len(body["top_tracks"]) == 1
    assert body["top_tracks"][0]["title"] == "Gecko"
    assert len(body["albums"]) == 1
    assert len(body["related_artists"]) == 1
    assert body["related_artists"][0]["name"] == "Tchami"
    assert body["in_library"] is False
    assert body["cached"] is False


def test_artist_endpoint_by_name_only(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_albums", _mock_deezer_artist_albums)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body["resolved"] is True
    assert body["deezer_id"] == "27"
    assert body["candidates"] == []


def test_artist_endpoint_ambiguous_name(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id_ambiguous)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_albums", _mock_deezer_artist_albums)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Nirvana").get_json()

    assert body["resolved"] is True
    assert body["deezer_id"] == "27"
    assert len(body["candidates"]) == 1
    assert body["candidates"][0]["deezer_id"] == "99"


def test_artist_endpoint_not_in_deezer(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track_full("local-1", "Local Song", "Obscure Artist")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", lambda name, deezer_id=None: (None, []))
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)

    body = _make_app().test_client().get("/api/catalog/artist?name=Obscure+Artist").get_json()

    assert body["resolved"] is False
    assert body["deezer_id"] is None
    assert body["top_tracks"] == []
    assert body["in_library"] is True
    assert len(body["library_tracks"]) == 1
    assert body["library_tracks"][0]["title"] == "Local Song"


def test_artist_endpoint_caching(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_albums", _mock_deezer_artist_albums)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    client = _make_app().test_client()
    body1 = client.get("/api/catalog/artist?name=Oliver+Heldens").get_json()
    body2 = client.get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body1["cached"] is False
    assert body2["cached"] is True


def test_artist_endpoint_in_library_badge(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track_full("local-1", "Gecko", "Oliver Heldens")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)

    def top_with_library(artist_id, limit=50, library_keys=None):
        item = catalog_routes._catalog_item(
            item_id="deezer:track:101",
            item_type="track",
            source="deezer",
            title="Gecko",
            subtitle="Oliver Heldens",
            artist="Oliver Heldens",
            external_ids={"deezer_id": "101"},
            in_library=("oliver heldens\x00gecko" in (library_keys or set())),
        )
        return [item]

    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", top_with_library)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_albums", _mock_deezer_artist_albums)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body["in_library"] is True
    assert len(body["library_tracks"]) == 1
    assert body["top_tracks"][0]["title"] == "Gecko"
    assert body["top_tracks"][0]["action_state"]["in_library"] is True


def test_album_endpoint_with_deezer_id(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))

    def mock_album_profile(album_id, library_keys=None):
        return {
            "title": "Heldeep Sessions",
            "artist": "Oliver Heldens",
            "cover": "http://x/201.jpg",
            "year": 2020,
            "genre": "Electronic",
            "tracklist": [
                catalog_routes._catalog_item(
                    item_id="deezer:track:201",
                    item_type="track",
                    source="deezer",
                    title="Track One",
                    subtitle="Oliver Heldens",
                    artist="Oliver Heldens",
                    external_ids={"deezer_id": "201"},
                ),
            ],
        }

    monkeypatch.setattr(catalog_routes, "_deezer_album_profile", mock_album_profile)

    body = _make_app().test_client().get("/api/catalog/album?name=Heldeep+Sessions&deezer_id=201&artist=Oliver+Heldens").get_json()

    assert body["resolved"] is True
    assert body["title"] == "Heldeep Sessions"
    assert body["artist"] == "Oliver Heldens"
    assert body["year"] == 2020
    assert body["genre"] == "Electronic"
    assert len(body["tracklist"]) == 1
    assert body["tracklist"][0]["title"] == "Track One"


def test_album_endpoint_by_name(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_album_deezer_id", lambda name, artist: "201")

    def mock_album_profile(album_id, library_keys=None):
        return {
            "title": "Heldeep Sessions",
            "artist": "Oliver Heldens",
            "cover": "http://x/201.jpg",
            "year": 2020,
            "genre": "",
            "tracklist": [],
        }

    monkeypatch.setattr(catalog_routes, "_deezer_album_profile", mock_album_profile)

    body = _make_app().test_client().get("/api/catalog/album?name=Heldeep+Sessions&artist=Oliver+Heldens").get_json()

    assert body["resolved"] is True
    assert body["title"] == "Heldeep Sessions"


def test_album_endpoint_not_in_deezer(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track_full("local-1", "Local Track", "Oliver Heldens", "Local Album")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_album_deezer_id", lambda name, artist: None)

    body = _make_app().test_client().get("/api/catalog/album?name=Local+Album&artist=Oliver+Heldens").get_json()

    assert body["resolved"] is False
    assert body["in_library"] is True
    assert len(body["library_tracks"]) == 1
    assert body["library_tracks"][0]["title"] == "Local Track"
