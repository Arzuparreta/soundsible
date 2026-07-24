"""Route-level integration tests for GET /api/discover/feed and the async
expansion worker (socketio streaming, in-flight dedup, persistent cache)."""

import importlib
import importlib.util
import sys
from concurrent.futures import Future
from pathlib import Path
from unittest.mock import MagicMock, patch

for _m in ("watchdog", "watchdog.events", "watchdog.observers"):
    try:
        importlib.import_module(_m)
    except ImportError:
        sys.modules[_m] = MagicMock()

_ROOT = Path(__file__).resolve().parents[1]


def _load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, _ROOT / rel_path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_disc_routes = _load_module("discover_feed_routes_under_test", "shared/api/routes/discovery.py")
discovery_bp = _disc_routes.discovery_bp

import pytest
from flask import Flask

from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import init_telemetry, reset_telemetry


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


def _track(track_id: str, title: str, artist: str, youtube_id: str | None = None) -> Track:
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
        youtube_id=youtube_id,
    )

# 11-char YouTube video ids (the only length YouTube uses).
_VID1 = "vid11111111"
_VID2 = "vid22222222"
_VID3 = "vid33333333"
_VID4 = "vid44444444"
_VID5 = "vid55555555"
_VID6 = "vid66666666"


def _mock_api(metadata, related_results=None):
    """Build a mock api dict for _get_api()."""
    mock_dl_service = MagicMock()
    mock_dl_service.downloader.get_related_videos.return_value = related_results or []
    mock_dl_service.downloader.search_youtube.return_value = []

    fake_socketio = MagicMock()

    mod_mock = MagicMock()
    mod_mock.socketio = fake_socketio
    mod_mock.favourites_manager = MagicMock()
    mod_mock.favourites_manager.get_all.return_value = []

    return {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "get_downloader": MagicMock(return_value=mock_dl_service),
        "queue_manager_dl": MagicMock(),
        "start_downloader_pump": MagicMock(),
        "parse_intake_item": MagicMock(),
        "_mod": mod_mock,
    }, mock_dl_service, fake_socketio


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    reset_runtime()
    reset_telemetry()
    _make_runtime(tmp_path)
    # Reset the discover executor and inflight state between tests.
    _disc_routes._discover_executor = None
    _disc_routes._discover_inflight.clear()
    _disc_routes._discover_request_seeds.clear()
    yield
    reset_telemetry()
    reset_runtime()


def test_feed_returns_cache_hits_immediately(monkeypatch):
    """When the persistent cache has results for all seeds, the response is
    instant with no pending and no scheduled expansions."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Song A", "Artist A", _VID1)],
        playlists={},
        settings={},
    )
    api, mock_dl, fake_sio = _mock_api(metadata)
    monkeypatch.setattr(_disc_routes, "_get_api", lambda: api)

    cached_recs = [{"id": "rec1111111", "title": "Related", "channel": "Other", "duration": 200}]
    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = cached_recs
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_routes, "instance_db", lambda: mock_db)

    client = _make_app().test_client()
    res = client.get("/api/discover/feed?seeds=t1&limit=10")
    body = res.get_json()

    assert res.status_code == 200
    assert len(body["ready"]) == 1
    assert body["ready"][0]["seed_track_id"] == "t1"
    assert body["ready"][0]["recs"][0]["id"] == "rec1111111"
    assert body["pending"] == []
    # No expansion scheduled, no socketio emit.
    mock_dl.downloader.get_related_videos.assert_not_called()
    fake_sio.emit.assert_not_called()


def test_feed_schedules_async_expansion_for_cache_miss(monkeypatch):
    """When a seed misses the persistent cache, it goes into pending and an
    async expansion is scheduled."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Song A", "Artist A", _VID2)],
        playlists={},
        settings={},
    )
    api, mock_dl, fake_sio = _mock_api(
        metadata,
        related_results=[{"id": "rel1111111", "title": "Related", "channel": "Other"}],
    )
    monkeypatch.setattr(_disc_routes, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = None  # cache miss
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_routes, "instance_db", lambda: mock_db)

    # Use a real (inline) executor so the expansion runs synchronously enough
    # to verify the side effects. We patch the executor to run inline.
    from concurrent.futures import ThreadPoolExecutor

    class _InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fut = Future()
            try:
                fut.set_result(fn(*args, **kwargs))
            except Exception as e:
                fut.set_exception(e)
            return fut

    monkeypatch.setattr(_disc_routes, "_get_discover_executor", lambda: _InlineExecutor())

    client = _make_app().test_client()
    res = client.get("/api/discover/feed?seeds=t1&limit=10")
    body = res.get_json()

    assert res.status_code == 200
    assert body["ready"] == []
    assert body["pending"] == ["t1"]
    assert body["request_id"] != ""
    # The expansion ran inline → yt-dlp was called, result persisted, socketio emitted.
    mock_dl.downloader.get_related_videos.assert_called_once()
    mock_db.set_related_mix.assert_called_once_with(_VID2, [{"id": "rel1111111", "title": "Related", "channel": "Other"}])
    fake_sio.emit.assert_called_once()
    emit_args = fake_sio.emit.call_args
    assert emit_args.args[0] == "discover_seed_ready"
    assert emit_args.args[1]["seed_track_id"] == "t1"
    assert emit_args.args[1]["recs"][0]["id"] == "rel1111111"


def test_feed_inflight_dedup_does_not_double_extract(monkeypatch):
    """When two requests want the same seed, only one extraction runs."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Song A", "Artist A", _VID3)],
        playlists={},
        settings={},
    )
    api, mock_dl, fake_sio = _mock_api(
        metadata,
        related_results=[{"id": "rel", "title": "R"}],
    )
    monkeypatch.setattr(_disc_routes, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = None
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_routes, "instance_db", lambda: mock_db)

    # Simulate an already-in-flight future for this video_id.
    from concurrent.futures import Future

    existing_fut = Future()
    existing_fut.set_running_or_notify_cancel()
    _disc_routes._discover_inflight[_VID3] = existing_fut

    client = _make_app().test_client()
    res = client.get("/api/discover/feed?seeds=t1&limit=10")
    body = res.get_json()

    assert res.status_code == 200
    assert body["pending"] == ["t1"]
    # The existing future is not done, so no new extraction was submitted.
    mock_dl.downloader.get_related_videos.assert_not_called()


def test_feed_empty_seeds_returns_400(monkeypatch):
    client = _make_app().test_client()
    res = client.get("/api/discover/feed?seeds=&limit=10")
    assert res.status_code == 400


def test_feed_skips_unknown_track_ids(monkeypatch):
    """A seed id that doesn't exist in the library is silently skipped."""
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, mock_dl, fake_sio = _mock_api(metadata)
    monkeypatch.setattr(_disc_routes, "_get_api", lambda: api)

    client = _make_app().test_client()
    res = client.get("/api/discover/feed?seeds=nonexistent&limit=10")
    body = res.get_json()

    assert res.status_code == 200
    assert body["ready"] == []
    assert body["pending"] == []


def test_feed_resolves_seed_without_youtube_id_via_resolution_cache(monkeypatch):
    """A library track without a youtube_id is resolved via the resolution cache."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Song A", "Artist A", youtube_id=None)],
        playlists={},
        settings={},
    )
    api, mock_dl, fake_sio = _mock_api(metadata)
    monkeypatch.setattr(_disc_routes, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = [{"id": "hit", "title": "Cached Rec"}]
    mock_db.get_cached_resolution.return_value = {"id": _VID4}
    monkeypatch.setattr(_disc_routes, "instance_db", lambda: mock_db)

    client = _make_app().test_client()
    res = client.get("/api/discover/feed?seeds=t1&limit=10")
    body = res.get_json()

    assert res.status_code == 200
    assert body["ready"][0]["recs"][0]["id"] == "hit"
    # Resolution cache was consulted.
    mock_db.get_cached_resolution.assert_called_once_with("Artist A", "Song A")


def test_warm_endpoint_schedules_expansion_for_misses(monkeypatch):
    """POST /api/discover/warm with explicit seeds schedules expansion for
    cache misses and returns immediately."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Song A", "Artist A", "vid555555555")],
        playlists={},
        settings={},
    )
    api, mock_dl, fake_sio = _mock_api(metadata)
    monkeypatch.setattr(_disc_routes, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = None  # miss
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_routes, "instance_db", lambda: mock_db)

    # Inline executor so we can verify the scheduling without real threads.
    from concurrent.futures import Future

    class _InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fut = Future()
            try:
                fut.set_result(fn(*args, **kwargs))
            except Exception as e:
                fut.set_exception(e)
            return fut

    monkeypatch.setattr(_disc_routes, "_get_discover_executor", lambda: _InlineExecutor())

    client = _make_app().test_client()
    res = client.post("/api/discover/warm", json={"seeds": ["t1"]})
    body = res.get_json()

    assert res.status_code == 200
    assert body["status"] == "scheduled"


def test_warm_endpoint_auto_selects_when_no_seeds_given(monkeypatch):
    """POST /api/discover/warm with no seeds calls warm_discover_top_seeds."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Song A", "Artist A", "vid666666666")],
        playlists={},
        settings={},
    )
    api, mock_dl, fake_sio = _mock_api(metadata)
    monkeypatch.setattr(_disc_routes, "_get_api", lambda: api)

    called = MagicMock()
    monkeypatch.setattr(_disc_routes, "warm_discover_top_seeds", called)

    client = _make_app().test_client()
    res = client.post("/api/discover/warm", json={})
    body = res.get_json()

    assert res.status_code == 200
    assert body["warmed"] == -1
    called.assert_called_once()
