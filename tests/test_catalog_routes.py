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
        "user_id": "testuser",
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
    monkeypatch.setattr(catalog_routes, "instance_db", lambda: fake_db)

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


def _mock_deezer_artist_releases(artist_id, limit=100):
    return {
        "albums": [
            {"deezer_id": "201", "title": "Heldeep Sessions", "cover": "http://x/201.jpg", "year": 2020, "record_type": "album"},
        ],
        "singles_eps": [
            {"deezer_id": "202", "title": "Gecko", "cover": "http://x/202.jpg", "year": 2014, "record_type": "single"},
        ],
    }


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
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
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
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
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
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
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
    assert body["albums"] == []
    assert body["singles_eps"] == []
    assert body["in_library"] is True


def test_artist_endpoint_caching(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
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
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body["in_library"] is True
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
    assert body["tracklist"] == []


# ──────────────────────────────────────────────────────────────────────────
# Regressions: Deezer release partitioning, greenlet failures, cache bounds
# ──────────────────────────────────────────────────────────────────────────


def _deezer_album_row(album_id: str, title: str, record_type: str, release_date: str = "2020-01-01"):
    """A row shaped like a real artist/<id>/albums entry.

    Deliberately has no `nb_tracks` key, because the live endpoint does not
    return one — that absence is what made the old `track_count` always 0.
    """
    return {
        "id": album_id,
        "title": title,
        "record_type": record_type,
        "release_date": release_date,
        "cover_xl": f"http://x/{album_id}.jpg",
        "explicit_lyrics": False,
    }


def test_artist_releases_partition_by_record_type(monkeypatch):
    """Deezer ignores the `type` argument on artist/<id>/albums: every value
    returns the same mixed rows. Partitioning must come from record_type, and
    the fetch must happen exactly once rather than per rail."""
    calls = []

    def fake_get(path, params=None, timeout=8):
        calls.append((path, dict(params or {})))
        return {
            "data": [
                _deezer_album_row("1", "Real Album", "album"),
                _deezer_album_row("2", "A Single", "single"),
                _deezer_album_row("3", "An EP", "ep"),
                _deezer_album_row("4", "Another Album", "album"),
            ]
        }

    monkeypatch.setattr(catalog_routes, "_deezer_get", fake_get)

    out = catalog_routes._deezer_artist_releases("27")

    assert [a["title"] for a in out["albums"]] == ["Real Album", "Another Album"]
    assert [s["title"] for s in out["singles_eps"]] == ["A Single", "An EP"]
    assert len(calls) == 1, "releases must be fetched once, not once per rail"
    assert "type" not in calls[0][1], "Deezer ignores `type`; sending it implies a filter that does not exist"


def test_artist_releases_treats_unknown_record_type_as_album(monkeypatch):
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_get",
        lambda path, params=None, timeout=8: {"data": [_deezer_album_row("9", "Odd One", "compilation")]},
    )

    out = catalog_routes._deezer_artist_releases("27")

    assert [a["title"] for a in out["albums"]] == ["Odd One"]
    assert out["singles_eps"] == []


def test_artist_releases_omit_track_count(monkeypatch):
    """artist/<id>/albums carries no nb_tracks, so no track_count is emitted
    rather than a hardcoded 0 that the UI would render as a blank count."""
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_get",
        lambda path, params=None, timeout=8: {"data": [_deezer_album_row("1", "Real Album", "album")]},
    )

    album = catalog_routes._deezer_artist_releases("27")["albums"][0]

    assert "track_count" not in album
    assert album["year"] == 2020
    assert album["record_type"] == "album"


def test_artist_endpoint_reports_failing_fetch_instead_of_null(monkeypatch):
    """A fetch that raises must surface in partial_failures and leave the rail
    an empty list. Reading greenlet .value swallowed the error and emitted null."""
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    def boom(artist_id, limit=100):
        raise RuntimeError("deezer 503")

    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", boom)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body["albums"] == []
    assert body["singles_eps"] == []
    assert body["albums"] is not None and body["singles_eps"] is not None
    assert {"source": "deezer", "error": "deezer 503"} in body["partial_failures"]
    # An unrelated rail still resolves.
    assert body["top_tracks"][0]["title"] == "Gecko"


def test_gather_reports_timed_out_job(monkeypatch):
    """A greenlet still running at the deadline leaves both .value and
    .exception unset, so it must be reported from .successful()."""
    pytest.importorskip("gevent")
    import gevent

    monkeypatch.setattr(catalog_routes, "_DEEZER_FANOUT_TIMEOUT_SEC", 0.05)
    failures = []

    def slow():
        gevent.sleep(5)
        return ["never"]

    results = catalog_routes._gather((("slow", slow), ("fast", lambda: ["ok"])), failures)

    assert results.get("fast") == ["ok"]
    assert "slow" not in results
    assert failures == [{"source": "deezer", "error": "timed out"}]


def test_cache_put_evicts_expired_and_caps_size(monkeypatch):
    cache = {}
    monkeypatch.setattr(catalog_routes, "_CACHE_MAX_ENTRIES", 3)

    catalog_routes._cache_put(cache, "stale", -1, {"v": "stale"})
    assert catalog_routes._cache_get(cache, "stale") is None

    for i in range(10):
        catalog_routes._cache_put(cache, f"k{i}", 600, {"v": i})

    assert len(cache) <= 3
    assert "stale" not in cache
    assert catalog_routes._cache_get(cache, "k9") == {"v": 9}


def test_cache_get_drops_expired_entry():
    cache = {}
    catalog_routes._cache_put(cache, "k", -1, {"v": 1})
    assert catalog_routes._cache_get(cache, "k") is None
    assert "k" not in cache, "expired entry should not linger after a read"


def test_cached_body_is_isolated_from_caller_mutation():
    cache = {}
    catalog_routes._cache_put(cache, "k", 600, {"v": 1})
    first = catalog_routes._cache_get(cache, "k")
    first["v"] = "mutated"
    assert catalog_routes._cache_get(cache, "k") == {"v": 1}


def test_resolve_artist_id_returns_other_exact_matches_as_candidates(monkeypatch):
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_artist_search",
        lambda name, limit=10: [
            {"deezer_id": "1", "name": "Nirvana", "picture": "", "nb_fans": 10, "nb_album": 1},
            {"deezer_id": "2", "name": "Nirvana", "picture": "", "nb_fans": 900, "nb_album": 2},
            {"deezer_id": "3", "name": "Nirvana UK", "picture": "", "nb_fans": 5, "nb_album": 1},
        ],
    )

    resolved, candidates = catalog_routes._resolve_artist_id("Nirvana")

    assert resolved == "2", "most-followed exact match wins"
    assert [c["deezer_id"] for c in candidates] == ["1"]
