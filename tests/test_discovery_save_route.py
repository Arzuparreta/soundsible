"""Route-level integration tests for POST /api/discovery/save."""

import importlib
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

for _m in ("watchdog", "watchdog.events", "watchdog.observers"):
    try:
        importlib.import_module(_m)
    except ImportError:
        sys.modules[_m] = MagicMock()

# Load download_queue and discovery route directly from their .py files.
_ROOT = Path(__file__).resolve().parents[1]

def _load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, _ROOT / rel_path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod

_dq = _load_module("download_queue_under_test", "shared/api/download_queue.py")
parse_intake_item = _dq.parse_intake_item

_disc_routes = _load_module("discovery_routes_under_test", "shared/api/routes/discovery.py")
discovery_bp = _disc_routes.discovery_bp

import json
import uuid
from unittest.mock import patch

import pytest
from flask import Flask


def _fake_parse_intake(item: dict):
    """Minimal parse_intake_item stand-in that accepts ytmusic_search items."""
    video_id = (item.get("video_id") or "").strip()
    if not video_id:
        return None, "Missing video_id"
    return {
        "source_type": "ytmusic_search",
        "video_id": video_id,
        "display_title": item.get("display_title", ""),
        "display_artist": item.get("display_artist", ""),
        "thumbnail_url": item.get("thumbnail_url", ""),
        "duration_sec": item.get("duration_sec"),
        "metadata_evidence": item.get("metadata_evidence"),
        "output_dir": None,
    }, None
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import init_telemetry, reset_telemetry


# ─── Fixtures ────────────────────────────────────────────────────────────────

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
    for p in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        p.mkdir(parents=True, exist_ok=True)
    return runtime


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(discovery_bp)
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
    )


def _mock_api(search_results=None, queue_add_return=None, parse_fn=None):
    """Build a mock api dict wired into _get_api()."""
    mock_dl_service = MagicMock()
    mock_dl_service.downloader.search_youtube.return_value = search_results or []

    mock_qm = MagicMock()
    mock_qm.is_processing = False
    mock_qm.add.return_value = queue_add_return or {"id": "q-test-001"}

    return {
        "get_downloader": MagicMock(return_value=mock_dl_service),
        "queue_manager_dl": mock_qm,
        "start_downloader_pump": MagicMock(),
        "parse_intake_item": parse_fn or _fake_parse_intake,
        "get_core": MagicMock(),
        "_mod": MagicMock(),
    }


@pytest.fixture(autouse=True)
def _reset():
    reset_runtime()
    reset_telemetry()
    yield
    reset_telemetry()
    reset_runtime()


# ─── Validation tests ─────────────────────────────────────────────────────────

def test_save_missing_artist_returns_400(tmp_path):
    _make_runtime(tmp_path)
    client = _make_app().test_client()
    res = client.post("/api/discovery/save", json={"title": "Bohemian Rhapsody"})
    assert res.status_code == 400
    assert "required" in res.get_json().get("error", "").lower()


def test_save_missing_title_returns_400(tmp_path):
    _make_runtime(tmp_path)
    client = _make_app().test_client()
    res = client.post("/api/discovery/save", json={"artist": "Queen"})
    assert res.status_code == 400


def test_save_empty_body_returns_400(tmp_path):
    _make_runtime(tmp_path)
    client = _make_app().test_client()
    res = client.post("/api/discovery/save", json={})
    assert res.status_code == 400


def test_music_feed_without_taste_returns_seed_state_not_generic_rows(tmp_path):
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("local-1", "Local Song", "Local Artist")],
        playlists={},
        settings={},
    )

    with patch.object(_disc_routes, "_deezer_json", return_value={"data": []}):
        body = _disc_routes._build_music_feed(metadata, [], limit=12)

    assert body["needs_seed"] is True
    assert body["sections"] == []
    assert body["items"] == []


def test_music_feed_uses_taste_artist_before_generic_external(tmp_path):
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[
            _track("fav-1", "Favourite Song", "Taste Artist"),
            _track("other-1", "Other Song", "Other Artist"),
        ],
        playlists={"Daily": ["fav-1"]},
        settings={},
    )

    def fake_deezer(path, params=None, ttl_sec=0):
        if path == "search":
            return {
                "data": [
                    {
                        "id": 500,
                        "title": "Seed Search Result",
                        "artist": {"id": 77, "name": "Taste Artist"},
                        "album": {"title": "Seed Album"},
                    }
                ]
            }
        if path == "artist/77/top":
            return {
                "data": [
                    {
                        "id": 501,
                        "title": "Taste External",
                        "title_short": "Taste External",
                        "duration": 220,
                        "rank": 800000,
                        "artist": {"id": 77, "name": "Taste Artist"},
                        "album": {"title": "Taste Album", "cover_medium": "https://example.test/taste.jpg"},
                    }
                ]
            }
        return {"tracks": {"data": []}, "data": []}

    with patch.object(_disc_routes, "_deezer_json", side_effect=fake_deezer):
        body = _disc_routes._build_music_feed(metadata, ["fav-1"], limit=12)

    assert body["sections"][0]["id"] == "because_you_listen_taste_artist"
    first_id = body["sections"][0]["item_ids"][0]
    first_item = next(item for item in body["items"] if item["id"] == first_id)
    assert first_item["source"] == "deezer_taste_artist"
    assert first_item["title"] == "Taste External"


# ─── confirm_video_id path ────────────────────────────────────────────────────

def test_save_confirm_video_id_queues_directly(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    mock_api = _mock_api()

    with patch.object(_disc_routes, "_get_api", return_value=mock_api), \
         patch.object(_disc_routes, "emit_discovery_event") as mock_emit:
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen",
            "title": "Bohemian Rhapsody",
            "duration": 354,
            "deezer_id": "123456",
            "confirm_video_id": "abcdefghijk",
        })

    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "queued"
    assert body["queue_id"] == "q-test-001"
    assert body["video_id"] == "abcdefghijk"
    assert body["confidence_reason"] == "confirmed"
    mock_api["queue_manager_dl"].add.assert_called_once()
    mock_emit.assert_called_once_with(
        "music_saved_to_library",
        {
            "artist": "Queen",
            "title": "Bohemian Rhapsody",
            "deezer_id": "123456",
            "video_id": "abcdefghijk",
            "confidence": 1.0,
        },
    )


def test_save_confirm_video_id_starts_pump_when_idle(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["queue_manager_dl"].is_processing = False

    with patch.object(_disc_routes, "_get_api", return_value=mock_api), \
         patch.object(_disc_routes, "emit_discovery_event"):
        _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody",
            "confirm_video_id": "abcdefghijk",
        })

    mock_api["start_downloader_pump"].assert_called_once()


# ─── Cache-hit paths ──────────────────────────────────────────────────────────

def test_save_high_confidence_cache_hit_queues_without_search(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    db = DatabaseManager()
    db.set_cached_resolution("Queen", "Bohemian Rhapsody", {
        "id": "cachedvideo01",
        "confidence": 0.92,
        "confidence_reason": "title_artist_duration",
        "candidates": [],
    })

    mock_api = _mock_api()
    with patch.object(_disc_routes, "_get_api", return_value=mock_api), \
         patch.object(_disc_routes, "emit_discovery_event"):
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody",
        })

    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "queued"
    assert body["video_id"] == "cachedvideo01"
    # Search should NOT be called — cache was sufficient
    mock_api["get_downloader"].return_value.downloader.search_youtube.assert_not_called()


def test_save_medium_confidence_cache_hit_returns_needs_review(tmp_path):
    _make_runtime(tmp_path)
    db = DatabaseManager()
    candidates = [{"id": "v1", "title": "Bohemian Rhapsody", "channel": "Queen", "duration": 354, "confidence": 0.55}]
    db.set_cached_resolution("Queen", "Bohemian Rhapsody", {
        "id": "v1",
        "confidence": 0.55,
        "confidence_reason": "title_only",
        "candidates": candidates,
    })

    mock_api = _mock_api()
    with patch.object(_disc_routes, "_get_api", return_value=mock_api):
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody",
        })

    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "needs_review"
    assert body["confidence_level"] == "medium"
    assert isinstance(body["candidates"], list)


# ─── YouTube search paths ─────────────────────────────────────────────────────

def test_save_high_confidence_search_result_queues(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    search_results = [
        {"id": "newvideo1234", "title": "Bohemian Rhapsody", "channel": "Queen", "duration": 354}
    ]
    mock_api = _mock_api(search_results=search_results)

    with patch.object(_disc_routes, "_get_api", return_value=mock_api), \
         patch.object(_disc_routes, "emit_discovery_event") as mock_emit:
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen",
            "title": "Bohemian Rhapsody",
            "duration": 354,
        })

    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "queued"
    assert body["video_id"] == "newvideo1234"
    assert body["confidence"] >= 0.75
    mock_emit.assert_called_once()

    # Result must be cached
    db = DatabaseManager()
    cached = db.get_cached_resolution("Queen", "Bohemian Rhapsody")
    assert cached is not None
    assert cached["id"] == "newvideo1234"
    assert cached["confidence"] is not None


def test_save_medium_confidence_search_result_returns_candidates(tmp_path):
    _make_runtime(tmp_path)
    search_results = [
        {"id": "wrongvideo12", "title": "Completely Different Track", "channel": "Nobody", "duration": 200}
    ]
    mock_api = _mock_api(search_results=search_results)

    with patch.object(_disc_routes, "_get_api", return_value=mock_api):
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen",
            "title": "Bohemian Rhapsody",
            "duration": 354,
        })

    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "needs_review"
    assert "candidates" in body
    assert len(body["candidates"]) >= 1
    assert "best" in body


def test_save_empty_search_results_returns_not_found(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api(search_results=[])

    with patch.object(_disc_routes, "_get_api", return_value=mock_api):
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody",
        })

    assert res.status_code == 404
    body = res.get_json()
    assert body["status"] == "failed"
    assert body["reason"] == "not_found"

    # Failure must be cached to avoid repeated searches
    db = DatabaseManager()
    cached = db.get_cached_resolution("Queen", "Bohemian Rhapsody")
    assert cached is not None
    assert cached.get("failure_state") == "not_found"


def test_save_search_exception_returns_502(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_downloader"].return_value.downloader.search_youtube.side_effect = RuntimeError("network error")

    with patch.object(_disc_routes, "_get_api", return_value=mock_api):
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody",
        })

    assert res.status_code == 502
    body = res.get_json()
    assert body["status"] == "failed"
    assert body["reason"] == "search_error"


# ─── Discovery event emission ─────────────────────────────────────────────────

def test_save_does_not_emit_event_on_needs_review(tmp_path):
    _make_runtime(tmp_path)
    search_results = [
        {"id": "weakmatch1234", "title": "Something Else", "channel": "Unknown", "duration": 100}
    ]
    mock_api = _mock_api(search_results=search_results)

    with patch.object(_disc_routes, "_get_api", return_value=mock_api), \
         patch.object(_disc_routes, "emit_discovery_event") as mock_emit:
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody",
        })

    body = res.get_json()
    # Only emit on confirmed queuing, not on review prompt
    if body["status"] == "needs_review":
        mock_emit.assert_not_called()
    else:
        # High confidence — event should fire
        mock_emit.assert_called_once()


# ─── Response shape contract ──────────────────────────────────────────────────

def test_queued_response_has_required_fields(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    mock_api = _mock_api(search_results=[
        {"id": "abcdefghijk", "title": "Bohemian Rhapsody", "channel": "Queen", "duration": 354}
    ])

    with patch.object(_disc_routes, "_get_api", return_value=mock_api), \
         patch.object(_disc_routes, "emit_discovery_event"):
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody", "duration": 354,
        })

    body = res.get_json()
    if body["status"] == "queued":
        assert "queue_id" in body
        assert "video_id" in body
        assert "confidence" in body
        assert "confidence_level" in body
        assert "confidence_reason" in body


def test_needs_review_response_has_required_fields(tmp_path):
    _make_runtime(tmp_path)
    db = DatabaseManager()
    db.set_cached_resolution("Queen", "Bohemian Rhapsody", {
        "id": "v1", "confidence": 0.50, "confidence_reason": "title_only",
        "candidates": [{"id": "v1", "title": "Bohemian Rhapsody", "channel": "Cover Band", "duration": 354}],
    })
    mock_api = _mock_api()

    with patch.object(_disc_routes, "_get_api", return_value=mock_api):
        res = _make_app().test_client().post("/api/discovery/save", json={
            "artist": "Queen", "title": "Bohemian Rhapsody",
        })

    body = res.get_json()
    assert body["status"] == "needs_review"
    assert "confidence" in body
    assert "confidence_level" in body
    assert "candidates" in body
    assert "best" in body
    assert isinstance(body["candidates"], list)


# ─── Music feed ───────────────────────────────────────────────────────────────

class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def test_music_feed_includes_taste_based_external_tracks_and_local_recs(tmp_path):
    _make_runtime(tmp_path)
    _disc_routes._MUSIC_FEED_CACHE.clear()
    _disc_routes._DEEZER_JSON_CACHE.clear()

    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Local Song", "Local Artist")],
        playlists={},
        settings={},
    )
    fav = MagicMock()
    fav.get_all.return_value = ["t1"]
    mod = MagicMock()
    mod.favourites_manager = fav
    api = {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "_mod": mod,
    }

    def fake_get(url, params=None, timeout=None, headers=None):
        if url.endswith("/search"):
            return _FakeResponse({
                "data": [
                    {
                        "id": 100,
                        "title": "Seed Song",
                        "artist": {"id": 77, "name": "Local Artist"},
                        "album": {"title": "Seed Album"},
                    }
                ]
            })
        if url.endswith("/artist/77/top"):
            return _FakeResponse({
                "data": [
                    {
                        "id": 101,
                        "title": "Taste Match",
                        "title_short": "Taste Match",
                        "duration": 201,
                        "rank": 999,
                        "artist": {"id": 77, "name": "Local Artist"},
                        "album": {"title": "Taste Album", "cover_big": "https://example.test/new.jpg"},
                    }
                ]
            })
        raise AssertionError(url)

    with patch.object(_disc_routes, "_get_api", return_value=api), \
         patch.object(_disc_routes.requests, "get", side_effect=fake_get):
        res = _make_app().test_client().get("/api/discovery/music/feed?limit=12")

    assert res.status_code == 200
    body = res.get_json()
    assert body["cached"] is False
    assert any(s["id"] == "made_for_your_library" for s in body["sections"])
    assert body["sections"][0]["id"] == "because_you_listen_local_artist"
    assert any(item["id"] == "deezer:101" for item in body["items"])
    external = next(item for item in body["items"] if item["id"] == "deezer:101")
    assert external["action_state"]["needs_resolution"] is True


def test_music_feed_uses_cache_when_fresh(tmp_path):
    _make_runtime(tmp_path)
    _disc_routes._MUSIC_FEED_CACHE.clear()
    _disc_routes._DEEZER_JSON_CACHE.clear()

    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    mod = MagicMock()
    mod.favourites_manager = MagicMock()
    mod.favourites_manager.get_all.return_value = []
    api = {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "_mod": mod,
    }

    with patch.object(_disc_routes, "_get_api", return_value=api), \
         patch.object(_disc_routes.requests, "get", return_value=_FakeResponse({"tracks": {"data": []}})):
        first = _make_app().test_client().get("/api/discovery/music/feed?limit=12")
        second = _make_app().test_client().get("/api/discovery/music/feed?limit=12")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json()["cached"] is False
    assert second.get_json()["cached"] is True
