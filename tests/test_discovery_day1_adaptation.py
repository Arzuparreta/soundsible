"""Tests for Day-1 passive Discovery adaptation (U3)."""
from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import MagicMock

from flask import Flask
import pytest

from shared.api.routes import discovery as discovery_routes
from shared.api.routes import discovery_common
from shared.api.routes import discovery_feed
from shared.api.routes.library import library_bp
from shared.api.routes.scrobble import scrobble_bp
from shared.discovery_intelligence import load_listening_event_rollups
from shared.hardening import _reset_rate_limits_for_tests
import shared.hardening as hardening_mod
import shared.realtime as realtime_mod
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.scrobble import service as scrobble_service_mod
from shared.scrobble.clients import Outcome, Reply
from shared.telemetry import init_telemetry, reset_telemetry
from shared.user_context import user_context


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


class _InlineExecutor:
    def submit(self, fn, *args, **kwargs):
        fn(*args, **kwargs)
        return MagicMock()


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    reset_runtime()
    reset_telemetry()
    _reset_rate_limits_for_tests()
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    with discovery_common._DISCOVERY_FEED_LOCK:
        discovery_common._DISCOVERY_FEED_CACHE.clear()
        discovery_common._DISCOVERY_FEED_INFLIGHT.clear()
        discovery_common._DISCOVERY_FEED_DIRTY.clear()
    yield
    with discovery_common._DISCOVERY_FEED_LOCK:
        discovery_common._DISCOVERY_FEED_CACHE.clear()
        discovery_common._DISCOVERY_FEED_INFLIGHT.clear()
        discovery_common._DISCOVERY_FEED_DIRTY.clear()
    reset_telemetry()
    reset_runtime()


def test_music_search_played_feeds_rollup_and_wakes_cold_cached_feed(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(discovery_routes.discovery_bp)
    emitted = []
    monkeypatch.setattr(
        discovery_feed,
        "_get_api",
        lambda: {
            "get_library": lambda: SimpleNamespace(metadata=SimpleNamespace(tracks=[], playlists={}), refresh_if_stale=lambda: None),
            "favourite_library_ids": lambda: [],
            "emit_to_user": lambda event, payload=None, user_id=None: emitted.append((event, payload, user_id)),
        },
    )
    monkeypatch.setattr(discovery_feed, "_DISCOVERY_FEED_EXECUTOR", _InlineExecutor())
    monkeypatch.setattr(
        discovery_feed,
        "_build_discovery_feed_body",
        lambda limit, **kw: {
            "generated_at": 123456,
            "browse_sections": [{"id": "artists", "popular": False, "items": [{"id": "deezer:artist:1", "title": "Robe"}]}],
            "sections": [{"id": "more_like_robe", "item_ids": ["deezer:9"]}],
            "needs_seed": False,
        },
    )

    cache_key = "discovery-feed-v4:alice:10"
    with discovery_common._DISCOVERY_FEED_LOCK:
        discovery_common._DISCOVERY_FEED_CACHE[cache_key] = (
            time.time() + 180,
            time.time() + 3600,
            {"needs_seed": True, "browse_sections": [{"id": "artists", "popular": True, "items": [{"id": "p1"}]}]},
        )

    with app.test_client() as client, user_context("alice"):
        res = client.post(
            "/api/discovery/events",
            json={
                "event": "music_search_played",
                "payload": {"title": "Mayéutica", "artist": "Robe", "youtube_id": "abc12345678", "source": "search"},
            },
        )
        assert res.status_code == 200
        assert res.get_json()["recorded"] is True
        rollup = load_listening_event_rollups()
        assert rollup.artist_plays["robe"] == 1
        assert rollup.event_count == 1

    assert emitted == [("discovery_feed_ready", {"limit": 10, "generated_at": 123456, "browse_error": False}, "alice")]
    with discovery_common._DISCOVERY_FEED_LOCK:
        assert discovery_common._DISCOVERY_FEED_CACHE[cache_key][2]["needs_seed"] is False


def test_warm_feed_invalidates_ttl_without_spawning_refresh_on_normal_play(monkeypatch):
    submit_mock = MagicMock()
    monkeypatch.setattr(discovery_feed, "_DISCOVERY_FEED_EXECUTOR", SimpleNamespace(submit=submit_mock))
    cache_key = "discovery-feed-v4:alice:10"
    with discovery_common._DISCOVERY_FEED_LOCK:
        discovery_common._DISCOVERY_FEED_CACHE[cache_key] = (
            time.time() + 180,
            time.time() + 3600,
            {"needs_seed": False, "browse_sections": [{"id": "artists", "popular": False, "items": [{"id": "a1"}]}]},
        )

    assert discovery_feed.notify_discovery_signal("alice", always_refresh=False) is False
    submit_mock.assert_not_called()
    with discovery_common._DISCOVERY_FEED_LOCK:
        assert discovery_common._DISCOVERY_FEED_CACHE[cache_key][0] == 0

    assert discovery_feed.notify_discovery_signal("bob", always_refresh=True) is False
    submit_mock.assert_not_called()


def test_saved_entity_and_favourite_and_scrobble_connect_wake_cached_feed(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(library_bp)
    app.register_blueprint(scrobble_bp)

    monkeypatch.setattr(hardening_mod, "get_request_auth_context", lambda **kw: {"kind": "owner"})
    monkeypatch.setattr(realtime_mod, "emit_to_user", lambda *a, **kw: None)

    emitted = []
    monkeypatch.setattr(
        discovery_feed,
        "_get_api",
        lambda: {
            "get_library": lambda: SimpleNamespace(metadata=SimpleNamespace(tracks=[], playlists={}), refresh_if_stale=lambda: None),
            "favourite_library_ids": lambda: [],
            "emit_to_user": lambda event, payload=None, user_id=None: emitted.append((event, user_id)),
        },
    )
    monkeypatch.setattr(discovery_feed, "_DISCOVERY_FEED_EXECUTOR", _InlineExecutor())
    monkeypatch.setattr(
        discovery_feed,
        "_build_discovery_feed_body",
        lambda limit, **kw: {"generated_at": 555, "browse_sections": [{"id": "artists", "popular": False, "items": []}], "needs_seed": False},
    )

    class _FakeFavourites:
        def set_favourite(self, fav):
            return True

    fake_lib_api = {
        "get_library": lambda: SimpleNamespace(metadata=SimpleNamespace(tracks=[], playlists={})),
        "favourites_manager": _FakeFavourites(),
        "get_downloader": MagicMock(),
        "emit_to_user": lambda *a, **kw: None,
    }
    import shared.api.routes.library as library_routes_mod
    monkeypatch.setattr(library_routes_mod, "_get_api", lambda: fake_lib_api)

    class _FakeLb:
        def __init__(self, token, server="", *, maloja=False):
            pass

        def validate(self):
            return Reply(Outcome.OK, data={"username": "alice"})

    monkeypatch.setattr(scrobble_service_mod, "ListenBrainzClient", _FakeLb)
    import shared.api.routes.scrobble as scrobble_routes_mod
    monkeypatch.setattr(scrobble_routes_mod, "current_user_id", lambda: "alice")

    cache_key = "discovery-feed-v4:alice:10"

    with app.test_client() as client, user_context("alice"):
        with discovery_common._DISCOVERY_FEED_LOCK:
            discovery_common._DISCOVERY_FEED_CACHE[cache_key] = (
                time.time() + 180,
                time.time() + 3600,
                {"needs_seed": True, "browse_sections": []},
            )
        r1 = client.put(
            "/api/library/saved-entities",
            json={
                "entry": {
                    "kind": "artist",
                    "name": "Extremoduro",
                    "destination": "/artist/Extremoduro?deezer_id=77&view=discover",
                },
                "saved": True,
            },
        )
        assert r1.status_code == 200
        assert ("discovery_feed_ready", "alice") in emitted

        emitted.clear()
        with discovery_common._DISCOVERY_FEED_LOCK:
            discovery_common._DISCOVERY_FEED_CACHE[cache_key] = (
                time.time() + 180,
                time.time() + 3600,
                {"needs_seed": False, "browse_sections": [{"id": "artists", "popular": False, "items": []}]},
            )
        r2 = client.post(
            "/api/library/favourites/toggle",
            json={"favourite": {"keys": ["yt:abc12345678"], "artist": "Marea", "title": "Corazón"}},
        )
        assert r2.status_code == 200
        assert ("discovery_feed_ready", "alice") in emitted

        emitted.clear()
        with discovery_common._DISCOVERY_FEED_LOCK:
            discovery_common._DISCOVERY_FEED_CACHE[cache_key] = (
                time.time() + 180,
                time.time() + 3600,
                {"needs_seed": True, "browse_sections": []},
            )
        r3 = client.put("/api/scrobble/listenbrainz", json={"token": "lb-ok"})
        assert r3.status_code == 200
        assert ("discovery_feed_ready", "alice") in emitted
