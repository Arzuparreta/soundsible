import importlib.util
import sys
import threading
import time
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


def _get_until_ready(client, url, attempts=100):
    for _ in range(attempts):
        response = client.get(url)
        if response.status_code != 202:
            return response
        time.sleep(0.001)
    raise AssertionError(f"lyrics lookup did not complete: {url}")


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
    lyrics_module._reset_lyrics_jobs_for_tests()
    _make_runtime(tmp_path)
    yield
    lyrics_module._reset_lyrics_jobs_for_tests()
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
    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body == {
        "synced": "[00:01.00] hello",
        "plain": "hello",
        "instrumental": False,
        "cached": False,
        "pending": False,
    }
    fetch.assert_called_once_with("Artist", "Song", "Album", 200)

    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body["cached"] is True
    assert body["synced"] == "[00:01.00] hello"
    assert fetch.call_count == 1


def test_lyrics_not_found_negative_cache(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value={
        "synced": None,
        "plain": None,
        "instrumental": False,
        "source": "lrclib:v2",
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body["synced"] is None and body["cached"] is False

    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body["cached"] is True
    assert fetch.call_count == 1


def test_lyrics_provider_error_not_cached(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value=None)
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body == {
        "synced": None,
        "plain": None,
        "instrumental": False,
        "cached": False,
        "pending": False,
    }

    _get_until_ready(client, "/api/library/tracks/track-1/lyrics")
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
    _get_until_ready(client, "/api/library/tracks/track-1/lyrics")
    _get_until_ready(client, "/api/library/tracks/track-1/lyrics?refresh=1")
    assert fetch.call_count == 2


def test_lyrics_track_not_found(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(None))
    resp = _make_app().test_client().get("/api/library/tracks/missing/lyrics")
    assert resp.status_code == 404


def test_db_negative_cache_expires(tmp_path):
    db = DatabaseManager()
    db.set_lyrics("t1", synced=None, plain=None, instrumental=False, source="lrclib:v2")
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


def test_db_old_negative_cache_is_invalidated_immediately(tmp_path):
    db = DatabaseManager()
    db.set_lyrics("old", synced=None, plain=None, instrumental=False, source="lrclib")
    assert db.get_lyrics("old") is None


def test_fetch_lyrics_search_fallback_picks_closest_duration(monkeypatch):
    def fake_get(path, params, timeout_sec):
        return [
            {
                "trackName": "Song",
                "artistName": "Artist",
                "albumName": "Album",
                "duration": 300,
                "syncedLyrics": "far",
                "plainLyrics": "far",
            },
            {
                "trackName": "Song",
                "artistName": "Artist",
                "albumName": "Album",
                "duration": 201,
                "syncedLyrics": "[00:01.00] near",
                "plainLyrics": "near",
            },
        ]

    monkeypatch.setattr(lyrics_module, "_lrclib_get", fake_get)
    record = lyrics_module.fetch_lyrics("Artist", "Song", "Album", 200)
    assert record["synced"] == "[00:01.00] near"


def test_fetch_lyrics_no_match_within_tolerance(monkeypatch):
    monkeypatch.setattr(
        lyrics_module,
        "_lrclib_get",
        lambda path, params, timeout_sec: [{
            "trackName": "Different Song",
            "artistName": "Different Artist",
            "duration": 300,
            "plainLyrics": "far",
        }],
    )
    monkeypatch.setattr(lyrics_module, "_deezer_search", lambda artist, title, timeout_sec: [])
    record = lyrics_module.fetch_lyrics("Artist", "Song", "Album", 200)
    assert record == {"synced": None, "plain": None, "instrumental": False, "source": "lrclib:v2"}


def test_fetch_lyrics_normalizes_youtube_video_metadata_in_one_request(monkeypatch):
    calls = []

    def fake_get(path, params, timeout_sec):
        calls.append((path, params, timeout_sec))
        return [{
            "trackName": "So Payaso",
            "artistName": "Extremoduro",
            "albumName": "Agila",
            "duration": 282,
            "syncedLyrics": "[00:01.00] letra",
            "plainLyrics": "letra",
        }]

    monkeypatch.setattr(lyrics_module, "_lrclib_get", fake_get)
    deezer = MagicMock()
    monkeypatch.setattr(lyrics_module, "_deezer_search", deezer)

    record = lyrics_module.fetch_lyrics(
        "Extremoduro (Oficial)",
        "Extremoduro - So Payaso (Video)",
        None,
        282,
    )

    assert record["synced"] == "[00:01.00] letra"
    assert len(calls) == 1
    assert calls[0][1] == {"q": "Extremoduro So Payaso"}
    deezer.assert_not_called()


def test_fetch_lyrics_deezer_fallback_is_only_used_after_empty_lrclib(monkeypatch):
    lrclib_calls = []

    def fake_get(path, params, timeout_sec):
        lrclib_calls.append(params["q"])
        if len(lrclib_calls) == 1:
            return []
        return [{
            "trackName": "Canonical Song",
            "artistName": "Canonical Artist",
            "albumName": "Canonical Album",
            "duration": 200,
            "plainLyrics": "found",
        }]

    monkeypatch.setattr(lyrics_module, "_lrclib_get", fake_get)
    monkeypatch.setattr(lyrics_module, "_deezer_search", lambda artist, title, timeout_sec: [{
        "title": "Canonical Song",
        "title_short": "Canonical Song",
        "artist": {"name": "The Canonical Artist"},
        "album": {"title": "Canonical Album"},
        "duration": 200,
    }])

    record = lyrics_module.fetch_lyrics("Canonical Artist", "Canonical Song", None, 200)

    assert record["plain"] == "found"
    assert lrclib_calls == ["Canonical Artist Canonical Song", "The Canonical Artist Canonical Song"]


def test_fetch_lyrics_skips_fallback_when_budget_is_spent(monkeypatch):
    clock = iter([100.0, 108.5, 108.5])
    monkeypatch.setattr(lyrics_module.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(lyrics_module, "_lrclib_get", lambda path, params, timeout_sec: [])
    deezer = MagicMock()
    monkeypatch.setattr(lyrics_module, "_deezer_search", deezer)

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record["plain"] is None
    deezer.assert_not_called()


def test_lookup_coordinator_has_two_workers_and_zero_backlog():
    coordinator = lyrics_module._LyricsLookupCoordinator()
    release = threading.Event()

    assert coordinator.poll_or_start("one", lambda: release.wait(1))[0] == "pending"
    assert coordinator.poll_or_start("two", lambda: release.wait(1))[0] == "pending"
    assert coordinator.poll_or_start("three", lambda: {"plain": "must not queue"})[0] == "busy"

    release.set()
    for key in ("one", "two"):
        for _ in range(100):
            status, _ = coordinator.poll_or_start(key, lambda: None)
            if status == "complete":
                break
            time.sleep(0.001)
        assert status == "complete"
