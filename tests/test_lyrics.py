import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from flask import Flask

import shared.lyrics as lyrics_module
from shared.database import DatabaseManager
from shared.models import Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("library_routes_under_test", _ROOT / "shared/api/routes/library.py")
library_routes = importlib.util.module_from_spec(_SPEC)
sys.modules["library_routes_under_test"] = library_routes
_SPEC.loader.exec_module(library_routes)
library_bp = library_routes.library_bp


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
    app.register_blueprint(library_bp)
    return app


def _track() -> Track:
    return Track(
        id="track-1",
        title="Song",
        artist="Artist",
        album="Album",
        duration=200,
        file_hash="hash-1",
        original_filename="track-1.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


def _fake_api(track):
    return {
        "get_core": MagicMock(return_value=(MagicMock(), None, None)),
        "get_track_by_id": lambda lib, track_id: track if track and track_id == track.id else None,
    }


@pytest.fixture(autouse=True)
def _reset(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path)
    yield
    reset_runtime()


def test_lyrics_fetch_and_cache(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value={
        "synced": "[00:01.00] hello",
        "plain": "hello",
        "instrumental": False,
        "source": "lrclib",
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = client.get("/api/library/tracks/track-1/lyrics").get_json()
    assert body == {
        "synced": "[00:01.00] hello",
        "plain": "hello",
        "instrumental": False,
        "cached": False,
    }
    fetch.assert_called_once_with("Artist", "Song", "Album", 200)

    body = client.get("/api/library/tracks/track-1/lyrics").get_json()
    assert body["cached"] is True
    assert body["synced"] == "[00:01.00] hello"
    assert fetch.call_count == 1


def test_lyrics_not_found_negative_cache(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value={
        "synced": None,
        "plain": None,
        "instrumental": False,
        "source": "lrclib",
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = client.get("/api/library/tracks/track-1/lyrics").get_json()
    assert body["synced"] is None and body["cached"] is False

    body = client.get("/api/library/tracks/track-1/lyrics").get_json()
    assert body["cached"] is True
    assert fetch.call_count == 1


def test_lyrics_provider_error_not_cached(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value=None)
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = client.get("/api/library/tracks/track-1/lyrics").get_json()
    assert body == {"synced": None, "plain": None, "instrumental": False, "cached": False}

    client.get("/api/library/tracks/track-1/lyrics")
    assert fetch.call_count == 2


def test_lyrics_refresh_bypasses_cache(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value={
        "synced": None,
        "plain": "hello",
        "instrumental": False,
        "source": "lrclib",
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    client.get("/api/library/tracks/track-1/lyrics")
    client.get("/api/library/tracks/track-1/lyrics?refresh=1")
    assert fetch.call_count == 2


def test_lyrics_track_not_found(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(None))
    resp = _make_app().test_client().get("/api/library/tracks/missing/lyrics")
    assert resp.status_code == 404


def test_db_negative_cache_expires(tmp_path):
    db = DatabaseManager()
    db.set_lyrics("t1", synced=None, plain=None, instrumental=False, source="lrclib")
    assert db.get_lyrics("t1") is not None
    with db._get_connection() as conn:
        conn.execute(
            "UPDATE track_lyrics SET checked_at = datetime('now', '-8 days') WHERE track_id = 't1'"
        )
    assert db.get_lyrics("t1") is None

    db.set_lyrics("t2", synced="[00:01.00] x", plain="x", instrumental=False, source="lrclib")
    with db._get_connection() as conn:
        conn.execute(
            "UPDATE track_lyrics SET checked_at = datetime('now', '-30 days') WHERE track_id = 't2'"
        )
    assert db.get_lyrics("t2") is not None


def test_fetch_lyrics_search_fallback_picks_closest_duration(monkeypatch):
    def fake_get(path, params):
        if path == "/api/get":
            return None
        return [
            {"duration": 300, "syncedLyrics": "far", "plainLyrics": "far"},
            {"duration": 201, "syncedLyrics": "[00:01.00] near", "plainLyrics": "near"},
        ]

    monkeypatch.setattr(lyrics_module, "_lrclib_get", fake_get)
    record = lyrics_module.fetch_lyrics("Artist", "Song", "Album", 200)
    assert record["synced"] == "[00:01.00] near"


def test_fetch_lyrics_no_match_within_tolerance(monkeypatch):
    monkeypatch.setattr(
        lyrics_module,
        "_lrclib_get",
        lambda path, params: None if path == "/api/get" else [{"duration": 300, "plainLyrics": "far"}],
    )
    record = lyrics_module.fetch_lyrics("Artist", "Song", "Album", 200)
    assert record == {"synced": None, "plain": None, "instrumental": False, "source": "lrclib"}
