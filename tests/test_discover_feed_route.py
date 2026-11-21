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


import shared.api.routes.discovery as _disc_routes
import shared.api.routes.discovery_graph as _disc_graph
discovery_bp = _disc_routes.discovery_bp

import pytest
from flask import Flask

from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import init_telemetry, reset_telemetry
from shared.user_context import current_user_id


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

    fake_emit = MagicMock()

    return {
        "get_library": MagicMock(return_value=_FakeLibrary(metadata)),
        "get_downloader": MagicMock(return_value=mock_dl_service),
        "queue_manager_dl": MagicMock(),
        "start_downloader_pump": MagicMock(),
        "parse_intake_item": MagicMock(),
        "favourite_library_ids": MagicMock(return_value=[]),
        "emit_to_user": fake_emit,
    }, mock_dl_service, fake_emit


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    reset_runtime()
    reset_telemetry()
    _make_runtime(tmp_path)
    # Reset the discover executor and inflight state between tests.
    _disc_graph._discover_executor = None
    _disc_graph._discover_inflight.clear()
    _disc_graph._discover_subscribers.clear()
    _disc_graph._discover_refresh_users.clear()
    import shared.api.routes.discovery_common as _disc_common
    with _disc_common._DISCOVERY_FEED_LOCK:
        _disc_common._DISCOVERY_FEED_CACHE.clear()
        _disc_common._DISCOVERY_FEED_INFLIGHT.clear()
        _disc_common._DISCOVERY_FEED_DIRTY.clear()
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
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

    cached_recs = [{"id": "rec1111111", "title": "Related", "channel": "Other", "duration": 200}]
    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = cached_recs
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)

    from shared import related_work
    monkeypatch.setattr(related_work, "instance_db", lambda: mock_db)

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
    fake_sio.assert_not_called()


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
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = None  # cache miss
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)
    from shared import related_work
    monkeypatch.setattr(related_work, "instance_db", lambda: mock_db)

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

    monkeypatch.setattr(_disc_graph, "_get_discover_executor", lambda: _InlineExecutor())

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
    fake_sio.assert_called_once()
    emit_args = fake_sio.call_args
    assert emit_args.args[0] == "discover_seed_ready"
    assert emit_args.args[1]["seed_track_id"] == "t1"
    assert emit_args.args[1]["recs"][0]["id"] == "rel1111111"
    # The mix belongs to the account that asked for it, not to every socket.
    assert emit_args.kwargs["user_id"] == current_user_id()


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
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = None
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)

    # Simulate an already-in-flight future for this video_id.
    from concurrent.futures import Future

    existing_fut = Future()
    existing_fut.set_running_or_notify_cancel()
    _disc_graph._discover_inflight[_VID3] = existing_fut

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
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

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
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = [{"id": "hit", "title": "Cached Rec"}]
    mock_db.get_cached_resolution.return_value = {"id": _VID4}
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)

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
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = None  # miss
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)

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

    monkeypatch.setattr(_disc_graph, "_get_discover_executor", lambda: _InlineExecutor())

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
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

    called = MagicMock()
    monkeypatch.setattr(_disc_graph, "warm_discover_top_seeds", called)

    client = _make_app().test_client()
    res = client.post("/api/discover/warm", json={})
    body = res.get_json()

    assert res.status_code == 200
    assert body["warmed"] == -1
    called.assert_called_once()


def test_seed_resolution_records_the_running_time_it_was_made_for(monkeypatch):
    """A seed resolved for its track's running time says so, so a later caller
    after another cut cannot take the row away from the discovery graph."""
    track = _track("t1", "Song A", "Artist A", youtube_id=None)
    track.duration = 235
    api, mock_dl, _ = _mock_api(LibraryMetadata(version=1, tracks=[track], playlists={}, settings={}))
    mock_dl.downloader.search_match_candidates.return_value = [
        {"id": _VID4, "title": "Artist A - Song A (Audio)", "channel": "Artist A", "duration": 236},
    ]
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)
    mock_db = MagicMock()
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)

    assert _disc_graph._resolve_seed_yt_id(track) == _VID4
    stored = mock_db.set_cached_resolution.call_args.args[2]
    assert stored["id"] == _VID4 and stored["requested_duration"] == 235


def test_a_request_joining_a_running_expansion_is_told_when_it_lands(monkeypatch):
    """Two feeds wanting one seed share an extraction, and both hear back."""
    import threading

    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Song A", "Artist A", _VID3)],
        playlists={},
        settings={},
    )
    api, mock_dl, fake_emit = _mock_api(metadata, related_results=[{"id": "rel4444444", "title": "R"}])
    release = threading.Event()
    real = mock_dl.downloader.get_related_videos.return_value

    def slow(*_args, **_kwargs):
        release.wait(5)
        return real

    mock_dl.downloader.get_related_videos.side_effect = slow
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)
    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = None
    mock_db.get_cached_resolution.return_value = None
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)
    from shared import related_work
    monkeypatch.setattr(related_work, "instance_db", lambda: mock_db)

    client = _make_app().test_client()
    first = client.get("/api/discover/feed?seeds=t1&limit=10").get_json()
    second = client.get("/api/discover/feed?seeds=t1&limit=10").get_json()
    assert first["pending"] == second["pending"] == ["t1"]
    future = _disc_graph._discover_inflight[_VID3]
    release.set()
    future.result(5)

    assert mock_dl.downloader.get_related_videos.call_count == 1
    told = {call.args[1]["request_id"] for call in fake_emit.call_args_list}
    assert told == {first["request_id"], second["request_id"]}
    assert all(call.kwargs["user_id"] == current_user_id() for call in fake_emit.call_args_list)


def test_one_waiters_failed_ranking_does_not_silence_the_others(monkeypatch):
    calls = []
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: {
        "get_downloader": lambda open_browser=False: MagicMock(),
        "emit_to_user": lambda event, payload, user_id=None: calls.append((user_id, payload["recs"])),
    })
    from shared import related_work
    monkeypatch.setattr(related_work, "submit", lambda key, fn: type("F", (), {"result": lambda self: [{"id": "rel"}]})())

    def rank(rows, source):
        from shared.user_context import current_user_id
        if current_user_id() == "broken":
            raise TimeoutError("ranking store busy")
        return rows

    monkeypatch.setattr(_disc_graph, "rank_recommendation_rows", rank)
    _disc_graph._discover_subscribers[_VID3] = [("broken", "r1", "t1"), (current_user_id(), "r2", "t1")]
    _disc_graph._expand_seed(_VID3, current_user_id())

    assert calls == [("broken", []), (current_user_id(), [{"id": "rel"}])]


def test_feed_without_seeds_selects_seeds_and_preserves_empty_seeds_400(monkeypatch):
    """D6: GET /api/discover/feed without `seeds` auto-selects graph seeds via
    `select_graph_seed_tracks`, while `?seeds=` keeps HTTP 400 validation."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[
            _track("t1", "Song One", "Artist One", _VID1),
            _track("t2", "Song Two", "Artist Two", _VID2),
        ],
        playlists={},
        settings={},
    )
    api, _mock_dl, _fake_emit = _mock_api(metadata)
    api["favourite_library_ids"].return_value = ["t2"]
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)

    cached_recs = [{"id": "rec11111111", "title": "Related Auto", "channel": "Other", "duration": 200}]
    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = cached_recs
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)

    with patch("shared.discovery_intelligence.rank_recommendation_rows", side_effect=lambda rows, **kw: rows), \
         patch.object(_disc_graph, "rank_recommendation_rows", side_effect=lambda rows, **kw: rows):
        client = _make_app().test_client()
        empty_res = client.get("/api/discover/feed?seeds=&limit=10")
        assert empty_res.status_code == 400

        auto_res = client.get("/api/discover/feed?limit=10")
        assert auto_res.status_code == 200
        body = auto_res.get_json()
        assert body["pending"] == []
        assert [entry["seed_track_id"] for entry in body["ready"]]
        assert set(entry["seed_track_id"] for entry in body["ready"]).issubset({"t1", "t2"})


def test_expand_seed_invalidates_discovery_feed_cache_and_schedules_refresh(monkeypatch):
    """D6: Successful graph expansion invalidates the active discovery feed cache
    and schedules a personalized discovery feed refresh for waiting users."""
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: {
        "get_downloader": lambda open_browser=False: MagicMock(),
        "emit_to_user": MagicMock(),
    })
    from shared import related_work
    monkeypatch.setattr(
        related_work,
        "submit",
        lambda key, fn: type("F", (), {"result": lambda self: [{"id": "rel11111111", "title": "Rel"}]})(),
    )
    monkeypatch.setattr(_disc_graph, "rank_recommendation_rows", lambda rows, source: rows)

    scheduled = []
    with patch(
        "shared.api.routes.discovery_common._invalidate_personalized_cache_for_user",
        return_value=[(f"discovery-feed-v4:{current_user_id()}:10", 10)],
    ) as inv_mock, patch(
        "shared.api.routes.discovery_feed._schedule_discovery_feed_refresh",
        side_effect=lambda cache_key, uid, feed_limit, rotate=False: scheduled.append(
            (cache_key, uid, feed_limit, rotate)
        ),
    ):
        _disc_graph._discover_subscribers[_VID4] = [(current_user_id(), "req-1", "t1")]
        _disc_graph._expand_seed(_VID4, current_user_id())

    inv_mock.assert_called_once_with(current_user_id())
    assert scheduled == [(f"discovery-feed-v4:{current_user_id()}:10", current_user_id(), 10, False)]


def test_top_warm_seed_ids_uses_diacritic_folded_seed_scorer(monkeypatch):
    """D6: _top_warm_seed_ids delegates to select_graph_seed_tracks with
    diacritic-folded recent-artist affinity boosting and returns track IDs."""
    from types import SimpleNamespace

    metadata = LibraryMetadata(
        version=1,
        tracks=[
            _track("t1", "Song 1", "José González"),
            _track("t2", "Song 2", "Jose Gonzalez"),
            _track("t3", "Song 3", "Other Artist"),
        ],
        playlists={},
        settings={},
    )
    api, _mock_dl, _fake_emit = _mock_api(metadata)
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)
    with patch(
        "shared.discovery_seeds.load_listening_event_rollups",
        return_value=SimpleNamespace(recent_artists={"jose gonzalez"}),
    ):
        selected = _disc_graph._top_warm_seed_ids(limit=2)

    assert selected == ["t2", "t1"]


def test_invalidate_personalized_cache_for_user_isolation_and_dirty_inflight():
    """D6: _invalidate_personalized_cache_for_user isolates user prefixes, expires
    cached TTLs, marks inflight keys dirty, and handles invalid limit suffixes."""
    import shared.api.routes.discovery_common as _disc_common

    with _disc_common._DISCOVERY_FEED_LOCK:
        _disc_common._DISCOVERY_FEED_CACHE["discovery-feed-v4:alice:10"] = (9999999999.0, 9999999999.0, {"ok": 1})
        _disc_common._DISCOVERY_FEED_CACHE["discovery-feed-v4:alice:bad"] = (9999999999.0, 1.0, {"ok": 2})
        _disc_common._DISCOVERY_FEED_CACHE["discovery-feed-v4:bob:12"] = (9999999999.0, 9999999999.0, {"ok": 3})
        _disc_common._DISCOVERY_FEED_INFLIGHT.add("discovery-feed-v4:alice:16")

    entries = _disc_common._invalidate_personalized_cache_for_user("alice")
    assert entries == [
        ("discovery-feed-v4:alice:10", 10),
        ("discovery-feed-v4:alice:bad", 10),
        ("discovery-feed-v4:alice:16", 16),
    ]
    assert _disc_common._DISCOVERY_FEED_CACHE["discovery-feed-v4:alice:10"][0] == 0
    assert _disc_common._DISCOVERY_FEED_CACHE["discovery-feed-v4:alice:bad"][1] > 1.0
    assert _disc_common._DISCOVERY_FEED_CACHE["discovery-feed-v4:bob:12"][0] == 9999999999.0
    assert "discovery-feed-v4:alice:16" in _disc_common._DISCOVERY_FEED_DIRTY


def test_refresh_discovery_feed_cache_reruns_once_when_invalidated_inflight(monkeypatch):
    """D6: If _expand_seed invalidates while _refresh_discovery_feed_cache is in flight,
    the stale body is stored with TTL=0 and one follow-up refresh runs cleanly."""
    import shared.api.routes.discovery_common as _disc_common
    import shared.api.routes.discovery_feed as _disc_feed

    builds = 0
    emitted = []
    submitted = []

    def fake_build(limit, *, include_external=True, rotate=False):
        nonlocal builds
        builds += 1
        if builds == 1:
            # Simulate concurrent graph expansion invalidating this inflight key.
            assert _disc_common._invalidate_personalized_cache_for_user("alice") == [("discovery-feed-v4:alice:10", 10)]
            assert not _disc_feed._schedule_discovery_feed_refresh("discovery-feed-v4:alice:10", "alice", 10)
        return {"generated_at": 1000 + builds, "items": [{"id": f"item:{builds}"}]}

    monkeypatch.setattr(_disc_feed, "_build_discovery_feed_body", fake_build)
    monkeypatch.setattr(_disc_feed, "_get_api", lambda: {"emit_to_user": lambda ev, payload, user_id=None: emitted.append((ev, payload, user_id))})
    monkeypatch.setattr(_disc_feed._DISCOVERY_FEED_EXECUTOR, "submit", lambda fn, *args, **kwargs: submitted.append((fn, args, kwargs)))

    cache_key = "discovery-feed-v4:alice:10"
    _disc_common._DISCOVERY_FEED_INFLIGHT.add(cache_key)
    _disc_feed._refresh_discovery_feed_cache(cache_key, "alice", 10, rotate=True)

    # First pass must leave TTL=0 and key inflight until follow-up finishes.
    assert _disc_common._DISCOVERY_FEED_CACHE[cache_key][0] == 0
    assert cache_key in _disc_common._DISCOVERY_FEED_INFLIGHT
    assert len(submitted) == 1

    # Run the queued follow-up pass: even if another invalidation occurs, follow-up is bounded to 1.
    fn, args, kwargs = submitted[0]
    fn(*args, **kwargs)
    assert cache_key not in _disc_common._DISCOVERY_FEED_INFLIGHT
    assert _disc_common._DISCOVERY_FEED_CACHE[cache_key][0] > 0
    assert _disc_common._DISCOVERY_FEED_CACHE[cache_key][2]["items"] == [{"id": "item:2"}]
    assert len(emitted) == 2


def test_feed_without_seeds_rotates_and_handles_empty_library(monkeypatch):
    """D6: Omitted `seeds` records graph seeds so repeated calls rotate, and
    returns empty lists with 200 OK when the library is empty."""
    from shared.discovery_seeds import _RECENT_GRAPH_SEEDS, _SEED_LOCK

    with _SEED_LOCK:
        _RECENT_GRAPH_SEEDS.clear()

    tracks = [_track(f"t{i}", f"Song {i}", f"Artist {i}", f"vid{i:08d}") for i in range(1, 11)]
    metadata = LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})
    api, _mock_dl, _fake_emit = _mock_api(metadata)
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: api)
    mock_db = MagicMock()
    mock_db.get_related_mix.return_value = [{"id": "rec11111111", "title": "Rec"}]
    monkeypatch.setattr(_disc_graph, "instance_db", lambda: mock_db)
    monkeypatch.setattr(_disc_graph, "rank_recommendation_rows", lambda rows, source: rows)

    client = _make_app().test_client()
    first = [e["seed_track_id"] for e in client.get("/api/discover/feed?limit=10").get_json()["ready"]]
    second = [e["seed_track_id"] for e in client.get("/api/discover/feed?limit=10").get_json()["ready"]]
    assert len(first) == 5
    assert len(second) == 5
    assert set(first) != set(second)

    metadata.tracks = []
    empty = client.get("/api/discover/feed?limit=10")
    assert empty.status_code == 200
    assert empty.get_json()["ready"] == []
    assert empty.get_json()["pending"] == []


def test_expand_seed_refreshes_non_request_waiter_and_subscriber_across_users(monkeypatch):
    """D6: If user A starts a non-request expansion and user B joins as a subscriber
    while inflight, _expand_seed refreshes both user A and user B's caches."""
    monkeypatch.setattr(_disc_graph, "_get_api", lambda: {
        "get_downloader": lambda open_browser=False: MagicMock(),
        "emit_to_user": MagicMock(),
    })
    from shared import related_work

    fut = Future()
    monkeypatch.setattr(related_work, "submit", lambda key, fn: fut)
    monkeypatch.setattr(_disc_graph, "rank_recommendation_rows", lambda rows, source: rows)

    mock_exec = MagicMock()
    monkeypatch.setattr(_disc_graph, "_get_discover_executor", lambda: mock_exec)

    with patch("shared.user_context.current_user_id", return_value="alice"):
        _disc_graph._schedule_expand(_VID5)
    with patch("shared.user_context.current_user_id", return_value="bob"):
        _disc_graph._schedule_expand(_VID5, request_id="req-b", seed_track_id="t-b")

    inv_users = []
    fut.set_result([{"id": "rel55555555", "title": "Rel"}])
    with patch(
        "shared.api.routes.discovery_common._invalidate_personalized_cache_for_user",
        side_effect=lambda uid: inv_users.append(uid) or [],
    ):
        _disc_graph._expand_seed(_VID5, "alice")

    assert set(inv_users) == {"alice", "bob"}
