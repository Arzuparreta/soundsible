"""Route-level integration tests for POST /api/discovery/save."""

import importlib
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

# Stub all heavy transitive deps that shared.api.__init__ pulls in.
# We load only shared.api.download_queue and shared.api.routes.discovery
# by pointing importlib at the .py files directly, bypassing __init__.
_STUBS = [
    "flask_socketio", "flask_cors",
    "watchdog", "watchdog.events", "watchdog.observers",
    "yt_dlp",
    "mutagen", "mutagen.mp3", "mutagen.id3",
    "requests",
    "player", "player.library", "player.queue_manager", "player.favourites_manager",
    "odst_tool", "odst_tool.odst_downloader", "odst_tool.cloud_sync",
    "odst_tool.optimize_library", "odst_tool.audio_utils",
    "setup_tool", "setup_tool.uploader", "setup_tool.provider_factory",
    "shared.api",  # prevent __init__ auto-execution when accessing submodules
]
for _m in _STUBS:
    if _m not in sys.modules:
        sys.modules[_m] = MagicMock()

# Load download_queue and discovery route directly from their .py files.
_ROOT = Path(__file__).resolve().parents[1]

def _load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, _ROOT / rel_path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod

_dq = _load_module("shared.api.download_queue", "shared/api/download_queue.py")
parse_intake_item = _dq.parse_intake_item

_disc_routes = _load_module("shared.api.routes.discovery", "shared/api/routes/discovery.py")
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
