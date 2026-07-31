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
from shared.database import instance_db
from shared.providers import deezer
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


def test_dj_plan_validates_profile_and_requires_seed(tmp_path):
    _make_runtime(tmp_path)
    client = _make_app().test_client()
    assert client.post("/api/discovery/music/dj-plan", json={}).status_code == 400
    assert client.post(
        "/api/discovery/music/dj-plan",
        json={"dj_profile": "mystery", "seed": {"title": "Song", "artist": "Artist"}},
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
        "energy": 0.5,
        "confidence": 0.9,
        "outro_cue": 130,
        "intro_cue": 8,
        "bar_seconds": 2,
    }
    mock_api = _mock_api()
    mock_api["get_core"].return_value = (_FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None)
    with (
        patch.object(_disc_routes, "_get_api", return_value=mock_api),
        patch.object(_disc_routes, "_build_music_plan", return_value=(base, 200)),
        patch.object(_disc_routes, "_dj_item_analysis", return_value=features),
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
        "energy": 0.7,
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
        patch.object(_disc_routes, "_get_api", return_value=mock_api),
        patch.object(_disc_routes, "_build_music_plan", return_value=(base, 200)),
        patch.object(_disc_routes, "_planner_artist_candidates", return_value=[target]),
        patch.object(_disc_routes, "_dj_item_analysis", return_value=features),
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
        patch.object(_disc_routes, "_planner_context_related", return_value=(related, False)),
        patch.object(_disc_routes, "_planner_related_artist_pool", return_value=([], [])),
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


def test_dj_command_recognises_an_exact_artist_without_an_llm(tmp_path):
    _make_runtime(tmp_path)
    with patch.object(
        _disc_routes,
        "_deezer_artist_top_rows",
        return_value=[{"artist": {"id": 1, "name": "Oliver Heldens"}}],
    ):
        response = _make_app().test_client().post(
            "/api/discovery/music/dj-command",
            json={"text": "pon Oliver Heldens pero con más energía"},
        )

    assert response.status_code == 200
    body = response.get_json()
    assert body["request"] == {
        "kind": "artist",
        "label": "Oliver Heldens",
        "artist": {"name": "Oliver Heldens"},
    }
    assert body["direction_patch"]["energy"] == 0.7
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
        patch.object(_disc_routes, "_get_api", return_value=mock_api),
        patch.object(
            _disc_routes,
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

    with patch.object(_disc_routes, "_get_api", return_value=api), \
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

    with patch.object(_disc_routes, "_get_api", return_value=api), \
         patch.object(deezer, "session", return_value=MagicMock(get=MagicMock(return_value=_FakeResponse({"tracks": {"data": []}})))), \
         patch.object(_disc_routes, "_schedule_discovery_feed_refresh", return_value=False):
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

    with patch.object(_disc_routes, "_get_api", return_value=api), \
         patch.object(_disc_routes, "_deezer_json", return_value={"data": []}), \
         patch.object(_disc_routes, "_cached_related_feed_candidates"), \
         patch.object(_disc_routes, "_schedule_discovery_feed_refresh", return_value=False):
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
        patch.object(_disc_routes, "_get_api", return_value=mock_api),
        patch.object(_disc_routes, "_build_music_plan", return_value=(base, 200)),
        patch.object(_disc_routes, "_dj_source_path", return_value="/library/candidate.mp3"),
        patch.object(_disc_routes, "cached_analysis", return_value=None),
        patch.object(_disc_routes, "request_analysis", side_effect=lambda *a, **k: queued.append(a[1])),
        patch("shared.dj_engine._decode", side_effect=AssertionError("decoded during a plan request")),
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


def test_dj_transition_upgrades_a_pair_once_it_has_been_measured(tmp_path):
    _make_runtime(tmp_path)
    measured = {
        "duration": 220,
        "bpm": 120,
        "key": "C",
        "mode": "major",
        "energy": 0.6,
        "confidence": 0.9,
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
        patch.object(_disc_routes, "_get_api", return_value=mock_api),
        patch.object(_disc_routes, "_dj_source_path", return_value="/library/track.mp3"),
        patch.object(_disc_routes, "cached_analysis", return_value=measured),
    ):
        response = _make_app().test_client().post("/api/discovery/music/dj-transition", json=pair)

    assert response.status_code == 200
    body = response.get_json()
    assert body["measured"] is True
    assert body["transition"]["technique"] == "long_blend"
    # Pulled back from the measured outro so the whole blend fits in the file.
    assert body["transition"]["out_cue"] + body["transition"]["overlap_seconds"] <= 220

    # Nothing measured yet: answer immediately with the conservative plan
    # rather than making the player wait for a decode it cannot use in time.
    with (
        patch.object(_disc_routes, "_get_api", return_value=mock_api),
        patch.object(_disc_routes, "_dj_source_path", return_value=None),
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
