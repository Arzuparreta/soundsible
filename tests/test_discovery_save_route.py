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

# Imported normally: the route modules no longer drag `shared.api` in at import
# time, so the load-by-path shim these used is unnecessary — and it would give
# each module its own copy of the shared blueprint.
import shared.api.routes.discovery as _disc_routes
import shared.api.routes.auto_mode as _auto_mode
import shared.api.routes.discovery_feed as _disc_feed
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
from shared.database import instance_db
from shared.providers import deezer
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import init_telemetry, reset_telemetry


@pytest.fixture(autouse=True)
def isolated_request_budgets():
    # Every test creates its own runtime, but HTTP budgets live in process
    # memory. The compatibility matrix must not spend later tests' budgets.
    from shared.hardening import _reset_rate_limits_for_tests

    _reset_rate_limits_for_tests()
    yield
    _reset_rate_limits_for_tests()


@pytest.fixture(autouse=True)
def no_speculative_network(monkeypatch):
    # Route tests isolate providers. Acquisition itself has integration coverage
    # in test_dj_pool; no daemon may outlive this test's disposable runtime.
    monkeypatch.setattr("shared.preview_cache.request_prefetch", lambda *a, **kw: [])


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
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


def _mock_api(search_results=None, queue_add_return=None, parse_fn=None):
    """Build a mock api dict wired into _get_api()."""
    mock_dl_service = MagicMock()
    mock_dl_service.downloader.search_match_candidates.return_value = search_results or []

    mock_qm = MagicMock()
    mock_qm.is_processing = False
    mock_qm.add.return_value = queue_add_return or {"id": "q-test-001"}

    return {
        "get_downloader": MagicMock(return_value=mock_dl_service),
        "user_id": "testuser",
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


def test_music_plan_validates_intent_profile_and_seed(tmp_path):
    _make_runtime(tmp_path)
    client = _make_app().test_client()

    assert client.post("/api/discovery/music/plan", json={}).status_code == 400
    assert client.post(
        "/api/discovery/music/plan",
        json={"intent": "search", "seed": {"title": "Song"}},
    ).status_code == 400
    assert client.post(
        "/api/discovery/music/plan",
        json={"intent": "auto_mode", "profile": "chaos", "seed": {"title": "Song"}},
    ).status_code == 400
    assert client.post(
        "/api/discovery/music/plan",
        json={"intent": "radio", "seed": {"title": "Song"}},
    ).status_code == 400


def test_dj_plan_requires_seed_even_with_a_legacy_profile(tmp_path):
    _make_runtime(tmp_path)
    client = _make_app().test_client()
    assert client.post("/api/discovery/music/dj-plan", json={}).status_code == 400
    assert client.post(
        "/api/discovery/music/dj-plan",
        json={"dj_profile": "mystery"},
    ).status_code == 400


def test_dj_plan_eventually_places_an_exact_request_and_prefers_it_next(tmp_path):
    _make_runtime(tmp_path)
    base_items = [
        {
            "id": f"bridge0000{i}",
            "youtube_id": f"bridge0000{i}",
            "title": f"Bridge {i}",
            "artist": "Bridge Artist",
            "duration": 180,
            "source": "preview",
            "source_pool": "related",
            "recommendation_identity": f"music:youtube:bridge0000{i}",
            "recommendation_source": "auto_mode",
            "score": 0.6,
        }
        for i in range(4)
    ]
    base = {
        "v": 1,
        "plan_id": "base-plan",
        "intent": "auto_mode",
        "profile": "balanced",
        "seed_identity": "seed",
        "items": base_items,
        "degraded": False,
        "pool_counts": {"local": 0, "related": 4, "discovery": 0},
        "generated_at": 1,
    }
    features = {
        "duration": 180,
        "bpm": 120,
        "key": "C",
        "mode": "major",
        "confidence": 0.9,
        "outro_cue": 130,
        "intro_cue": 8,
        "bar_seconds": 2,
    }
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (_FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None)
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_build_music_plan", return_value=(base, 200)),
        patch.object(_auto_mode, "_dj_item_analysis", return_value=features),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                "dj_profile": "adaptive",
                "seed": {"id": "seed", "title": "Seed", "artist": "Artist", "duration": 180},
                "requests": [{
                    "id": "request-1",
                    "track": {
                        "id": "request0001",
                        "title": "Requested",
                        "artist": "Listener",
                        "duration": 200,
                    },
                }],
                "limit": 8,
            },
        )
    assert response.status_code == 200
    body = response.get_json()
    request_index = next(index for index, row in enumerate(body["items"]) if row.get("request_id") == "request-1")
    assert request_index <= 4
    assert body["requests"][0]["eta_tracks"] == request_index + 1
    assert body["requests"][0]["scheduled_position"] == request_index + 2
    assert body["requests"][0]["preferred_position"] == 2
    assert body["requests"][0]["max_position"] == 6
    assert all(row.get("transition") for row in body["items"])


def test_dj_plan_keeps_an_artist_request_until_a_playable_track_fulfils_it(tmp_path):
    _make_runtime(tmp_path)
    base = {
        "v": 1,
        "plan_id": "base-plan",
        "intent": "auto_mode",
        "profile": "balanced",
        "seed_identity": "seed",
        "items": [],
        "degraded": False,
        "pool_counts": {"local": 0, "related": 0, "discovery": 0},
        "generated_at": 1,
    }
    target = {
        "id": "heldens001",
        "youtube_id": "heldens001",
        "title": "Gecko",
        "artist": "Oliver Heldens",
        "duration": 165,
        "source": "preview",
        "source_pool": "related",
        "recommendation_identity": "music:youtube:heldens001",
        "recommendation_source": "auto_mode",
        "score": 0.9,
    }
    features = {
        "duration": 180,
        "bpm": 126,
        "key": "C",
        "mode": "major",
        "confidence": 0.9,
        "outro_cue": 130,
        "intro_cue": 8,
        "bar_seconds": 1.9,
    }
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_build_music_plan", return_value=(base, 200)),
        patch.object(_auto_mode, "_planner_artist_candidates", return_value=[target]),
        patch.object(_auto_mode, "_dj_item_analysis", return_value=features),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                "dj_profile": "adaptive",
                "seed": {"id": "seed", "title": "Seed", "artist": "Artist", "duration": 180},
                "requests": [{
                    "id": "artist-request",
                    "kind": "artist",
                    "label": "Oliver Heldens",
                    "artist": {"name": "Oliver Heldens"},
                }],
                "limit": 8,
            },
        )

    assert response.status_code == 200
    body = response.get_json()
    assert body["v"] == 4
    assert body["items"][0]["artist"] == "Oliver Heldens"
    assert body["items"][0]["request_id"] == "artist-request"
    assert body["requests"][0]["kind"] == "artist"
    assert body["requests"][0]["status"] == "planned"


def test_auto_library_pool_only_promotes_tracks_inside_the_session_path(tmp_path):
    _make_runtime(tmp_path)
    techno = _track("techno-local", "Warehouse", "Techno Artist")
    techno.youtube_id = "technovid01"
    chant = _track("chant-favourite", "Aestimatus sum", "Lumen Valo")
    chant.youtube_id = "chantvid001"
    metadata = LibraryMetadata(
        version=1,
        tracks=[techno, chant],
        playlists={},
        settings={},
    )
    related = [{
        "id": "technovid01",
        "youtube_id": "technovid01",
        "title": "Warehouse",
        "artist": "Techno Artist",
        "source": "preview",
        "source_pool": "related",
        "recommendation_identity": "music:youtube:technovid01",
        "score": 0.8,
        "semantic_score": 0.9,
    }]

    with (
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk(related, False, False)),
        patch.object(_auto_mode, "_planner_related_artist_pool", return_value=([], [])),
    ):
        pools, degraded = _disc_routes._build_auto_pools(
            metadata,
            [{"title": "Seed", "artist": "Techno Artist", "youtube_id": "seedvideo01"}],
            favourite_ids={"chant-favourite"},
            user_id="listener",
        )

    assert degraded is False
    assert [item["track_id"] for item in pools["local"]] == ["techno-local"]
    assert pools["related"] == []
    assert all(item["title"] != "Aestimatus sum" for item in pools["local"])


def test_music_plan_returns_server_ordered_playable_radio_items(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    seed = _track("seed-track", "Seed Song", "Seed Artist")
    seed.youtube_id = "seed0000001"
    metadata = LibraryMetadata(version=1, tracks=[seed], playlists={}, settings={})
    related = [
        {
            "id": f"video00000{i}",
            "title": f"Related {i}",
            "channel": f"Artist {i}",
            "duration": 180,
            "thumbnail": "",
        }
        for i in range(1, 9)
    ]
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (_FakeLibrary(metadata), None, None)
    mock_api["_mod"].favourite_library_ids.return_value = []
    mock_api["get_downloader"].return_value.downloader.get_related_videos.return_value = related

    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(
            _auto_mode,
            "_build_discovery_feed_body",
            side_effect=RuntimeError("discovery unavailable"),
        ),
    ):
        res = _make_app().test_client().post(
            "/api/discovery/music/plan",
            json={
                "intent": "radio",
                "seed": {
                    "track_id": seed.id,
                    "youtube_id": seed.youtube_id,
                    "title": seed.title,
                    "artist": seed.artist,
                },
                "exclude": ["music:youtube:video000001"],
                "limit": 6,
            },
        )

    assert res.status_code == 200
    body = res.get_json()
    assert body["intent"] == "radio"
    assert body["plan_id"]
    assert body["degraded"] is True
    assert len(body["items"]) == 6
    assert all(item["source_pool"] == "related" for item in body["items"])
    assert all(item["source"] == "preview" for item in body["items"])
    assert "video000001" not in [item["id"] for item in body["items"]]
    mock_api["get_downloader"].return_value.downloader.get_related_videos.assert_called_once()


def test_music_feed_without_taste_returns_seed_state_not_generic_rows(tmp_path):
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("local-1", "Local Song", "Local Artist")],
        playlists={},
        settings={},
    )

    with patch.object(_disc_feed, "_deezer_json", return_value={"data": []}):
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
        if path == "search/artist":
            return {"data": [{"id": 77, "name": "Taste Artist"}]}
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

    with patch.object(_disc_feed, "_deezer_json", side_effect=fake_deezer):
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
    db = instance_db()
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
    mock_api["get_downloader"].return_value.downloader.search_match_candidates.assert_not_called()


def test_save_medium_confidence_cache_hit_returns_needs_review(tmp_path):
    _make_runtime(tmp_path)
    db = instance_db()
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
    db = instance_db()
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
    db = instance_db()
    cached = db.get_cached_resolution("Queen", "Bohemian Rhapsody")
    assert cached is not None
    assert cached.get("failure_state") == "not_found"


def test_save_search_exception_returns_502(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_downloader"].return_value.downloader.search_match_candidates.side_effect = RuntimeError("network error")

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
    db = instance_db()
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


def test_enriched_music_feed_includes_taste_based_external_tracks_and_local_recs(tmp_path):
    _make_runtime(tmp_path)
    _disc_routes._DISCOVERY_FEED_CACHE.clear()
    deezer.clear_cache()

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
    mod.favourite_library_ids.return_value = ["t1"]
    api = {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "_mod": mod,
    }

    def fake_get(url, params=None, timeout=None, headers=None):
        if url.endswith("/search/artist"):
            return _FakeResponse({"data": [{"id": 77, "name": "Local Artist"}]})
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
                    },
                    {
                        "id": 102,
                        "title": "Second Taste Match",
                        "title_short": "Second Taste Match",
                        "duration": 198,
                        "rank": 900,
                        "artist": {"id": 77, "name": "Local Artist"},
                        "album": {"title": "Taste Album", "cover_big": "https://example.test/second.jpg"},
                    }
                ]
            })
        raise AssertionError(url)

    with patch.object(_disc_feed, "_get_api", return_value=api), \
         patch.object(deezer, "session", return_value=MagicMock(get=MagicMock(side_effect=fake_get))):
        body = _disc_routes._build_discovery_feed_body(12, include_external=True)

    assert any(s["id"] == "made_for_your_library" for s in body["sections"])
    assert any(s["id"] == "because_you_listen_local_artist" for s in body["sections"])
    assert any(item["id"] == "deezer:101" for item in body["items"])
    external = next(item for item in body["items"] if item["id"] == "deezer:101")
    assert external["action_state"]["needs_resolution"] is True


def test_music_feed_uses_cache_when_fresh(tmp_path):
    _make_runtime(tmp_path)
    _disc_routes._DISCOVERY_FEED_CACHE.clear()
    deezer.clear_cache()

    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    mod = MagicMock()
    mod.favourites_manager = MagicMock()
    mod.favourites_manager.get_all.return_value = []
    mod.favourite_library_ids.return_value = []
    api = {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "_mod": mod,
    }

    with patch.object(_disc_feed, "_get_api", return_value=api), \
         patch.object(deezer, "session", return_value=MagicMock(get=MagicMock(return_value=_FakeResponse({"tracks": {"data": []}})))), \
         patch.object(_disc_feed, "_schedule_discovery_feed_refresh", return_value=False):
        first = _make_app().test_client().get("/api/discovery/music/feed?limit=12")
        second = _make_app().test_client().get("/api/discovery/music/feed?limit=12")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json()["cached"] is False
    assert second.get_json()["cached"] is True


def test_discovery_feed_ranks_server_sections_and_reuses_fresh_cache(tmp_path):
    _make_runtime(tmp_path)
    _disc_routes._DISCOVERY_FEED_CACHE.clear()
    metadata = LibraryMetadata(
        version=1,
        tracks=[
            _track("t1", "One", "Artist One"),
            _track("t2", "Two", "Artist Two"),
            _track("t3", "Three", "Artist Three"),
        ],
        playlists={},
        settings={},
    )
    mod = MagicMock()
    mod.favourite_library_ids.return_value = ["t1"]
    api = {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "_mod": mod,
    }

    with patch.object(_disc_feed, "_get_api", return_value=api), \
         patch.object(_disc_feed, "_deezer_json", return_value={"data": []}), \
         patch.object(_disc_feed, "_cached_related_feed_candidates"), \
         patch.object(_disc_feed, "_schedule_discovery_feed_refresh", return_value=False):
        first = _make_app().test_client().get("/api/discovery/music/feed?limit=6")
        second = _make_app().test_client().get("/api/discovery/music/feed?limit=6")

    assert first.status_code == 200
    assert second.status_code == 200
    first_body = first.get_json()
    assert first_body["v"] == 1
    assert first_body["cached"] is False
    assert first_body["sections"]
    assert first_body["sections"][0]["section_type"] == "track_rail"
    assert first_body["items"]
    assert all(item.get("reason") for item in first_body["items"])
    assert second.get_json()["cached"] is True
    assert _make_app().test_client().get("/api/home").status_code == 404


def test_dj_plan_never_decodes_audio_on_the_interaction_path(tmp_path):
    # Planning runs while the listener is nudging a control. It may read what
    # has already been measured and it may queue work, but a decode inside the
    # request would put FFmpeg between a button press and the music.
    _make_runtime(tmp_path)
    base = {
        "v": 1,
        "plan_id": "base-plan",
        "intent": "auto_mode",
        "profile": "balanced",
        "seed_identity": "seed",
        "degraded": False,
        "generated_at": 1,
        "pool_counts": {"local": 0, "related": 1, "discovery": 0},
        "items": [{
            "id": "candidate01",
            "youtube_id": "candidate01",
            "title": "Candidate",
            "artist": "Artist",
            "duration": 200,
            "source": "preview",
            "source_pool": "related",
            "recommendation_identity": "music:youtube:candidate01",
            "recommendation_source": "auto_mode",
            "score": 0.6,
        }],
    }
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    queued: list[str] = []
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_build_music_plan", return_value=(base, 200)),
        patch.object(_auto_mode, "_dj_source_path", return_value="/library/candidate.mp3"),
        patch.object(_auto_mode, "cached_analysis", return_value=None),
        patch.object(_auto_mode, "request_analysis", side_effect=lambda *a, **k: queued.append(a[1])),
        patch("shared.dj.store._decode_measured", side_effect=AssertionError("decoded during a plan request")),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                "dj_profile": "adaptive",
                "seed": {"id": "seed", "title": "Seed", "artist": "Artist", "duration": 180},
                "limit": 3,
            },
        )

    assert response.status_code == 200
    body = response.get_json()
    assert body["items"]
    # Unmeasured pairs are declared as such, so the player keeps them to a fade.
    assert body["items"][0]["transition"]["confidence"] < 0.35
    assert len(queued) == 2, "only the seed and accepted route item should queue analysis"


def test_dj_plan_v6_ignores_legacy_boundaries_and_walks_explicit_sources(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    related = [{
        "id": "related001", "youtube_id": "related001", "title": "Related", "artist": "Elsewhere",
        "source": "preview", "source_pool": "related", "recommendation_identity": "music:youtube:related001",
    }]
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk(related, False, False)) as graph,
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                "session_id": "session-a",
                "seed": {"id": "seed", "track_id": "seed", "title": "Seed", "artist": "Artist"},
                "sources": [{
                    "id": "crate",
                    "label": "Warehouse crate",
                    "boundary": "inside",
                    "tracks": [
                        {"id": "a", "track_id": "a", "title": "A", "artist": "One"},
                        {"id": "b", "track_id": "b", "title": "B", "artist": "Two"},
                    ],
                }],
                "heard": [{"id": "a", "track_id": "a"}],
                "limit": 4,
            },
        )

    assert response.status_code == 200
    body = response.get_json()
    assert body["v"] == 6
    assert graph.called
    assert any(item["recommendation_identity"] == "music:youtube:related001" for item in body["items"])
    assert all("source_boundary" not in item for item in body["items"])


def test_dj_plan_v6_keeps_hour_long_recordings_out_of_a_route_of_songs(tmp_path):
    # The drive: a 54-minute ambient jungle set in the library was handed out as
    # the next "song" of a set, and the phone never got far enough into its
    # 563 MB to start it.
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    related = [
        {
            "id": f"song{index:07d}", "youtube_id": f"song{index:07d}", "title": f"Song {index}",
            "artist": "Artist", "duration": 240, "source": "preview", "source_pool": "related",
            "recommendation_identity": f"music:youtube:song{index:07d}",
        }
        for index in range(3)
    ] + [{
        "id": "longset0001", "youtube_id": "longset0001", "title": "Ambient jungle set", "artist": "crash",
        "duration": 3277, "source": "preview", "source_pool": "related",
        "recommendation_identity": "music:youtube:longset0001",
    }]
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk(related, False, False)),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                "session_id": "songs-only",
                "seed": {"id": "seed", "track_id": "seed", "title": "Seed", "artist": "Artist"},
                "sources": [{"id": "fav", "label": "Favourites", "tracks": [
                    {"id": "set", "track_id": "set", "title": "Another set", "artist": "DJ", "duration": 4000},
                ]}],
                "limit": 8,
            },
        )

    assert response.status_code == 200
    items = response.get_json()["items"]
    assert {item["id"] for item in items} == {"song0000000", "song0000001", "song0000002"}


def test_dj_plan_v6_still_opens_a_source_made_only_of_long_recordings(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                "session_id": "mixes",
                "sources": [{"id": "mixes", "label": "Mixes", "tracks": [
                    {"id": "mix-a", "track_id": "mix-a", "title": "Mix A", "artist": "DJ", "duration": 3600},
                ]}],
                "limit": 8,
            },
        )

    assert response.status_code == 200
    assert response.get_json()["opening"]["id"] == "mix-a"


def test_dj_plan_v6_chooses_an_opening_from_a_source_when_there_is_no_seed(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                "session_id": "source-only",
                "sources": [{
                    "id": "album:chosen",
                    "label": "Chosen album",
                    "tracks": [
                        {"id": "opening-a", "track_id": "opening-a", "title": "Opening A", "artist": "One"},
                        {"id": "opening-b", "track_id": "opening-b", "title": "Opening B", "artist": "Two"},
                    ],
                }],
                "limit": 4,
            },
        )

    assert response.status_code == 200
    body = response.get_json()
    assert body["v"] == 6
    assert body["opening"]["reason_code"] == "music_set_source"
    assert body["opening"]["source_set_id"] == "album:chosen"
    assert body["seed_identity"] == body["opening"]["id"]
    assert all(item["id"] != body["opening"]["id"] for item in body["items"])


def test_dj_plan_v6_analysis_does_not_select_music_or_steer_the_opening(tmp_path):
    """The sources and the recommender steer the session; the DJ only orders.

    Measured songs open where an unmeasured one would: the opening of a source
    is the session's deterministic shuffle, whatever the analysis says.
    """
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    tracks = [
        {"id": key, "track_id": key, "title": key.title(), "artist": f"Artist {key}"}
        for key in ("calm", "middle", "busy", "loud")
    ]

    def plan(analysed: bool) -> dict:
        def analysis(_metadata, item, *, schedule=False):
            if not analysed:
                return _auto_mode._dj_fallback_analysis(220)
            rates = {"calm": 0.5, "middle": 2.0, "busy": 5.0, "loud": 8.0}
            return {"duration": 220, "bpm": 120, "key": "C", "mode": "major", "confidence": 0.9,
                    "note_rate": rates.get(str(item.get("track_id") or item.get("id")), 3.0), "analysed": True}

        with (
            patch.object(_auto_mode, "_get_api", return_value=mock_api),
            patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
            patch.object(_auto_mode, "_dj_item_analysis", side_effect=analysis),
        ):
            response = _make_app().test_client().post("/api/discovery/music/dj-plan", json={
                "session_id": "no-arc", "sources": [{"id": "album:chosen", "label": "Chosen", "tracks": tracks}],
                "limit": 4,
            })
        assert response.status_code == 200
        return response.get_json()

    measured, unmeasured = plan(True), plan(False)
    assert "arc" not in measured
    assert measured["opening"]["id"] == unmeasured["opening"]["id"]
    assert {row["id"] for row in measured["items"]} == {row["id"] for row in unmeasured["items"]}


@pytest.mark.parametrize("with_seed", [False, True])
def test_dj_plan_v6_selects_before_analysis_and_preserves_cold_slots(tmp_path, with_seed):
    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    def track(key):
        return {"id": key, "track_id": key, "title": key, "artist": "Artist"}

    data = {"session_id": "membership", "segment_index": 3, "limit": 4,
            "sources": [{"id": "older", "activation": 1, "tracks": [track("old")]},
                        {"id": "newer", "activation": 2, "tracks": [track(f"t{i}") for i in range(12)]}]}
    if with_seed:
        data["seed"] = track("seed")
    known = set()
    read = []
    def analysis(_metadata, item, *, schedule=False):
        key = item["id"]
        read.append(key)
        if key not in known:
            return _auto_mode._dj_fallback_analysis(240)
        return {"analysed": True, "bpm": 120, "key": "C", "mode": "major", "duration": 240,
                "confidence": .9, "note_rate": float(len(key)), "loudness_lufs": -14., "spectral_flatness": .05}

    with (
        patch.object(_auto_mode, "_get_api", return_value=api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
        patch.object(_auto_mode, "_dj_item_analysis", side_effect=analysis),
    ):
        client = _make_app().test_client()
        def plan():
            read.clear()
            response = client.post("/api/discovery/music/dj-plan", json=data)
            assert response.status_code == 200
            body = response.get_json()
            chosen = {row["id"] for row in body["items"]}
            opening = body.get("opening", data.get("seed"))
            # Coverage reads the whole candidate catalogue, but membership and
            # the bounded acquisition cohort were frozen before those reads.
            assert set(read) == {"old", *(f"t{i}" for i in range(12)), opening["id"]}
            assert len(chosen) == 4
            return body

        cold = plan()
        opening = cold.get("opening", data.get("seed"))
        chosen = [row["id"] for row in cold["items"]]
        # All downloaded alternatives outside the cohort still cannot get in.
        known.update({"old", "seed", *(f"t{i}" for i in range(12))} - set(chosen))
        assert [row["id"] for row in plan()["items"]] == chosen
        known.update(chosen[::2])
        mixed = plan()
        assert {row["id"] for row in mixed["items"]} == set(chosen)
        for index in (1, 3):
            assert mixed["items"][index]["id"] == chosen[index]
        known.update(chosen)
        warm = plan()
        assert {row["id"] for row in warm["items"]} == set(chosen)
        assert warm.get("opening", data.get("seed"))["id"] == opening["id"]
        if not with_seed:
            assert warm["opening"]["source_set_id"] == "newer"
        assert warm == {**plan(), "plan_id": warm["plan_id"], "generated_at": warm["generated_at"]}


def test_dj_plan_v6_reorders_decoded_audio_and_returns_chained_plans(tmp_path):
    """Known WAVs -> FFmpeg -> real SQLite cache -> HTTP, without a provider."""
    import wave
    from docs.dj.key_probe import cadence
    from shared.dj_engine import analyse_audio, analysis_identity, plan_transition

    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    tracks = {key: {"id": key, "track_id": key, "title": key, "artist": "Synthetic"}
              for key in ("seed", "a", "b")}
    paths = {key: tmp_path / f"{key}.wav" for key in tracks}
    with (
        patch.object(_auto_mode, "_get_api", return_value=api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
        patch.object(_auto_mode, "_dj_source_path", side_effect=lambda _, item: paths[item["id"]]),
        patch.object(_auto_mode, "request_analysis"),
    ):
        client = _make_app().test_client()
        payload = {"session_id": "decoded", "seed": tracks["seed"],
                   "sources": [{"id": "cadences", "tracks": [tracks["a"], tracks["b"]]}]}
        cold = client.post("/api/discovery/music/dj-plan", json=payload).get_json()
        bad, good = [row["id"] for row in cold["items"]]
        features = {}
        for key in tracks:
            signal = cadence(6 if key == bad else 0, "major")
            with wave.open(str(paths[key]), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(11025)
                output.writeframes((signal * 32767).astype("<i2").tobytes())
            features[key] = analyse_audio(paths[key], analysis_identity(tracks[key]))
        with patch("shared.dj.store._analyse_pcm", side_effect=AssertionError("decoded during planning")):
            response = client.post("/api/discovery/music/dj-plan", json=payload)
        assert response.status_code == 200
        body = response.get_json()
        assert [row["id"] for row in body["items"]] == [good, bad]
        assert body["seed_analysis"] == _auto_mode._dj_analysis_summary(features["seed"])
        previous = features["seed"]
        for row in body["items"]:
            assert row["analysis"] == _auto_mode._dj_analysis_summary(features[row["id"]])
            assert row["transition"] == plan_transition(previous, features[row["id"]])
            previous = features[row["id"]]


def test_dj_plan_ignores_the_direction_older_clients_still_send(tmp_path):
    _make_runtime(tmp_path)
    base = {
        "v": 1, "plan_id": "base-plan", "intent": "auto_mode", "profile": "balanced", "seed_identity": "seed",
        "items": [
            {"id": f"cand000000{i}", "youtube_id": f"cand000000{i}", "title": f"Candidate {i}",
             "artist": f"Artist {i}", "duration": 180, "source": "preview", "source_pool": "related",
             "recommendation_identity": f"music:youtube:cand000000{i}", "recommendation_source": "auto_mode",
             "score": 0.5 + i / 10, "semantic_score": 0.4 + i / 10}
            for i in range(4)
        ],
        "degraded": False, "pool_counts": {"local": 0, "related": 4, "discovery": 0}, "generated_at": 1,
    }
    features = {"duration": 180, "bpm": 120, "key": "C", "mode": "major", "confidence": 0.9,
                "outro_cue": 130, "intro_cue": 8, "bar_seconds": 2, "analysed": True}
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )

    def plan(extra: dict) -> list[str]:
        with (
            patch.object(_auto_mode, "_get_api", return_value=mock_api),
            patch.object(_auto_mode, "_build_music_plan", return_value=(json.loads(json.dumps(base)), 200)) as built,
            patch.object(_auto_mode, "_dj_item_analysis", return_value=features),
        ):
            response = _make_app().test_client().post("/api/discovery/music/dj-plan", json={
                "dj_profile": "adaptive", "seed": {"id": "seed", "title": "Seed", "artist": "Artist", "duration": 180},
                "limit": 4, **extra,
            })
        assert response.status_code == 200
        assert built.call_args.args[0]["profile"] == "balanced"
        return [row["id"] for row in response.get_json()["items"]]

    old_direction = {"direction": {"energy": 1, "familiarity": 0.9, "prompt": "más caña",
                                   "include": ["Artist 0"], "exclude": ["Artist 3"]}}
    assert plan(old_direction) == plan({})


def test_dj_plan_v6_walks_from_sources_and_applies_exact_exclusions(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    related = [{
        "id": "related001",
        "youtube_id": "related001",
        "title": "Related",
        "artist": "Elsewhere",
        "source": "preview",
        "source_pool": "related",
        "recommendation_identity": "music:youtube:related001",
    }]
    payload = {
        "session_id": "session-b",
        "seed": {"id": "seed", "track_id": "seed", "title": "Seed", "artist": "Artist"},
        "sources": [{
            "id": "root-set", "label": "One root", "boundary": "from",
            "tracks": [{"id": "root", "track_id": "root", "title": "Root", "artist": "Artist"}],
        }],
        "exclude": ["music:track:root"],
        "limit": 4,
    }
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk(related, False, False)) as graph,
    ):
        root_excluded = _make_app().test_client().post("/api/discovery/music/dj-plan", json=payload)
        related_excluded = _make_app().test_client().post(
            "/api/discovery/music/dj-plan",
            json={
                **payload,
                "exclude": ["music:youtube:related001"],
                "heard": [{"id": "root", "track_id": "root"}],
            },
        )

    assert graph.call_args.kwargs["personalise"] is False
    assert root_excluded.get_json()["items"][0]["lineage"] == ["music:track:root", "music:youtube:related001"]
    assert all(
        item["recommendation_identity"] != "music:youtube:related001"
        for item in related_excluded.get_json()["items"]
    )


def test_dj_place_inserts_exact_track_without_returning_a_replacement_route(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-place",
            json={
                "seed": {"id": "seed", "track_id": "seed", "title": "Seed", "artist": "Artist"},
                "route": [
                    {"queue_id": "q-a", "id": "a", "track_id": "a", "title": "A", "artist": "Artist"},
                    {"queue_id": "q-b", "id": "b", "track_id": "b", "title": "B", "artist": "Artist"},
                ],
                "track": {"id": "wanted", "track_id": "wanted", "title": "Wanted", "artist": "Listener"},
                "requested_queue_id": "q-wanted",
                "before_queue_id": "q-b",
            },
        )

    assert response.status_code == 200
    body = response.get_json()
    assert body["insert_at"] == 1
    assert body["before_queue_id"] == "q-b"
    assert len(body["items"]) == 1
    assert body["items"][0]["route_kind"] == "user"
    assert body["items"][0]["request_id"] == "q-wanted"


def test_dj_place_never_bridges_through_the_requested_or_playing_song_under_another_identity(tmp_path):
    # User's session, 2026-10-26: «Teardrops (Rules Remix)» came back as its own
    # bridge. The library copy reached the pool through the heard songs as
    # `music:youtube:<id>` while the request was `music:track:<id>`, and a song
    # into itself is a perfect mix. The browser showed two rows that were
    # deleted and moved together.
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    measured = {
        "seed": {"duration": 220, "bpm": 100, "key": "C", "mode": "major", "confidence": 0.9, "tempo_confidence": 1, "analysed": True},
        "wanted": {"duration": 220, "bpm": 130, "key": "C", "mode": "major", "confidence": 0.9, "tempo_confidence": 1, "analysed": True},
    }

    def analysis(_metadata, item, *, schedule=False):
        key = str(item.get("track_id") or item.get("youtube_id") or item.get("id") or "")
        return measured.get(key, _auto_mode._dj_fallback_analysis(float(item.get("duration") or 0)))

    def copy(track_id: str, video: str, title: str, artist: str) -> dict:
        return {"id": video, "track_id": track_id, "youtube_id": video, "title": title, "artist": artist,
                "duration": 220, "source": "preview", "source_pool": "related",
                "recommendation_identity": f"music:youtube:{video}", "score": 0.9,
                "external_ids": {"youtube_id": video}}

    related = [copy("wanted", "wantedvid01", "Wanted", "Listener"), copy("seed", "seedvideo01", "Seed", "Artist")]
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk(related, False, False)),
        patch.object(_auto_mode, "_dj_item_analysis", side_effect=analysis),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-place",
            json={
                "seed": {"id": "seed", "track_id": "seed", "title": "Seed", "artist": "Artist", "duration": 220},
                "route": [],
                "track": {"id": "wanted", "track_id": "wanted", "title": "Wanted", "artist": "Listener", "duration": 220},
                "requested_queue_id": "q-wanted",
                "heard": [{"id": "wanted", "track_id": "wanted", "title": "Wanted", "artist": "Listener"}],
            },
        )

    assert response.status_code == 200
    items = response.get_json()["items"]
    assert [(item["route_kind"], item["track_id"]) for item in items] == [("user", "wanted")]


def _repair_route(*kinds: str) -> list[dict]:
    return [
        {
            "queue_id": f"q-{index}",
            "id": f"t{index}",
            "track_id": f"t{index}",
            "title": f"T{index}",
            "artist": "Artist",
            "route_kind": kind,
        }
        for index, kind in enumerate(kinds)
    ]


_REPAIR_SEED = {"id": "seed", "track_id": "seed", "title": "Seed", "artist": "Artist"}


def _post_repair(body: dict, related=None):
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk(related or [], False, False)),
    ):
        return _make_app().test_client().post("/api/discovery/music/dj-repair", json=body)


def test_dj_repair_keeps_every_pinned_song_at_the_depth_it_was_given(tmp_path):
    # Holding only their relative order would let a song dropped at slot five
    # surface as the very next one: order intact, intent destroyed.
    _make_runtime(tmp_path)
    route = _repair_route("generated", "generated", "user", "generated", "generated", "user", "generated")
    response = _post_repair({"seed": _REPAIR_SEED, "route": route})

    assert response.status_code == 200
    items = response.get_json()["items"]
    assert [index for index, item in enumerate(items) if item["route_kind"] == "user"] == [2, 5]
    assert [item["queue_id"] for item in items if item["route_kind"] == "user"] == ["q-2", "q-5"]
    assert all(item.get("transition") for item in items)
    assert response.get_json()["dropped"] == []


def test_dj_repair_bridges_into_a_pinned_song_where_placement_cannot(tmp_path):
    # dj-place drops its bridge pool the moment a position is fixed, so this is
    # the one thing no existing endpoint can do.
    _make_runtime(tmp_path)
    measured = {
        "seed": {"duration": 220, "bpm": 100, "key": "C", "mode": "major", "confidence": 0.9, "tempo_confidence": 1, "analysed": True},
        # Two adjacent Camelot steps, each inside the players' 8 % rate limit.
        # At 100 -> 113 -> 128 neither leg could beatmatch; that old fixture
        # only passed because C -> D was incorrectly scored as unrelated.
        "t0": {"duration": 220, "bpm": 112, "key": "D", "mode": "major", "confidence": 0.9, "tempo_confidence": 1, "analysed": True},
        "bridge01": {"duration": 220, "bpm": 106, "key": "G", "mode": "major", "confidence": 0.9, "tempo_confidence": 1, "analysed": True},
    }

    def analysis(_metadata, item, *, schedule=False):
        key = str(item.get("track_id") or item.get("youtube_id") or item.get("id") or "")
        return measured.get(key, _auto_mode._dj_fallback_analysis(float(item.get("duration") or 0)))

    related = [{
        "id": "bridge01", "youtube_id": "bridge01", "title": "Bridge", "artist": "Other",
        "duration": 220, "source": "preview", "source_pool": "related",
        "recommendation_identity": "music:youtube:bridge01", "recommendation_source": "auto_mode",
        "score": 0.9, "semantic_score": 0.9, "external_ids": {"youtube_id": "bridge01"},
    }]
    with patch.object(_auto_mode, "_dj_item_analysis", side_effect=analysis):
        response = _post_repair(
            {
                "seed": _REPAIR_SEED,
                "route": _repair_route("user"),
                "sources": [{
                    "id": "s1", "label": "Set",
                    "tracks": [{"id": "root", "track_id": "root", "title": "Root", "artist": "Artist"}],
                }],
            },
            related=related,
        )

    items = response.get_json()["items"]
    bridges = [item for item in items if item["route_kind"] == "bridge"]
    assert bridges, "a bridge should have been admitted between a 100 BPM seed and a 112 BPM pin"
    assert all(bridge["owner_queue_id"] == "q-0" for bridge in bridges)
    assert items[-1]["route_kind"] == "user"
    assert len(items) == 2
    assert items[0]["transition"]["playback_rate"] == pytest.approx(100 / 106, abs=1e-6)
    assert items[1]["transition"]["playback_rate"] == pytest.approx(106 / 112, abs=1e-6)


def test_dj_repair_never_decodes_audio_on_the_interaction_path(tmp_path):
    _make_runtime(tmp_path)
    queued: list[str] = []
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
        patch.object(_auto_mode, "_dj_source_path", return_value="/library/candidate.mp3"),
        patch.object(_auto_mode, "cached_analysis", return_value=None),
        patch.object(_auto_mode, "request_analysis", side_effect=lambda *a, **k: queued.append(a[1])),
        patch("shared.dj.store._decode_measured", side_effect=AssertionError("decoded during a repair request")),
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-repair",
            json={"seed": _REPAIR_SEED, "route": _repair_route("generated", "user", "generated")},
        )

    assert response.status_code == 200
    # Candidate evaluation is read-only; only the seed and what was accepted
    # are worth measuring for real.
    assert queued


def test_dj_repair_reuses_the_route_before_reaching_for_new_songs(tmp_path):
    _make_runtime(tmp_path)
    response = _post_repair({"seed": _REPAIR_SEED, "route": _repair_route("generated", "generated", "generated")})

    items = response.get_json()["items"]
    assert len(items) == 3
    assert sorted(item["queue_id"] for item in items) == ["q-0", "q-1", "q-2"]


def test_dj_repair_keeps_a_pinned_song_the_planner_cannot_name(tmp_path):
    # `_music_set_item` returns None for a reference with no track id and no
    # valid video id. Placement may skip one of those; repair may not.
    _make_runtime(tmp_path)
    response = _post_repair({
        "seed": _REPAIR_SEED,
        "route": [
            {"queue_id": "q-0", "id": "t0", "track_id": "t0", "title": "T0", "artist": "Artist", "route_kind": "generated"},
            {"queue_id": "q-pin", "id": "", "title": "Opaque", "artist": "Listener", "route_kind": "user"},
        ],
    })

    items = response.get_json()["items"]
    pinned = [item for item in items if item["route_kind"] == "user"]
    assert [item["queue_id"] for item in pinned] == ["q-pin"]
    assert response.get_json()["dropped"] == []


def test_dj_repair_does_not_let_an_exclusion_drop_a_pinned_song(tmp_path):
    _make_runtime(tmp_path)
    response = _post_repair({
        "seed": _REPAIR_SEED,
        "route": _repair_route("generated", "user"),
        "exclude": ["music:track:t1"],
    })

    items = response.get_json()["items"]
    assert any(item["queue_id"] == "q-1" and item["route_kind"] == "user" for item in items)


def test_dj_repair_reorders_a_route_with_nothing_pinned(tmp_path):
    _make_runtime(tmp_path)
    response = _post_repair({"seed": _REPAIR_SEED, "route": _repair_route("generated", "generated", "bridge")})

    items = response.get_json()["items"]
    assert len(items) == 3
    assert {item["route_kind"] for item in items} == {"generated"}


def test_dj_repair_validates_its_body(tmp_path):
    _make_runtime(tmp_path)
    route = _repair_route("user")
    assert _post_repair({"route": route}).status_code == 400
    assert _post_repair({"seed": _REPAIR_SEED, "route": []}).status_code == 400
    assert _post_repair({"seed": _REPAIR_SEED, "route": route, "limit": "many"}).status_code == 400


def test_dj_transition_upgrades_a_pair_once_it_has_been_measured(tmp_path):
    _make_runtime(tmp_path)
    measured = {
        "duration": 220,
        "bpm": 120,
        "key": "C",
        "mode": "major",
        "confidence": 0.9,
        "tempo_confidence": 1.0,
        "outro_cue": 190,
        "intro_cue": 6,
        "bar_seconds": 2,
    }
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    pair = {
        "dj_profile": "long_blend",
        "from": {"id": "a", "track_id": "a", "title": "A", "artist": "Artist", "duration": 220},
        "to": {"id": "b", "track_id": "b", "title": "B", "artist": "Artist", "duration": 220},
    }
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_dj_source_path", return_value="/library/track.mp3"),
        patch.object(_auto_mode, "cached_analysis", return_value=measured),
    ):
        response = _make_app().test_client().post("/api/discovery/music/dj-transition", json=pair)

    assert response.status_code == 200
    body = response.get_json()
    assert body["measured"] is True
    assert body["transition"]["technique"] == "bass_swap"
    # Pulled back from the measured outro so the whole blend fits in the file.
    assert body["transition"]["out_cue"] + body["transition"]["overlap_seconds"] <= 220

    # Nothing measured yet: answer immediately with the conservative plan
    # rather than making the player wait for a decode it cannot use in time.
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_dj_source_path", return_value=None),
    ):
        response = _make_app().test_client().post("/api/discovery/music/dj-transition", json=pair)
    assert response.get_json()["measured"] is False


def test_dj_transition_validates_its_pair(tmp_path):
    _make_runtime(tmp_path)
    client = _make_app().test_client()
    assert client.post("/api/discovery/music/dj-transition", json={}).status_code == 400
    assert client.post(
        "/api/discovery/music/dj-transition",
        json={"dj_profile": "mystery", "from": {}, "to": {}},
    ).status_code == 400


@pytest.mark.parametrize("case", ["breakdown", "outro", "long", "phase"])
def test_measured_audio_sections_reach_route_and_refinement_without_client_replanning(tmp_path, case):
    """Synthetic AAC -> real analysis/cache -> the common web/Android HTTP plan."""
    outro, long, phase = case == "outro", case == "long", case == "phase"
    import subprocess
    from shared import dj_engine
    from shared.ffmpeg_runtime import ffmpeg_executable
    from test_dj_sections import section_song

    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (_FakeLibrary(None), None, None)
    refs, paths, analyses = {}, {}, {}
    for key in ("outgoing", "incoming"):
        wav, aac = tmp_path / f"{key}.wav", tmp_path / f"{key}.m4a"
        section_song(wav, incoming=key == "incoming", outro=outro, long=long, phase=phase)
        subprocess.run([ffmpeg_executable(), "-v", "error", "-i", str(wav), "-c:a", "aac", str(aac)], check=True)
        refs[key] = {"id": key, "track_id": key, "title": key, "artist": "Synthetic", "duration": 240}
        paths[key] = aac
        analyses[key] = dj_engine.analyse_audio(aac, dj_engine.analysis_identity(refs[key]))
    with (patch.object(_auto_mode, "_get_api", return_value=api),
          patch.object(_auto_mode, "_dj_source_path", side_effect=lambda _, item: paths[item["id"]]),
          patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False))):
        client = _make_app().test_client()
        route = client.post("/api/discovery/music/dj-plan", json={"session_id": "sections", "seed": refs["outgoing"],
            "sources": [{"id": "source", "tracks": [refs["incoming"]]}], "limit": 1})
        refined = client.post("/api/discovery/music/dj-transition", json={"from": refs["outgoing"], "to": refs["incoming"]})
        # The same measured plan must reach every route-editing entry point;
        # obsolete styles from older clients cannot change it or reject it.
        expected = refined.get_json()["transition"]
        for profile in (None, "adaptive", "long_blend", "cuts_drops", "open_format", "mystery"):
            common = {"seed": refs["outgoing"], **({"dj_profile": profile} if profile else {})}
            row = {**refs["incoming"], "queue_id": "q-incoming", "route_kind": "user"}
            requests = [
                ("dj-place", {**common, "track": refs["incoming"], "requested_queue_id": "q-incoming"}),
                ("dj-repair", {**common, "route": [row]}),
                ("dj-plan", {**common, "sources": [{"id": "source", "tracks": [refs["incoming"]]}], "limit": 1}),
            ]
            for endpoint, payload in requests:
                response = client.post(f"/api/discovery/music/{endpoint}", json=payload)
                assert response.status_code == 200, (endpoint, profile, response.get_json())
                assert response.get_json()["items"][0]["transition"] == expected, (endpoint, profile)
            with patch.object(_auto_mode, "_build_music_plan", return_value=({"items": [refs["incoming"]]}, 200)):
                legacy = client.post("/api/discovery/music/dj-plan", json={**common, "limit": 1})
            assert legacy.status_code == 200
            assert legacy.get_json()["items"][0]["transition"] == expected
            again = client.post("/api/discovery/music/dj-transition", json={
                **common, "from": refs["outgoing"], "to": refs["incoming"]})
            assert again.status_code == 200
            assert again.get_json()["transition"] == expected
    assert route.status_code == refined.status_code == 200
    body = refined.get_json()
    assert body["measured"] is True
    plan = body["transition"]
    assert plan == route.get_json()["items"][0]["transition"]
    assert "sections" not in route.get_json()["items"][0]["analysis"]
    assert plan["technique"] == ("long_blend" if long else "bass_swap")
    if long:
        assert plan["overlap_seconds"] == 48
        assert abs(plan["playback_rate"] - 1) * plan["overlap_seconds"] <= .005
    elif phase:
        # The incoming drop lands on a measured outgoing phrase: bar 5 plus
        # whole eight-bar phrases, where counting eight bars from the first
        # one (before P13) would have put it elsewhere.
        end = plan["out_cue"] + plan["overlap_seconds"]
        phrases = analyses["outgoing"]["phrases"]
        assert any(abs(row["start"] - end) <= .005 and row["evidence"] != "assumed" for row in phrases)
        assert round((end - .25) / 2) % 8 == 5
        assert {row["label"] for row in analyses["outgoing"]["sections"]} == {"body"}
        drop = next(s["start"] for s in analyses["incoming"]["sections"] if s["label"] == "drop")
        assert drop == pytest.approx(64.25, abs=.005)
        assert (drop - plan["in_cue"]) / plan["playback_rate"] == pytest.approx(plan["overlap_seconds"], abs=.005)
    elif outro:
        start = next(s["start"] for s in analyses["outgoing"]["sections"] if s["label"] == "outro")
        assert plan["out_cue"] == pytest.approx(start, abs=.005)
        assert plan["overlap_seconds"] < 16
        # AAC padding/resampling can retain extra samples: validate the
        # decoded duration, with the plan's millisecond serialization precision.
        assert plan["out_cue"] + plan["overlap_seconds"] <= analyses["outgoing"]["duration"] - 1.5 + .001
    else:
        breakdown = next(s["start"] for s in analyses["outgoing"]["sections"] if s["label"] == "breakdown")
        drop = next(s["start"] for s in analyses["incoming"]["sections"] if s["label"] == "drop")
        assert plan["out_cue"] + plan["overlap_seconds"] == pytest.approx(breakdown, abs=.005)
        assert (drop - plan["in_cue"]) / plan["playback_rate"] == pytest.approx(plan["overlap_seconds"], abs=.005)
        assert plan["in_cue"] > 30
    print({key: plan[key] for key in ("out_cue", "in_cue", "overlap_seconds", "playback_rate")})


def test_dj_transition_prefers_relative_keys_over_parallel_and_mixed_mode_fifths(tmp_path):
    """The same measured plan reaches both web and Android via this endpoint."""
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    common = {"duration": 240, "confidence": .9, "tempo_confidence": 1., "outro_cue": 200,
              "intro_cue": 0, "bar_seconds": 2, "analysed": True}
    measured = {
        "current": {**common, "bpm": 120, "key": "C", "mode": "major"},
        "relative": {**common, "bpm": 124, "key": "A", "mode": "minor"},
        "parallel": {**common, "bpm": 124, "key": "C", "mode": "minor"},
        "mixed-fifth": {**common, "bpm": 124, "key": "G", "mode": "minor"},
    }
    client = _make_app().test_client()
    plans = {}
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_dj_source_path", side_effect=lambda metadata, item: item["id"]),
        patch.object(_auto_mode, "cached_analysis", side_effect=lambda path, identity: measured[path]),
        patch.object(_auto_mode, "request_analysis", side_effect=AssertionError("already measured")),
    ):
        for incoming in ("relative", "parallel", "mixed-fifth"):
            response = client.post("/api/discovery/music/dj-transition", json={
                "dj_profile": "adaptive", "from": {"id": "current"}, "to": {"id": incoming},
            })
            assert response.status_code == 200
            body = response.get_json()
            assert body["measured"] is True
            assert body["analysis"]["to"] == measured[incoming]
            plans[incoming] = body["transition"]
    assert plans["relative"]["technique"] == "bass_swap"
    assert plans["parallel"]["technique"] == plans["mixed-fifth"]["technique"] == "filter_blend"
    assert plans["relative"]["score"] > plans["mixed-fifth"]["score"] > plans["parallel"]["score"]


def test_dj_collection_places_every_occurrence_beyond_the_analysis_window(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    requests = [
        {"track": {"id": f"song-{index % 19}", "title": f"Song {index}", "artist": "Listener"},
         "requested_queue_id": f"request-{index}"}
        for index in range(24)
    ]
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
    ):
        response = _make_app().test_client().post("/api/discovery/music/dj-place", json={
            "seed": {"id": "seed", "title": "Seed", "artist": "Artist"},
            "route": [{"queue_id": "existing", "id": "existing", "title": "Existing", "artist": "Artist"}],
            "requests": requests,
        })
    assert response.status_code == 200
    placements = response.get_json()["placements"]
    route = [{"queue_id": "existing"}]
    for placement in placements:
        route[placement["insert_at"]:placement["insert_at"]] = placement["items"]
    assert {row["queue_id"] for row in route} == {"existing", *(row["requested_queue_id"] for row in requests)}
    assert len(route) == 25


def test_dj_collection_rejects_ambiguous_occurrence_ids(tmp_path):
    _make_runtime(tmp_path)
    response = _make_app().test_client().post("/api/discovery/music/dj-place", json={
        "requests": [{"requested_queue_id": "same"}, {"requested_queue_id": "same"}],
    })
    assert response.status_code == 400


def test_dj_collection_keeps_a_selected_seam_beyond_the_analysis_window(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    route = _repair_route(*(["user"] * 24))
    requests = [
        {"track": {"id": f"wanted-{index}", "title": f"Wanted {index}", "artist": "Listener"},
         "requested_queue_id": f"wanted-{index}"}
        for index in range(24)
    ]
    with patch.object(_auto_mode, "_get_api", return_value=mock_api):
        response = _make_app().test_client().post("/api/discovery/music/dj-place", json={
            "seed": _REPAIR_SEED, "route": route, "before_queue_id": "q-23", "requests": requests,
        })
    assert response.status_code == 200
    for placement in response.get_json()["placements"]:
        assert placement["before_queue_id"] == "q-23"
        route[placement["insert_at"]:placement["insert_at"]] = placement["items"]
    assert [row["queue_id"] for row in route] == [
        *(f"q-{index}" for index in range(23)), *(f"wanted-{index}" for index in range(24)), "q-23",
    ]


def _house_related(count: int = 8) -> list[dict]:
    return [{
        "id": f"house{index:03d}", "track_id": f"house{index:03d}",
        "title": f"Deep {index}", "artist": "Oliver Heldens",
        "source": "library", "source_pool": "local",
        "recommendation_identity": f"music:track:house{index:03d}",
    } for index in range(count)]


def test_explicit_dj_direction_never_uses_heard_requests_as_graph_roots(tmp_path):
    """While the influences can still fill the route, heard music is not a root.

    A song the listener requested sounds, and so joins `heard`. It must not
    thereby steer the set: ask for one house track in a rock session and the
    rock session stays. Only confirmed automatic playback opens new roots.
    """
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    seed = {"id": "rock", "track_id": "rock", "title": "Rock", "artist": "Extremoduro"}
    source = {"id": "house", "label": "Oliver Heldens", "tracks": [
        {"id": "oliver", "track_id": "oliver", "title": "Gecko", "artist": "Oliver Heldens"},
    ]}
    body = {"source_policy": "explicit", "seed": seed, "sources": [source], "heard": [seed]}
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk(_house_related(), False, False)) as graph,
    ):
        response = _make_app().test_client().post("/api/discovery/music/dj-plan", json=body)
        assert response.status_code == 200
        assert graph.call_count == 1
        assert [row["artist"] for row in graph.call_args.args[1]] == ["Oliver Heldens"]
        assert all(item["recommendation_identity"] != "music:track:rock" for item in response.get_json()["items"])
        graph.reset_mock()
        bridges = _auto_mode._dj_place_bridge_pool(None, body, set())
        assert bridges
        assert graph.call_count == 1
        assert [row["artist"] for row in graph.call_args.args[1]] == ["Oliver Heldens"]


def test_explicit_dj_route_continues_from_confirmed_exploration(tmp_path):
    """An exhausted pool continues the set instead of returning nothing.

    A source walk is finite and the client excludes everything it already holds,
    so a long session drains the pool. Before this fallback the route came back
    empty, the client discarded it, and DJ sat on "searching for another route"
    for good.
    """
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    heard = {"id": "rock", "track_id": "rock", "title": "Rock", "artist": "Extremoduro"}
    source = {"id": "house", "label": "Oliver Heldens", "tracks": [
        {"id": "oliver", "track_id": "oliver", "title": "Gecko", "artist": "Oliver Heldens"},
    ]}
    recovered = [{
        "id": "rescue", "track_id": "rescue", "title": "Rescue", "artist": "Extremoduro",
        "source": "library", "source_pool": "local", "recommendation_identity": "music:track:rescue",
    }]
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(
            _auto_mode, "_planner_context_related",
            side_effect=[_auto_mode._GraphWalk([], False, False), _auto_mode._GraphWalk(recovered, False, False)],
        ) as graph,
    ):
        response = _make_app().test_client().post("/api/discovery/music/dj-plan", json={
            "source_policy": "explicit", "seed": heard, "sources": [source], "heard": [heard], "exploration": [heard],
            # Everything the influence could reach is already queued.
            "exclude": ["music:track:oliver"],
        })
    assert response.status_code == 200
    body = response.get_json()
    assert graph.call_count == 2
    assert [row["artist"] for row in graph.call_args_list[1].args[1]] == ["Extremoduro"]
    assert [item["recommendation_identity"] for item in body["items"]] == ["music:track:rescue"]
    # Exploration is an ordinary healthy source of continuation.
    assert body["degraded"] is False
    assert body["items"][0]["source_weight"] == 0.3


def test_explicit_dj_bridges_use_sources_and_confirmed_exploration(tmp_path):
    """A seam with no bridge material is a raw cut, so heard music may bridge it."""
    _make_runtime(tmp_path)
    heard = {"id": "rock", "track_id": "rock", "title": "Rock", "artist": "Extremoduro"}
    source = {"id": "house", "label": "Oliver Heldens", "tracks": [
        {"id": "oliver", "track_id": "oliver", "title": "Gecko", "artist": "Oliver Heldens"},
    ]}
    bridge = [{
        "id": "seam", "track_id": "seam", "title": "Seam", "artist": "Extremoduro",
        "source": "library", "source_pool": "local", "recommendation_identity": "music:track:seam",
    }]
    body = {"source_policy": "explicit", "sources": [source], "heard": [heard], "exploration": [heard]}
    with patch.object(
        _auto_mode, "_planner_context_related",
        return_value=_auto_mode._GraphWalk(bridge, False, False),
    ) as graph:
        candidates = _auto_mode._dj_place_bridge_pool(None, body, set())
    assert graph.call_count == 1
    assert [row["artist"] for row in graph.call_args.args[1]] == ["Oliver Heldens", "Extremoduro"]
    assert [item["recommendation_identity"] for item, _ in candidates] == ["music:track:seam"]


def test_explicit_dj_mix_keeps_both_sources_but_excludes_heard_music(tmp_path):
    _make_runtime(tmp_path)
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    rock = {"id": "rock", "track_id": "rock", "title": "Rock", "artist": "Extremoduro"}
    house = {"id": "house", "track_id": "house", "title": "Gecko", "artist": "Oliver Heldens"}
    with (
        patch.object(_auto_mode, "_get_api", return_value=mock_api),
        patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)) as graph,
    ):
        response = _make_app().test_client().post("/api/discovery/music/dj-plan", json={
            "source_policy": "explicit", "seed": rock, "heard": [rock],
            "sources": [{"id": "rock", "tracks": [rock]}, {"id": "house", "tracks": [house]}],
        })
    assert response.status_code == 200
    # Both influences are walked; unrelated heard requests never become roots.
    assert graph.call_count == 2
    assert {call.args[1][0]["artist"] for call in graph.call_args_list[:2]} == {"Extremoduro", "Oliver Heldens"}
    assert [item["id"] for item in response.get_json()["items"]] == ["house"]


@pytest.mark.parametrize("failed", [False, True])
def test_dj_empty_result_distinguishes_exhaustion_from_provider_failure(tmp_path, failed):
    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    track = {"id": "one", "title": "One", "artist": "Artist"}
    with patch.object(_auto_mode, "_get_api", return_value=api), patch.object(
        _auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], failed, False),
    ):
        body, status = _auto_mode._build_music_set_route({
            "seed": track, "sources": [{"tracks": [track]}], "source_policy": "explicit",
            "exclude": ["music:track:one"], "exploration": [], "direction_revision": 4,
        })
    assert status == 200
    assert body["items"] == []
    assert body["empty_reason"] == ("temporary_failure" if failed else "exhausted")
    assert body["direction_revision"] == 4


def test_dj_explores_even_before_sources_run_out_and_continues_thirty_routes(tmp_path):
    """Differential regression: the old explicit policy skips the moving roots
    whenever eight static candidates survive, eventually draining its graph.
    Every provider result here overlaps the existing queue except its next hop.
    """
    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )

    def track(number):
        return {"id": f"t{number}", "track_id": f"t{number}", "title": f"Track {number}",
                "artist": "Session artist", "source": "library", "source_pool": "local",
                "recommendation_identity": f"music:track:t{number}"}

    def graph(_metadata, roots, **_kwargs):
        rows = {row["id"]: row for root in roots
                for row in [track(0), track(int(root["id"][1:]) + 1)]}
        return _auto_mode._GraphWalk(list(rows.values()), False, False)

    data = {"seed": track(0), "sources": [{"id": "source", "tracks": [track(0)]}],
            "source_policy": "explicit", "heard": [track(0)], "exploration": [],
            "exclude": ["music:track:t0"], "session_id": "continuity"}
    with patch.object(_auto_mode, "_get_api", return_value=api), patch.object(
        _auto_mode, "_planner_context_related", side_effect=graph,
    ) as walk:
        for segment in range(30):
            data["segment_index"] = segment
            body, status = _auto_mode._build_music_set_route(data)
            assert status == 200
            assert body["items"], segment
            played = body["items"][-1]
            data["seed"] = played
            data["heard"] = [*data["heard"], played][-40:]
            data["exploration"] = [*data["exploration"], played][-4:]
            data["exclude"].extend(row["recommendation_identity"] for row in body["items"])
        # With a full influence pool the moving roots must still be queried.
        walk.reset_mock()
        walk.side_effect = None
        walk.return_value = _auto_mode._GraphWalk(_house_related(), False, False)
        _auto_mode._build_music_set_route({**data, "exclude": []})
        assert walk.call_count == 2


def test_partial_graph_failure_is_not_reported_as_exhaustion(tmp_path):
    """An empty cached neighbour must not hide another root's provider failure."""
    from concurrent.futures import Future

    _make_runtime(tmp_path)
    failed = Future()
    failed.set_exception(RuntimeError('provider unavailable'))
    database = MagicMock()
    database.get_related_mixes.return_value = {'cached': []}
    with (
        patch.object(_auto_mode, 'instance_db', return_value=database),
        patch.object(_auto_mode, '_planner_video_id', side_effect=lambda _, row: row['id']),
        patch.object(_auto_mode, '_planner_related_future', return_value=failed),
    ):
        walk = _auto_mode._planner_context_related(
            None, [{'id': 'cached'}, {'id': 'uncached'}], personalise=False,
        )
    assert walk.items == []
    assert walk.degraded is True


@pytest.mark.parametrize("warming", [False, True])
@pytest.mark.parametrize("exclude", [[], ["FgGtOCKWLwI"]])
def test_impend_seed_cannot_be_its_own_route(tmp_path, warming, exclude):
    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    seed = {"id": "FgGtOCKWLwI", "title": "Impend", "artist": "Artist", "source": "preview"}
    with (
        patch.object(_auto_mode, "_get_api", return_value=api),
        patch.object(_auto_mode, "_planner_context_related",
                     return_value=_auto_mode._GraphWalk([], warming, warming)),
        patch.object(_auto_mode, "_planner_warm_related"),
    ):
        body, status = _auto_mode._build_music_set_route({
            "seed": seed, "sources": [{"tracks": [seed]}], "exclude": exclude,
        })
    assert status == 200
    assert body["items"] == []
    assert body["warming"] is warming
    assert body["degraded"] is warming
    assert body["empty_reason"] == ("temporary_failure" if warming else "exhausted")
    assert body["retry_after"] == (2.0 if warming else None)


def test_cold_graph_joins_inflight_fetch_then_uses_persisted_result(tmp_path):
    """Real executor/cache path; a delayed provider outlives multiple HTTP waits."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    _make_runtime(tmp_path)
    seed = {"id": "FgGtOCKWLwI", "youtube_id": "FgGtOCKWLwI"}
    release = threading.Event()
    started = threading.Event()
    rows = [{"id": "abc11111111", "title": "Next", "channel": "Artist", "duration": 200}]
    db = instance_db()

    def fetch(video_id):
        started.set()
        assert release.wait(5)
        db.set_related_mix(video_id, rows)
        return rows

    with (
        ThreadPoolExecutor(max_workers=1) as executor,
        patch.object(_auto_mode, "_GRAPH_FETCH_EXECUTOR", executor),
        patch.object(_auto_mode, "_planner_uncached_related", side_effect=fetch) as provider,
        patch.object(_auto_mode, "_AUTO_GRAPH_WAIT_SEC", 0.01),
    ):
        try:
            first = _auto_mode._planner_context_related(None, [seed], personalise=False)
            assert started.wait(1)
            second = _auto_mode._planner_context_related(None, [seed], personalise=False)
            assert first.warming and second.warming
            assert first.cache_miss == 1
            assert provider.call_count == 1
            future = _auto_mode._planner_related_future(seed["id"])
            release.set()
            future.result(timeout=5)
            warm = _auto_mode._planner_context_related(None, [seed], personalise=False)
            assert not warm.warming and not warm.degraded
            assert warm.cache_hit == 1
            assert warm.items[0]["id"] == "abc11111111"
            assert provider.call_count == 1
        finally:
            release.set()


def test_graph_timeout_does_not_cancel_queued_work(tmp_path):
    from concurrent.futures import Future

    _make_runtime(tmp_path)
    pending = Future()
    with (
        patch.object(_auto_mode, '_planner_related_future', return_value=pending),
        patch.object(_auto_mode, '_AUTO_GRAPH_WAIT_SEC', 0),
    ):
        walk = _auto_mode._planner_context_related(None, [
            {'id': 'FgGtOCKWLwI', 'source': 'preview'},
        ], personalise=False)
    assert walk.warming and walk.degraded
    assert not pending.cancelled()


def test_heard_relaxation_preserves_last_two_tracks(tmp_path):
    _make_runtime(tmp_path)
    api = _mock_api()
    api['get_core'].return_value = (
        _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None,
    )
    tracks = [{'id': str(n), 'title': str(n), 'artist': 'Artist'} for n in range(4)]
    with (
        patch.object(_auto_mode, '_get_api', return_value=api),
        patch.object(_auto_mode, '_planner_context_related', return_value=_auto_mode._GraphWalk([], False, False)),
    ):
        body, status = _auto_mode._build_music_set_route({
            'seed': tracks[-1], 'sources': [{'tracks': tracks}], 'heard': tracks,
            'exclude': ['0'],
        })
    assert status == 200
    assert [item['id'] for item in body['items']] == ['1']


def test_an_artists_top_tracks_are_found_through_a_plain_artist_search():
    asked = []

    def answer(path, params=None, ttl_sec=0):
        asked.append((path, params))
        if path == "search/artist":
            return {"data": [{"id": 9, "name": "Daft Punk Tribute"}, {"id": 27, "name": "Daft Punk"}]}
        if path == "artist/27/top":
            return {"data": [{"id": 1, "title": "One More Time", "artist": {"id": 27, "name": "Daft Punk"}}]}
        return {"data": []}

    with patch.object(_disc_feed, "_deezer_json", side_effect=answer):
        rows = _disc_feed._deezer_artist_top_rows("daft punk", 5)

    assert [row["title"] for row in rows] == ["One More Time"]
    # No field syntax: Deezer stopped answering `artist:"…"` in October 2026.
    assert asked[0] == ("search/artist", {"q": "daft punk", "limit": 8})


def test_an_artist_deezer_does_not_know_has_no_top_tracks():
    with patch.object(_disc_feed, "_deezer_json", return_value={"data": []}):
        assert _disc_feed._deezer_artist_top_rows("Nobody", 5) == []


def test_dj_cohort_is_bounded_identical_for_cold_and_warm_pools_and_reports_coverage(tmp_path, caplog):
    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (_FakeLibrary(None), None, None)
    tracks = [{"id": f"video{i:06d}", "youtube_id": f"video{i:06d}", "source": "preview",
               "title": str(i), "artist": "Artist"} for i in range(40)]
    data = {"session_id": "bounded", "seed": {"id": "seed", "track_id": "seed"},
            "sources": [{"id": "source", "tracks": tracks}], "limit": 4}
    prepared = []
    def features(_metadata, item, *, schedule=False):
        return {"analysed": ready, "duration": 240, "bpm": 120, "key": "C", "mode": "major", "confidence": .9}
    with (patch.object(_auto_mode, "_get_api", return_value=api),
          patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
          patch.object(_auto_mode, "_dj_item_analysis", side_effect=features),
          patch.object(_auto_mode, "_dj_prepare_cohort", side_effect=lambda _, rows: prepared.append([r["id"] for r in rows])),
          caplog.at_level("INFO", logger=_auto_mode.__name__)):
        client = _make_app().test_client()
        ready = False
        cold = client.post("/api/discovery/music/dj-plan", json=data).get_json()
        ready = True
        warm = client.post("/api/discovery/music/dj-plan", json=data).get_json()
    assert prepared[0] == prepared[1]
    assert len(prepared[0]) == 17  # seed + bounded 16, regardless of cache
    assert [row["id"] for row in cold["items"]] == [row["id"] for row in warm["items"]]
    assert cold["analysis_coverage"] == {"candidates": 40, "analysed": 0, "cohort": 16, "cohort_analysed": 0, "bridges": 0}
    assert warm["analysis_coverage"]["analysed"] == 40
    assert "analysis_candidates=40 analysis_ready=0 analysis_cohort=16 analysis_cohort_ready=0" in caplog.text


def test_dj_plan_v6_inserts_a_bridge_only_when_every_frozen_candidate_is_measured(tmp_path):
    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (_FakeLibrary(None), None, None)
    tracks = [{"id": key, "track_id": key, "title": key, "artist": "Synthetic"} for key in ("a", "b", "c")]
    data = {"session_id": "bridges", "seed": {"id": "seed", "track_id": "seed"},
            "sources": [{"id": "source", "tracks": tracks}], "limit": 1}
    tempos = {"seed": 100}
    known = set()
    def features(_metadata, item, *, schedule=False):
        key = item["id"]
        if key not in known:
            return _auto_mode._dj_fallback_analysis(240)
        return {"analysed": True, "duration": 240, "bpm": tempos[key], "key": "C", "mode": "major", "confidence": .9, "tempo_confidence": 1.}
    cohort = []
    with (patch.object(_auto_mode, "_get_api", return_value=api),
          patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
          patch.object(_auto_mode, "_dj_item_analysis", side_effect=features),
          patch.object(_auto_mode, "_dj_prepare_cohort", side_effect=lambda _, rows: cohort.extend(r["id"] for r in rows))):
        client = _make_app().test_client()
        cold = client.post("/api/discovery/music/dj-plan", json=data).get_json()
        target = cold["items"][0]["id"]
        spares = [key for key in cohort if key not in {"seed", target}]
        tempos.update({target: 112, spares[0]: 106, spares[1]: 106})
        known.update({"seed", target, spares[0]})
        partial = client.post("/api/discovery/music/dj-plan", json=data).get_json()
        assert [row["id"] for row in partial["items"]] == [target]
        known.add(spares[1])
        warm = client.post("/api/discovery/music/dj-plan", json=data).get_json()
    assert [row["id"] for row in warm["items"]] == [spares[0], target]
    assert warm["items"][0]["route_kind"] == "bridge"
    assert warm["analysis_coverage"]["bridges"] == 1


def test_committed_preview_is_analysed_before_refinement_and_serving_ranges_keeps_it_valid(tmp_path):
    """Real AAC -> cache commit -> analyser -> SQLite -> HTTP measured plan."""
    import os
    import subprocess
    from shared import dj_engine, preview_cache
    from shared.ffmpeg_runtime import ffmpeg_executable

    runtime = _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (_FakeLibrary(None), None, None)
    video = "candidate01"
    source = tmp_path / "source.m4a"
    subprocess.run([ffmpeg_executable(), "-v", "error", "-f", "lavfi", "-i",
                    "aevalsrc=0.2*sin(2*PI*220*t)+0.5*exp(-mod(t\\,0.5)*80):s=11025:d=12",
                    "-c:a", "aac", str(source)], check=True)
    ref = {"id": video, "youtube_id": video, "source": "preview", "duration": 12}
    queued = []
    def measure(path, identity, **kwargs):
        queued.append(identity)
        dj_engine.analyse_audio(path, identity, **kwargs)
    with (patch.object(_auto_mode, "_get_api", return_value=api),
          patch.object(dj_engine, "request_analysis", side_effect=measure)):
        client = _make_app().test_client()
        assert client.post("/api/discovery/music/dj-transition", json={"from": ref, "to": ref}).get_json()["measured"] is False
        writer = preview_cache.open_writer(video, "audio/mp4", source.stat().st_size)
        writer.write(source.read_bytes())
        assert writer.commit(preview_cache._preview_is_decodable)
        assert queued == [dj_engine.analysis_identity(ref)]
        path = runtime.cache_dir / "previews" / f"{video}.audio"
        stamp = path.stat()
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1000000000))
        body = client.post("/api/discovery/music/dj-transition", json={"from": ref, "to": ref}).get_json()
    assert body["measured"] is True
    assert body["analysis"]["to"]["analysed"] is True
    assert body["transition"]["confidence"] >= .35
    # Replacing the committed bytes must invalidate the old analysis.
    preview_cache._write_meta(video, {**preview_cache.cached_metadata(video), "revision": "replacement"})
    assert dj_engine.cached_analysis(path, dj_engine.analysis_identity(ref)) is None


def test_dj_preparation_queues_only_the_frozen_previews_and_keeps_refresh_contract(tmp_path):
    from shared import preview_cache
    from shared.api.routes import playback
    _make_runtime(tmp_path)
    api = _mock_api()
    rows = [{"id": "local", "track_id": "local"},
            {"id": "candidate01", "youtube_id": "candidate01", "discovery_youtube_id": "discovery01", "source": "preview"},
            {"id": "candidate02", "youtube_id": "candidate02", "source": "preview"}]
    with (patch.object(_auto_mode, "_get_api", return_value=api),
          patch.object(_auto_mode, "_dj_item_analysis") as analyse,
          patch.object(preview_cache, "request_prefetch") as prefetch,
          patch.object(playback, "_get_preview_stream_cached", return_value="resolved") as resolve,
          patch.object(playback, "_invalidate_stream") as invalidate):
        _auto_mode._dj_prepare_cohort(None, rows)
        assert [call.args[1] for call in analyse.call_args_list] == rows
        assert all(call.kwargs == {"schedule": True} for call in analyse.call_args_list)
        assert prefetch.call_args.args == (["candidate01", "candidate02"],)
        assert prefetch.call_args.kwargs["download"] is True
        assert prefetch.call_args.kwargs["resolver"]("candidate01") == "resolved"
        prefetch.call_args.kwargs["refresh_resolver"]("candidate01")
        invalidate.assert_called_once_with("candidate01")
        resolve.assert_called_with(api, "candidate01", skip_fast_path=True)
        prefetch.reset_mock()
        with patch.object(preview_cache, "cache_limit_bytes", return_value=0):
            _auto_mode._dj_prepare_cohort(None, rows)
        prefetch.assert_not_called()


def test_v6_analysis_summary_keeps_sixteen_fast_long_starts_within_native_response_budget():
    # Eight-minute songs at 220 BPM need 1760 grid points each. Sixteen full
    # grids plus the seed alone exceed the native 256 KiB response limit.
    from shared.dj.contracts import fallback_analysis as _fallback
    beats = [round(i * 60 / 220, 4) for i in range(1760)]
    analysis = {**_fallback(480), "analysed": True, "bpm": 220, "key": "C", "mode": "major",
                "beat_grid": beats, "downbeats": beats[::4],
                "phrases": [{"start": t, "bars": 8, "evidence": "counted"} for t in beats[::32]]}
    full = {"seed_analysis": analysis, "items": [{"analysis": analysis}] * 16}
    assert len(json.dumps(full).encode()) > 262144
    summary = _auto_mode._dj_analysis_summary(analysis)
    compact = {"seed_analysis": summary, "items": [{"analysis": summary}] * 16}
    assert len(json.dumps(compact).encode()) < 16384
    assert summary["bpm"] == 220 and summary["key"] == "C" and summary["analysed"] is True
    assert analysis["beat_grid"] == beats


@pytest.mark.parametrize("bpm", [100, 137])  # No common cycle with 120 within 8 %.
def test_measured_aac_echo_period_survives_route_and_refinement(tmp_path, bpm):
    """Known pulse -> AAC -> SQLite -> the common plan for web and Android."""
    import subprocess
    from shared import dj_engine
    from shared.ffmpeg_runtime import ffmpeg_executable
    from test_dj_beat_grid import song

    _make_runtime(tmp_path)
    api = _mock_api()
    api["get_core"].return_value = (_FakeLibrary(None), None, None)
    refs, paths = {}, {}
    for key, tempo in (("outgoing", bpm), ("incoming", 120)):
        wav, aac = tmp_path / f"{key}.wav", tmp_path / f"{key}.m4a"
        song(wav, tempo, seconds=120)
        subprocess.run([ffmpeg_executable(), "-v", "error", "-i", str(wav), "-c:a", "aac", str(aac)], check=True)
        refs[key] = {"id": key, "track_id": key, "title": key, "artist": "Synthetic", "duration": 120}
        paths[key] = aac
        measured = dj_engine.analyse_audio(aac, dj_engine.analysis_identity(refs[key]))
        assert measured["analysed"] is True
    with (patch.object(_auto_mode, "_get_api", return_value=api),
          patch.object(_auto_mode, "_dj_source_path", side_effect=lambda _, item: paths[item["id"]]),
          patch.object(_auto_mode, "_planner_context_related", return_value=_auto_mode._GraphWalk([], False, False)),
          patch.object(_auto_mode, "_build_music_plan", return_value=({"items": [refs["incoming"]]}, 200))):
        client = _make_app().test_client()
        # Both planning paths and refinement now choose echo without a profile.
        route = client.post("/api/discovery/music/dj-plan", json={"session_id": "echo", "seed": refs["outgoing"],
            "limit": 3})
        refined = client.post("/api/discovery/music/dj-transition", json={"from": refs["outgoing"],
            "to": refs["incoming"]})
        explicit = client.post("/api/discovery/music/dj-plan", json={"session_id": "echo", "seed": refs["outgoing"],
            "sources": [{"id": "source", "tracks": [refs["incoming"]]}], "limit": 1})
    assert route.status_code == refined.status_code == 200
    body = refined.get_json()
    assert body["measured"] is True
    plan = body["transition"]
    assert plan == route.get_json()["items"][0]["transition"]
    assert explicit.status_code == 200
    assert plan == explicit.get_json()["items"][0]["transition"]
    assert plan["technique"] == "echo_cut"
    assert plan["echo_delay_seconds"] == pytest.approx(60 / bpm, abs=.001)
    print({"bpm": bpm, "echo_delay_seconds": plan["echo_delay_seconds"]})


@pytest.mark.parametrize('out_size,in_size,subdivision', [(3, 3, 2), (3, 4, 2), (4, 4, 2)])
def test_metric_aac_cache_upgrade_cold_warm_and_all_http_entry_points(tmp_path, monkeypatch, out_size, in_size, subdivision):
    """Known PCM -> AAC -> beat model -> versioned SQLite -> every planner, no client detector.

    The real network reads these signals; its accuracy is measured elsewhere.
    What must hold regardless: one decode per file, none when warm, the same
    plan from every entry point, a compact summary, a shared steady pulse
    mixed as such, and bars promised only with confirmed equal bars.
    """
    import subprocess
    import wave
    from shared.dj import store
    from shared.dj.contracts import ANALYSER_VERSION
    from shared.dj.timing import BEATMATCH_TECHNIQUES
    from shared import dj_engine
    from shared.ffmpeg_runtime import ffmpeg_executable
    from test_dj_metre import metric_signal

    rate = 22050
    _make_runtime(tmp_path)
    monkeypatch.setattr(store, '_cache_path', lambda: tmp_path / 'metre.sqlite3')
    api = _mock_api()
    api['get_core'].return_value = (_FakeLibrary(None), None, None)
    refs, paths = {}, {}
    for key, size in [('outgoing', out_size), ('incoming', in_size)]:
        samples, _, _ = metric_signal(beats_per_bar=size, subdivision=subdivision, seconds=120, rate=rate)
        wav, aac = tmp_path / f'{key}.wav', tmp_path / f'{key}.m4a'
        with wave.open(str(wav), 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes((samples * 16000).astype('<i2').tobytes())
        subprocess.run([ffmpeg_executable(), '-v', 'error', '-i', str(wav), '-c:a', 'aac', str(aac)], check=True)
        refs[key] = {'id': key, 'track_id': key, 'title': key, 'artist': 'Metric fixture', 'duration': 120}
        paths[key] = aac
        # A valid content stamp cannot promote the previous analyser's measures.
        with store._connect() as conn:
            conn.execute('INSERT INTO audio_analysis VALUES (?, ?, ?, ?, ?)',
                         (dj_engine.analysis_identity(refs[key]), store._source_stamp(aac), ANALYSER_VERSION - 1,
                          json.dumps({'version': ANALYSER_VERSION - 1, 'bpm': 120, 'bar_seconds': 2., 'analysed': True}), 0))
        assert dj_engine.cached_analysis(aac, dj_engine.analysis_identity(refs[key])) is None
    with (patch.object(_auto_mode, '_get_api', return_value=api),
          patch.object(_auto_mode, '_dj_source_path', side_effect=lambda _, item: paths[item['id']]),
          patch.object(_auto_mode, 'request_analysis'),
          patch.object(_auto_mode, '_planner_context_related', return_value=_auto_mode._GraphWalk([], False, False))):
        client = _make_app().test_client()
        pair = {'from': refs['outgoing'], 'to': refs['incoming']}
        cold = client.post('/api/discovery/music/dj-transition', json=pair).get_json()
        assert cold['measured'] is False
        assert cold['transition']['sync']['alignment'] == 'none'
        assert cold['transition']['sync']['out_bar_seconds'] is None
        analyses = {}
        with patch.object(store, '_decode_measured', wraps=store._decode_measured) as decode:
            for key in refs:
                analyses[key] = dj_engine.analyse_audio(paths[key], dj_engine.analysis_identity(refs[key]))
                assert analyses[key]['version'] == ANALYSER_VERSION
                assert analyses[key]['bpm'] == pytest.approx(120, abs=.05)
                assert analyses[key]['tempo_confidence'] > .6
            assert decode.call_count == 2
        with patch.object(store, '_decode_measured', side_effect=AssertionError('warm HTTP must not decode')):
            refined = client.post('/api/discovery/music/dj-transition', json=pair).get_json()
            assert refined['measured'] is True
            expected = refined['transition']
            assert expected['technique'] in BEATMATCH_TECHNIQUES
            assert expected['sync']['alignment'] in ('beats', 'bars')
            if expected['sync']['alignment'] == 'bars':
                for analysis in analyses.values():
                    assert analysis['metre_confidence'] > 0 and analysis['downbeat_confidence'] > 0
                assert out_size == in_size
                assert expected['sync']['in_bar_seconds'] / expected['playback_rate'] == pytest.approx(
                    expected['sync']['out_bar_seconds'], abs=.000005)
            common = {'seed': refs['outgoing']}
            for endpoint, payload in [
                ('dj-plan', {**common, 'sources': [{'id': 's', 'tracks': [refs['incoming']]}], 'limit': 1}),
                ('dj-place', {**common, 'track': refs['incoming'], 'requested_queue_id': 'requested'}),
                ('dj-repair', {**common, 'route': [{**refs['incoming'], 'queue_id': 'requested', 'route_kind': 'user'}]}),
            ]:
                response = client.post(f'/api/discovery/music/{endpoint}', json=payload)
                assert response.status_code == 200, response.get_json()
                body = response.get_json()
                assert body['items'][0]['transition'] == expected, endpoint
                if endpoint == 'dj-plan':
                    summary = body['items'][0]['analysis']
                    assert 'metric_regions' not in summary
                    assert 'beat_grid' not in summary
                    assert summary['beats_per_bar'] == analyses['incoming']['beats_per_bar']
                    assert summary['metre_confidence'] == analyses['incoming']['metre_confidence']
            with patch.object(_auto_mode, '_build_music_plan', return_value=({'items': [refs['incoming']]}, 200)):
                legacy = client.post('/api/discovery/music/dj-plan', json={**common, 'limit': 1})
            assert legacy.get_json()['items'][0]['transition'] == expected
            # Requests enter a separate legacy orchestration path, retaining
            # the same AAC/cache evidence and common metric planner.
            for request_row in (
                {'id': 'track-request', 'kind': 'track', 'track': refs['incoming']},
                {'id': 'artist-request', 'kind': 'artist', 'artist': {'name': 'Metric fixture'}},
            ):
                with (patch.object(_auto_mode, '_build_music_plan', return_value=({'items': []}, 200)),
                      patch.object(_auto_mode, '_planner_artist_candidates', return_value=[dict(refs['incoming'])])):
                    requested = client.post('/api/discovery/music/dj-plan', json={
                        **common, 'requests': [request_row], 'limit': 1})
                assert requested.status_code == 200
                assert requested.get_json()['requests'][0]['status'] == 'planned'
                assert requested.get_json()['items'][0]['transition'] == expected
            for key in refs:
                assert dj_engine.analyse_audio(paths[key], dj_engine.analysis_identity(refs[key]))['version'] == ANALYSER_VERSION
