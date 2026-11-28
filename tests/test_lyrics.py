import importlib.util
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from flask import Flask

import shared.lyrics as lyrics_module
from shared.database import instance_db
from shared.hardening import _reset_rate_limits_for_tests
from shared.models import Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("library_routes_under_test", _ROOT / "shared/api/routes/library.py")
library_routes = importlib.util.module_from_spec(_SPEC)
sys.modules["library_routes_under_test"] = library_routes
_SPEC.loader.exec_module(library_routes)
library_bp = library_routes.library_bp
# Every test stubs lrc.red out; the one that checks its requests needs the real call.
_REAL_LRC_RED_GET = lyrics_module._lrc_red_get


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


def _get_until_ready(client, url, *, ready=None):
    # A test can poll twice within the same 60-request window.
    for _ in range(25):
        response = client.get(url)
        assert response.status_code in (200, 202), f"{url}: HTTP {response.status_code}, {response.get_json()}"
        if response.status_code == 200 and (ready is None or ready(response.get_json())):
            return response
        time.sleep(0.1)
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
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


def _fake_api(track):
    return {
        "get_library": MagicMock(return_value=MagicMock()),
        "get_track_by_id": lambda lib, track_id: track if track and track_id == track.id else None,
    }


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    # No test reaches the network: secondary providers know nothing unless a test says so.
    monkeypatch.setattr(lyrics_module, "_lrc_red_get", lambda path, params, timeout_sec: None)
    monkeypatch.setattr(lyrics_module, "_netease_get", lambda path, params, timeout_sec: None)
    monkeypatch.setattr(lyrics_module, "_lyricsplus_get", lambda params, timeout_sec: None)
    reset_runtime()
    _reset_rate_limits_for_tests()
    lyrics_module._reset_lyrics_jobs_for_tests()
    _make_runtime(tmp_path)
    yield
    lyrics_module._reset_lyrics_jobs_for_tests()
    _reset_rate_limits_for_tests()
    reset_runtime()


def test_lyrics_fetch_and_cache(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value={
        "synced": "[00:01.00] hello",
        "plain": "hello",
        "instrumental": False,
        "source": lyrics_module.RESOLVER_SOURCE,
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body == {
        "status": "ready",
        "synced": "[00:01.00] hello",
        "rich_synced": None,
        "plain": "hello",
        "instrumental": False,
        "cached": False,
        "pending": False,
        "enriching": body["enriching"],
        "timing_safe": True,
        "synced_duration": None,
        "offset_ms": None,
        "provider": "lrclib",
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
        "source": lyrics_module.RESOLVER_SOURCE,
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body["status"] == "not_found"
    assert body["synced"] is None and body["cached"] is False

    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body["status"] == "not_found"
    assert body["cached"] is True
    assert fetch.call_count == 1


def test_lyrics_provider_error_not_cached(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value=None)
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body == {
        "status": "unavailable",
        "synced": None,
        "rich_synced": None,
        "plain": None,
        "instrumental": False,
        "cached": False,
        "pending": False,
        "enriching": False,
        "timing_safe": True,
        "synced_duration": None,
        "offset_ms": None,
        "provider": None,
    }

    _get_until_ready(client, "/api/library/tracks/track-1/lyrics")
    assert fetch.call_count == 2


def test_saved_streaming_lyrics_are_persisted_by_metadata(monkeypatch):
    fetch = MagicMock(return_value={
        "synced": "[00:01.00] cached line",
        "plain": "cached line",
        "instrumental": False,
        "source": lyrics_module.RESOLVER_SOURCE,
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)
    url = (
        "/api/lyrics?artist=Juice+WRLD&title=Lucid+Dreams"
        "&album=Goodbye+%26+Good+Riddance&duration=239&persist=1"
    )

    client = _make_app().test_client()
    first = _get_until_ready(client, url).get_json()
    assert first["status"] == "ready"
    assert first["cached"] is False

    second = _get_until_ready(client, url).get_json()
    assert second["status"] == "ready"
    assert second["cached"] is True
    assert second["synced"] == "[00:01.00] cached line"
    fetch.assert_called_once_with(
        "Juice WRLD",
        "Lucid Dreams",
        "Goodbye & Good Riddance",
        239,
    )


def test_streaming_provider_error_is_unavailable_and_never_cached(monkeypatch):
    fetch = MagicMock(return_value=None)
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)
    url = "/api/lyrics?artist=Artist&title=Song&persist=1"

    client = _make_app().test_client()
    first = _get_until_ready(client, url).get_json()
    second = _get_until_ready(client, url).get_json()

    assert first["status"] == "unavailable"
    assert second["status"] == "unavailable"
    assert first["cached"] is False
    assert fetch.call_count == 2


def test_unverified_preview_keeps_plain_lyrics_but_hides_album_timed_lrc(monkeypatch):
    fetch = MagicMock(return_value={
        "synced": "[00:01.00] line",
        "plain": "line",
        "instrumental": False,
        "source": lyrics_module.RESOLVER_SOURCE,
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(
        client,
        "/api/lyrics?artist=Artist&title=Song&duration=200&source_kind=third_party_lyrics",
    ).get_json()

    # Not knowing the upload is not evidence of a mismatch: no align prompt,
    # just the plain text.
    assert body["status"] == "ready"
    assert body["synced"] is None
    assert body["plain"] == "line"
    assert body["timing_safe"] is False


def test_official_audio_preview_keeps_synced_lyrics(monkeypatch):
    fetch = MagicMock(return_value={
        "synced": "[00:01.00] line",
        "plain": "line",
        "instrumental": False,
        "source": lyrics_module.RESOLVER_SOURCE,
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(
        client,
        "/api/lyrics?artist=Artist&title=Song&duration=200&source_kind=official_audio",
    ).get_json()

    assert body["synced"] == "[00:01.00] line"
    assert body["timing_safe"] is True


def test_lyrics_refresh_bypasses_cache(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    fetch = MagicMock(return_value={
        "synced": None,
        "plain": "hello",
        "instrumental": False,
        "source": lyrics_module.RESOLVER_SOURCE,
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
    db = instance_db()
    db.set_lyrics("t1", synced=None, plain=None, instrumental=False, source=lyrics_module.RESOLVER_SOURCE)
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
    db = instance_db()
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
    assert record == {"synced": None, "plain": None, "instrumental": False, "source": lyrics_module.RESOLVER_SOURCE}


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
    assert calls[0][1] == {
        "artist_name": "Extremoduro",
        "track_name": "So Payaso",
    }
    deezer.assert_not_called()


def test_fetch_lyrics_finds_lucid_dreams_through_structured_search(monkeypatch):
    calls = []

    def fake_get(path, params, timeout_sec):
        calls.append((path, params, timeout_sec))
        return [{
            "id": 34565905,
            "trackName": "Lucid Dreams",
            "artistName": "Juice WRLD",
            "albumName": "Goodbye & Good Riddance",
            # The provider's recording is longer than the playable video, but
            # still close enough to be the same version.
            "duration": 253,
            "syncedLyrics": "[00:01.00] synced",
            "plainLyrics": "plain",
        }]

    monkeypatch.setattr(lyrics_module, "_lrclib_get", fake_get)
    deezer = MagicMock()
    monkeypatch.setattr(lyrics_module, "_deezer_search", deezer)

    record = lyrics_module.fetch_lyrics(
        "Juice Wrld",
        "Lucid Dreams",
        "Goodbye & Good Riddance",
        239,
    )

    assert record["synced"] == "[00:01.00] synced"
    assert calls[0][1] == {
        "artist_name": "Juice Wrld",
        "track_name": "Lucid Dreams",
        "album_name": "Goodbye & Good Riddance",
    }
    deezer.assert_not_called()


def test_fetch_lyrics_deezer_fallback_is_only_used_after_empty_lrclib(monkeypatch):
    lrclib_calls = []

    def fake_get(path, params, timeout_sec):
        lrclib_calls.append(params)
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
    assert lrclib_calls == [
        {
            "artist_name": "Canonical Artist",
            "track_name": "Canonical Song",
        },
        {
            "artist_name": "The Canonical Artist",
            "track_name": "Canonical Song",
            "album_name": "Canonical Album",
        },
    ]


def test_fetch_lyrics_skips_fallback_when_budget_is_spent(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(lyrics_module.time, "monotonic", lambda: clock.pop(0) if len(clock) > 1 else clock[0])
    clock.append(108.5)
    monkeypatch.setattr(lyrics_module, "_lrclib_get", lambda path, params, timeout_sec: [])
    deezer = MagicMock()
    monkeypatch.setattr(lyrics_module, "_deezer_search", deezer)

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record["plain"] is None
    deezer.assert_not_called()


class _FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def _lrclib_response(status, body=None, retry_after=None):
    resp = MagicMock()
    resp.status_code = status
    resp.headers = {"Retry-After": retry_after} if retry_after is not None else {}
    resp.json.return_value = body
    if status >= 400:
        resp.raise_for_status.side_effect = lyrics_module.requests.HTTPError(f"{status} Server Error")
    return resp


def _patch_lrclib(monkeypatch, responses):
    clock = _FakeClock()
    monkeypatch.setattr(lyrics_module.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(lyrics_module.time, "sleep", clock.sleep)
    monkeypatch.setattr(lyrics_module.random, "uniform", lambda low, high: 0.0)
    calls = []

    def fake_get(url, params, headers, timeout):
        calls.append(timeout)
        clock.now += 0.3
        return responses.pop(0)

    monkeypatch.setattr(lyrics_module.requests, "get", fake_get)
    return clock, calls


def test_lrclib_overload_is_waited_out_as_asked(monkeypatch):
    rows = [{"trackName": "Song"}]
    clock, calls = _patch_lrclib(monkeypatch, [
        _lrclib_response(503, retry_after="1"),
        _lrclib_response(503, retry_after="1"),
        _lrclib_response(200, rows),
    ])

    assert lyrics_module._lrclib_get("/api/search", {}, 8.0) == rows
    assert clock.slept == [1.0, 1.0]
    assert len(calls) == 3


def test_lrclib_rate_limit_wait_is_capped(monkeypatch):
    clock, _ = _patch_lrclib(monkeypatch, [
        _lrclib_response(429, retry_after="120"),
        _lrclib_response(200, []),
    ])

    assert lyrics_module._lrclib_get("/api/search", {}, 8.0) == []
    assert clock.slept == [lyrics_module._LRCLIB_MAX_RETRY_WAIT_SEC]


def test_lrclib_overload_gives_up_within_the_budget(monkeypatch):
    clock, calls = _patch_lrclib(monkeypatch, [_lrclib_response(503, retry_after="1") for _ in range(20)])

    with pytest.raises(lyrics_module.requests.HTTPError):
        lyrics_module._lrclib_get("/api/search", {}, 3.0)
    # 0.3 s per answer and a second between them: the third answer leaves no
    # room for another wait and a request after it.
    assert len(calls) == 2
    assert clock.slept == [1.0]
    assert clock.now - 1000.0 <= 3.0


def test_lrclib_server_errors_other_than_overload_are_not_retried(monkeypatch):
    clock, calls = _patch_lrclib(monkeypatch, [_lrclib_response(500)])

    with pytest.raises(lyrics_module.requests.HTTPError):
        lyrics_module._lrclib_get("/api/search", {}, 8.0)
    assert len(calls) == 1
    assert clock.slept == []


def test_lyrics_survive_an_lrclib_overload(monkeypatch):
    clock, _ = _patch_lrclib(monkeypatch, [
        _lrclib_response(503, retry_after="1"),
        _lrclib_response(200, [{
            "trackName": "Song", "artistName": "Artist", "duration": 200, "plainLyrics": "la la",
        }]),
    ])

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record is not None and record["plain"] == "la la"
    assert clock.slept == [1.0]


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


def _music_video_track() -> Track:
    """A download of a music video: 16 s of intro before the album cut starts."""
    return Track(
        id="video-track",
        title="Song",
        artist="Artist",
        album="",
        duration=251,
        file_hash="hash-video",
        original_filename="video-track.m4a",
        file_size=1000,
        bitrate=128,
        format="m4a",
        youtube_id="AbCdEfGhIjK",
    )


def _album_timed_record():
    return {
        "synced": "[00:01.00] line",
        "plain": "line",
        "instrumental": False,
        "source": lyrics_module.RESOLVER_SOURCE,
        "synced_duration": 236,
    }


def test_synced_duration_is_where_most_copies_of_the_timing_agree():
    rows = [
        {"syncedLyrics": "[00:01.00] a\n[03:46.00] z", "duration": 235},
        {"syncedLyrics": "[00:01.00] a\n[03:46.00] z", "duration": 236},
        {"syncedLyrics": "[00:01.00] a\n[03:46.00] z", "duration": 236},
        # One uploader typed the length of the music video.
        {"syncedLyrics": "[00:01.00] a\n[03:46.00] z", "duration": 254},
        {"syncedLyrics": "[00:02.00] other timing", "duration": 300},
    ]
    record = lyrics_module._result_to_record(rows[3], rows)
    assert record["synced_duration"] == 236
    assert lyrics_module._result_to_record({"plainLyrics": "a", "duration": 200}, rows)["synced_duration"] is None


def test_synced_duration_is_unknown_when_the_copies_disagree():
    # The same timing, uploaded with lengths from a ringtone to a mix.
    lrc = "[00:01.00] a\n[03:46.00] z"
    rows = [{"syncedLyrics": lrc, "duration": d} for d in (60, 226, 73, 212, 245.4, 193, 251, 439.6, 384.4, 237.2, 240.4, 29.8, 222.9, 232.3, 179)]
    assert lyrics_module._result_to_record(rows[0], rows)["synced_duration"] is None


def test_a_length_shorter_than_the_last_line_cannot_vote():
    lrc = "[00:01.00] a\n[03:46.00] z"
    rows = [{"syncedLyrics": lrc, "duration": d} for d in (60, 73, 179, 235)]
    assert lyrics_module._result_to_record(rows[0], rows)["synced_duration"] == 235


def test_synced_timing_fits_only_a_recording_of_the_same_length():
    fits = lyrics_module.synced_timing_fits
    assert fits(236, 236) and fits(239, 236) and fits(233, 236)
    assert not fits(251, 236)
    # Unknown is not evidence of a mismatch.
    assert fits(None, 236) and fits(251, None)


def test_library_lyrics_timed_for_another_cut_are_flagged(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_music_video_track()))
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", MagicMock(return_value=_album_timed_record()))

    body = _get_until_ready(_make_app().test_client(), "/api/library/tracks/video-track/lyrics").get_json()
    assert body["synced"] == "[00:01.00] line"
    assert body["timing_safe"] is False
    assert body["synced_duration"] == 236
    assert body["offset_ms"] is None


def _as_owner(monkeypatch):
    import shared.hardening as hardening

    monkeypatch.setattr(hardening, "get_request_auth_context", lambda **_: {"kind": "owner"})


def test_setting_a_lyrics_offset_needs_library_write(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_music_video_track()))
    response = _make_app().test_client().put("/api/lyrics/offset", json={"youtube_id": "AbCdEfGhIjK", "offset_ms": 1})
    assert response.status_code == 403
    assert instance_db().get_lyrics_offset("yt:AbCdEfGhIjK") is None


def test_a_lyrics_offset_follows_the_video_from_stream_to_download(monkeypatch):
    _as_owner(monkeypatch)
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_music_video_track()))
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", MagicMock(return_value=_album_timed_record()))
    client = _make_app().test_client()

    # Lined up while streaming the video...
    response = client.put("/api/lyrics/offset", json={"youtube_id": "AbCdEfGhIjK", "offset_ms": 16000})
    assert response.status_code == 200 and response.get_json() == {"offset_ms": 16000}
    preview = _get_until_ready(
        client, "/api/lyrics?artist=Artist&title=Song&duration=251&youtube_id=AbCdEfGhIjK"
    ).get_json()
    assert preview["offset_ms"] == 16000

    # ...and still lined up once the same video is a file in the library.
    body = _get_until_ready(client, "/api/library/tracks/video-track/lyrics").get_json()
    assert body["offset_ms"] == 16000

    assert client.put("/api/lyrics/offset", json={"track_id": "video-track", "offset_ms": None}).status_code == 200
    body = _get_until_ready(client, "/api/library/tracks/video-track/lyrics").get_json()
    assert body["offset_ms"] is None


def test_lyrics_offset_rejects_what_it_cannot_place(monkeypatch):
    _as_owner(monkeypatch)
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_music_video_track()))
    client = _make_app().test_client()
    assert client.put("/api/lyrics/offset", json={"offset_ms": 1000}).status_code == 400
    assert client.put("/api/lyrics/offset", json={"youtube_id": "not a video", "offset_ms": 1000}).status_code == 400
    assert client.put("/api/lyrics/offset", json={"track_id": "missing", "offset_ms": 1000}).status_code == 404
    assert client.put("/api/lyrics/offset", json={"youtube_id": "AbCdEfGhIjK", "offset_ms": "16s"}).status_code == 400
    assert client.put("/api/lyrics/offset", json={"youtube_id": "AbCdEfGhIjK", "offset_ms": 11 * 60_000}).status_code == 400


def test_lyrics_cached_by_an_older_resolver_stay_visible_while_they_are_looked_up_again(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_music_video_track()))
    instance_db().set_lyrics(
        "video-track", synced="[00:01.00] line", plain="line", instrumental=False, source="lrclib:v4"
    )
    fetch = MagicMock(return_value=_album_timed_record())
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)
    client = _make_app().test_client()

    # The first read never waits on the provider: it shows what is held.
    first = client.get("/api/library/tracks/video-track/lyrics")
    assert first.status_code == 200
    assert first.get_json()["synced"] == "[00:01.00] line"
    assert first.get_json()["cached"] is True

    # A later read collects the refreshed record, which knows its length.
    body = _get_until_ready(
        client, "/api/library/tracks/video-track/lyrics", ready=lambda body: body["synced_duration"] is not None,
    ).get_json()
    assert body["timing_safe"] is False and body["synced_duration"] == 236
    body = client.get("/api/library/tracks/video-track/lyrics").get_json()
    assert body["cached"] is True and body["synced_duration"] == 236
    assert fetch.call_count == 1


@pytest.mark.parametrize("synced,source", [("[00:01.00] line", "lrclib:v4"), (None, "lrclib:v5")])
def test_a_read_that_crosses_the_upgrade_landing_does_not_look_up_again(monkeypatch, synced, source):
    # The read takes the old row; before it asks for a lookup, the running one
    # settles the row and is forgotten. Asking then must not start another.
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_music_video_track()))
    db = instance_db()
    db.set_lyrics("video-track", synced=synced, plain="line", instrumental=False, source=source)
    release = threading.Event()

    def slow_fetch(*_args):
        release.wait(5)
        return _album_timed_record()

    fetch = MagicMock(side_effect=slow_fetch)
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)
    client = _make_app().test_client()
    url = "/api/library/tracks/video-track/lyrics"
    assert client.get(url).get_json()["synced_duration"] is None

    read = db.get_lyrics
    crossed = threading.Event()

    def read_then_let_the_lookup_land(key):
        row = read(key)
        if not crossed.is_set():
            crossed.set()
            release.set()
            deadline = time.monotonic() + 5
            while lyrics_module._LOOKUPS._jobs and time.monotonic() < deadline:
                time.sleep(0.001)
            assert not lyrics_module._LOOKUPS._jobs
        return row

    monkeypatch.setattr(db, "get_lyrics", read_then_let_the_lookup_land)
    body = client.get(url).get_json()
    assert body["cached"] is True and body["synced_duration"] == 236
    deadline = time.monotonic() + 1
    while lyrics_module._LOOKUPS._jobs and time.monotonic() < deadline:
        time.sleep(0.001)
    assert fetch.call_count == 1


def test_a_lookup_no_longer_needed_does_not_start():
    coordinator = lyrics_module._LyricsLookupCoordinator()
    fn = MagicMock(return_value={"plain": "x"})
    assert coordinator.poll_or_start("key", fn, needed=lambda: False) == ("settled", None)
    fn.assert_not_called()
    assert coordinator.poll_or_start("key", fn, needed=lambda: True)[0] == "pending"
    # A lookup in flight is polled as before; `needed` only guards a new start.
    assert coordinator.poll_or_start("key", fn, needed=lambda: False)[0] in ("pending", "complete")


def test_saved_previews_cached_by_an_older_resolver_are_not_served(monkeypatch):
    # A saved preview's cache key names the resolver, so an upgrade looks again.
    current_key = lyrics_module.metadata_cache_key("Artist", "Song", None, 251)
    monkeypatch.setattr(lyrics_module, "RESOLVER_SOURCE", "lrclib:v4")
    legacy_key = lyrics_module.metadata_cache_key("Artist", "Song", None, 251)
    monkeypatch.undo()
    assert legacy_key != current_key
    instance_db().set_lyrics(legacy_key, synced="[00:01.00] old", plain="old", instrumental=False, source="lrclib:v4")
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", MagicMock(return_value=_album_timed_record()))

    body = _get_until_ready(
        _make_app().test_client(), "/api/lyrics?artist=Artist&title=Song&duration=251&persist=1"
    ).get_json()
    assert body["synced"] == "[00:01.00] line"
    assert body["synced_duration"] == 236 and body["timing_safe"] is False


@pytest.mark.parametrize("answer", [None, {"synced": None, "plain": None, "instrumental": False, "source": "x"}])
def test_an_upgrade_lookup_never_loses_lyrics_already_held(monkeypatch, answer):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_music_video_track()))
    instance_db().set_lyrics(
        "video-track", synced="[00:01.00] line", plain="line", instrumental=False, source="lrclib:v4"
    )
    fetch = MagicMock(return_value=answer)
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)
    client = _make_app().test_client()
    url = "/api/library/tracks/video-track/lyrics"

    # One read serves the held lines and starts the lookup, which settles the
    # row by itself and leaves nothing behind for anyone to collect.
    body = client.get(url).get_json()
    for _ in range(500):
        if fetch.call_count and not lyrics_module._LOOKUPS._jobs:
            break
        time.sleep(0.002)
    assert fetch.call_count == 1 and not lyrics_module._LOOKUPS._jobs
    assert body["status"] == "ready" and body["synced"] == "[00:01.00] line"
    held = instance_db().get_lyrics("video-track")
    assert held["synced"] == "[00:01.00] line"
    if answer is None:
        # An outage settles nothing: a later read asks again.
        assert held["source"] == "lrclib:v4"
    else:
        # A provider that no longer knows the song is not asked on every play.
        assert held["source"] == lyrics_module.RESOLVER_SOURCE
        calls = fetch.call_count
        client.get(url)
        assert fetch.call_count == calls


def test_deezer_fallback_searches_with_a_plain_query(monkeypatch):
    seen = {}

    class Reply:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": []}

    def fake_get(url, params, headers, timeout):
        seen.update(params)
        return Reply()

    monkeypatch.setattr(lyrics_module.requests, "get", fake_get)
    lyrics_module._deezer_search("Artist", "Song (In The World)", 1.0)
    assert seen["q"] == "Artist Song (In The World)"


# ── lrc.red TTML, NetEase YRC, and Phase 2 enrichment ──

_SAMPLE_TTML = (
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">'
    "<body><div>"
    '<p begin="00:01.000" end="00:02.100">'
    '<span begin="00:01.000" end="00:01.400">First</span> '
    '<span begin="00:01.400" end="00:01.700">sy</span><span begin="00:01.700" end="00:02.100">llable</span>'
    "</p>"
    '<p begin="00:04.500" end="00:06.000">'
    '<span begin="00:04.500" end="00:05.000">Se</span><span begin="00:05.000" end="00:05.400">cond</span> '
    '<span begin="00:05.400" end="00:06.000">line</span>'
    '<span ttm:role="x-bg"><span begin="00:05.600" end="00:06.200">echo</span></span>'
    '<span ttm:role="x-translation">ignored translation</span>'
    "</p>"
    "</div></body></tt>"
)

_LINE_ONLY_TTML = (
    '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
    '<p begin="00:01.000" end="00:02.100">First line</p>'
    '<p begin="00:04.500" end="00:06.000">Second line</p>'
    "</div></body></tt>"
)


class _LrcRedReply:
    def __init__(self, body):
        self.body = body
        self.text = body if isinstance(body, str) else ""

    def json(self):
        return self.body


def _lrc_red(monkeypatch, hits, ttml=_SAMPLE_TTML):
    """lrc.red answering a search with ``hits`` and every hit's TTML with ``ttml``."""
    calls = []

    def fake_get(path, params, timeout_sec):
        calls.append(path)
        if path == "/search.json":
            return _LrcRedReply({"hits": hits})
        return _LrcRedReply(ttml) if ttml is not None else None

    monkeypatch.setattr(lyrics_module, "_lrc_red_get", fake_get)
    return calls


def _hit(**overrides):
    return {"isrc": "USABC1234567", "title": "Song", "artist": "Artist", "album": "Album", "duration": 200.4, **overrides}


def _lrclib(monkeypatch, rows):
    monkeypatch.setattr(lyrics_module, "_lrclib_get", lambda path, params, timeout_sec: rows)
    monkeypatch.setattr(lyrics_module, "_deezer_search", lambda artist, title, timeout_sec: [])


def test_lrc_red_answers_a_song_lrclib_does_not_know(monkeypatch):
    _lrclib(monkeypatch, [])
    calls = _lrc_red(monkeypatch, [_hit()])

    record = lyrics_module.fetch_lyrics("Artist", "Song", "Album", 200)

    assert calls == ["/search.json", "/s/USABC1234567.ttml"]
    assert record["synced"] == "[00:01.00]First syllable\n[00:04.50]Second line"
    assert record["plain"] == "First syllable\nSecond line"
    assert record["instrumental"] is False
    assert record["source"] == lyrics_module.LRC_RED_SOURCE
    assert record["synced_duration"] == 200
    assert record["rich_source"] == lyrics_module.RICH_LRC_RED_SOURCE
    rich = record["rich_synced"]
    assert rich["granularity"] == "syllable"
    assert rich["dur"] == 200
    # First line preserves the syllable split ("sy" + "llable" without space).
    assert rich["lines"][0]["s"] == [
        {"t": 1000, "e": 1400, "x": "First "},
        {"t": 1400, "e": 1700, "x": "sy"},
        {"t": 1700, "e": 2100, "x": "llable"},
    ]
    # Background vocal separated cleanly; translation ignored.
    assert rich["lines"][2]["bg"] is True
    assert rich["lines"][2]["s"] == [{"t": 5600, "e": 6200, "x": "echo"}]
    assert lyrics_module.provider(record) == "lrc.red"


def test_lrc_red_times_lyrics_lrclib_only_has_as_text(monkeypatch):
    _lrclib(monkeypatch, [{"trackName": "Song", "artistName": "Artist", "duration": 200, "plainLyrics": "text"}])
    _lrc_red(monkeypatch, [_hit()], ttml=_LINE_ONLY_TTML)

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record["source"] == lyrics_module.LRC_RED_SOURCE
    assert record["synced"].startswith("[00:01.00]First line")
    assert record["rich_synced"] is None
    assert record["rich_source"] is None


def test_lrc_red_replaces_lines_lrclib_timed_for_another_cut(monkeypatch):
    lrc = "[00:01.00] a\n[03:46.00] z"
    _lrclib(monkeypatch, [{"trackName": "Song", "artistName": "Artist", "duration": 236, "syncedLyrics": lrc}])
    _lrc_red(monkeypatch, [_hit(duration=251.2)])

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 251)

    assert record["source"] == lyrics_module.LRC_RED_SOURCE
    assert record["synced_duration"] == 251


def test_lrc_red_is_not_asked_when_lrclib_timing_fits(monkeypatch):
    _lrclib(monkeypatch, [{"trackName": "Song", "artistName": "Artist", "duration": 200, "syncedLyrics": "[00:01.00] a"}])
    calls = _lrc_red(monkeypatch, [_hit()])

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record["source"] == lyrics_module.RESOLVER_SOURCE
    assert calls == []


def test_lrc_red_accepts_by_model_and_prefers_manual_hits(monkeypatch):
    _lrclib(monkeypatch, [])
    _lrc_red(monkeypatch, [_hit(isrc="USAI00000001", byModel=True)])
    ai_record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)
    assert ai_record["rich_source"] == lyrics_module.RICH_LRC_RED_AI_SOURCE

    # When both manual and AI hits match, manual wins.
    calls = _lrc_red(monkeypatch, [
        _hit(isrc="USAI00000001", byModel=True),
        _hit(isrc="USMAN0000002", byModel=False),
    ])
    manual_record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)
    assert calls == ["/search.json", "/s/USMAN0000002.ttml"]
    assert manual_record["rich_source"] == lyrics_module.RICH_LRC_RED_SOURCE


@pytest.mark.parametrize("hit", [
    _hit(title="Song (Acoustic)"),
    _hit(title="Another Song Entirely"),
    _hit(artist="Somebody Else"),
    _hit(duration=230),
    _hit(isrc="../../etc/passwd"),
])
def test_lrc_red_hits_that_are_not_this_recording_are_passed_over(monkeypatch, hit):
    plain = {"trackName": "Song", "artistName": "Artist", "duration": 200, "plainLyrics": "text"}
    _lrclib(monkeypatch, [plain])
    calls = _lrc_red(monkeypatch, [hit])

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record["plain"] == "text" and record["source"] == lyrics_module.RESOLVER_SOURCE
    assert calls == ["/search.json"]


def test_lrc_red_lines_that_outlast_the_recording_are_refused(monkeypatch):
    _lrclib(monkeypatch, [])
    long_ttml = (
        '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
        '<p begin="00:01.000" end="00:02.000">a</p>'
        '<p begin="04:30.000" end="04:35.000">z</p>'
        "</div></body></tt>"
    )
    _lrc_red(monkeypatch, [_hit(duration=None)], ttml=long_ttml)

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record == {"synced": None, "plain": None, "instrumental": False, "source": lyrics_module.RESOLVER_SOURCE}


def test_an_lrc_red_track_without_timed_lines_is_a_miss(monkeypatch):
    _lrclib(monkeypatch, [])
    _lrc_red(monkeypatch, [_hit()], ttml=None)

    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record["source"] == lyrics_module.RESOLVER_SOURCE and record["synced"] is None


def test_an_lrc_red_failure_keeps_what_lrclib_found(monkeypatch):
    _lrclib(monkeypatch, [{"trackName": "Song", "artistName": "Artist", "duration": 200, "plainLyrics": "text"}])

    def down(path, params, timeout_sec):
        raise lyrics_module.requests.ConnectionError("down")

    monkeypatch.setattr(lyrics_module, "_lrc_red_get", down)

    assert lyrics_module.fetch_lyrics("Artist", "Song", None, 200)["plain"] == "text"


def test_lrc_red_answers_through_an_lrclib_outage(monkeypatch):
    def outage(path, params, timeout_sec):
        raise lyrics_module.requests.HTTPError("503 Server Error")

    monkeypatch.setattr(lyrics_module, "_lrclib_get", outage)
    _lrc_red(monkeypatch, [_hit()])
    assert lyrics_module.fetch_lyrics("Artist", "Song", None, 200)["source"] == lyrics_module.LRC_RED_SOURCE

    # Neither answering is still an outage: nothing may be cached as not found.
    _lrc_red(monkeypatch, [])
    assert lyrics_module.fetch_lyrics("Artist", "Song", None, 200) is None


def test_lrc_red_requests_carry_its_own_client_identification(monkeypatch):
    seen = []

    def fake_get(url, params, headers, timeout):
        seen.append((url, headers["User-Agent"]))
        return MagicMock(status_code=404)

    monkeypatch.setattr(lyrics_module.requests, "get", fake_get)
    assert _REAL_LRC_RED_GET("/search.json", {"q": "Song Artist"}, 3.0) is None
    assert seen == [("https://lrc.red/search.json", lyrics_module._LRC_RED_USER_AGENT)]
    # lrc.red's terms: a link and an address to contact.
    assert "https://github.com/Arzuparreta/soundsible" in lyrics_module._LRC_RED_USER_AGENT
    assert "@" in lyrics_module._LRC_RED_CONTACT


def test_netease_yrc_fallback_strips_credits_and_builds_rich_timing(monkeypatch):
    _lrclib(monkeypatch, [])
    yrc = (
        '{"t":0,"c":[{"tx":"作词: Author"}]}\n'
        "[0,1000](0,1000,0)作词 : Author\n"
        "[1000,1500](1000,500,0)Hello (1500,1000,0)world\n"
        "[3000,1200](3000,600,0)Second (3600,600,0)line\n"
    )

    def fake_netease(path, params, timeout_sec):
        if path == "/api/search/get":
            return _LrcRedReply({
                "code": 200,
                "result": {"songs": [{"id": 42, "name": "Song", "artists": [{"name": "Artist"}], "duration": 200_000}]},
            })
        return _LrcRedReply({"code": 200, "yrc": {"lyric": yrc}, "lrc": {"lyric": ""}})

    monkeypatch.setattr(lyrics_module, "_netease_get", fake_netease)
    record = lyrics_module.fetch_lyrics("Artist", "Song", None, 200)

    assert record["source"] == lyrics_module.NETEASE_SOURCE
    assert record["synced"] == "[00:01.00]Hello world\n[00:03.00]Second line"
    assert record["rich_source"] == lyrics_module.RICH_NETEASE_SOURCE
    assert record["rich_synced"]["granularity"] == "word"
    assert len(record["rich_synced"]["lines"]) == 2


def test_lyricsplus_enrichment_requires_text_verification(monkeypatch):
    lp_payload = {
        "type": "Word",
        "metadata": {"source": "Apple", "totalDuration": "3:20.000"},
        "lyrics": [
            {
                "time": 1000, "duration": 1500, "text": "Hello world tonight",
                "syllabus": [
                    {"time": 1000, "duration": 500, "text": "Hello "},
                    {"time": 1500, "duration": 500, "text": "world "},
                    {"time": 2000, "duration": 500, "text": "to"},
                    {"time": 2250, "duration": 250, "text": "night"},
                ],
            },
            {
                "time": 3000, "duration": 1500, "text": "Second line forever",
                "syllabus": [
                    {"time": 3000, "duration": 500, "text": "Second "},
                    {"time": 3500, "duration": 500, "text": "line "},
                    {"time": 4000, "duration": 250, "text": "for"},
                    {"time": 4250, "duration": 250, "text": "ever"},
                ],
            },
        ],
    }
    monkeypatch.setattr(lyrics_module, "_lyricsplus_get", lambda params, timeout_sec: _LrcRedReply(lp_payload))

    # Matching reference text passes Jaccard >= 0.60 and produces syllable timing.
    ok = lyrics_module.enrich_lyrics(
        "Artist", "Song", "Album", 200, reference_text="Hello world tonight\nSecond line forever",
    )
    assert ok["rich_source"] == lyrics_module.RICH_LYRICSPLUS_SOURCE
    assert ok["rich_synced"]["granularity"] == "syllable"

    # Unrelated reference text (wrong song / remix mismatch) is rejected cleanly.
    mismatch = lyrics_module.enrich_lyrics(
        "Artist", "Song (Afro House Remix)", "Album", 200, reference_text="Completely different lyrics here",
    )
    assert mismatch == {"rich_synced": None, "rich_source": lyrics_module.RICH_NONE_SOURCE}


def test_phase2_enrichment_upgrades_lrclib_without_touching_line_source(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    db = instance_db()
    db.set_lyrics(
        "track-1",
        synced="[00:01.00]First syllable\n[00:04.50]Second line",
        plain="First syllable\nSecond line",
        instrumental=False,
        source=lyrics_module.RESOLVER_SOURCE,
        synced_duration=200,
    )
    _lrc_red(monkeypatch, [_hit()])

    client = _make_app().test_client()
    url = "/api/library/tracks/track-1/lyrics"
    response = client.get(url)
    assert response.status_code == 200
    first = response.get_json()
    # Served immediately without waiting on Phase 2.
    assert first["status"] == "ready"
    assert first["synced"] == "[00:01.00]First syllable\n[00:04.50]Second line"

    # Wait for background enrichment to settle and re-read.
    body = _get_until_ready(client, url, ready=lambda body: body["rich_synced"] is not None).get_json()

    assert body["rich_synced"]["granularity"] == "syllable"
    assert body["enriching"] is False
    # Player UI credits lrc.red because lrc.red supplied the rich timing...
    assert body["provider"] == "lrc.red"
    # ...while the underlying line LRC stays LRCLIB so OpenSubsonic keeps serving it.
    row = db.get_lyrics("track-1")
    assert row["source"] == lyrics_module.RESOLVER_SOURCE
    assert lyrics_module.provider(row) == "lrclib"
    assert row["rich_source"] == lyrics_module.RICH_LRC_RED_SOURCE


def test_enrichment_transient_outage_does_not_stamp_none(monkeypatch):
    def down(*_args, **_kwargs):
        raise lyrics_module.requests.ConnectionError("offline")

    monkeypatch.setattr(lyrics_module, "_lrc_red_get", down)
    monkeypatch.setattr(lyrics_module, "_netease_get", down)
    monkeypatch.setattr(lyrics_module, "_lyricsplus_get", down)

    assert lyrics_module.enrich_lyrics("Artist", "Song", None, 200, reference_text="hello") is None


def test_lyrics_are_looked_up_again_only_where_the_resolver_can_do_better():
    again = lyrics_module.worth_looking_up_again
    fitting = {"synced": "[00:01.00] a", "plain": "a", "source": "lrclib:v5", "synced_duration": 200}
    assert not again(fitting, 200)
    assert again({**fitting, "synced_duration": 236}, 251)
    assert again({"synced": None, "plain": "a", "source": "lrclib:v5"}, 200)
    assert again({"synced": None, "plain": None, "instrumental": True, "source": "lrclib:v5"}, 200)
    # Lines older than their length are looked up whatever they claim.
    assert again({**fitting, "source": "lrclib:v4", "synced_duration": None}, 200)
    for source in (lyrics_module.RESOLVER_SOURCE, lyrics_module.LRC_RED_SOURCE, lyrics_module.NETEASE_SOURCE):
        assert not again({"synced": None, "plain": "a", "source": source}, 200)


def test_an_upgrade_that_finds_nothing_keeps_a_known_length():
    db = instance_db()
    held = {"synced": "[00:01.00] a", "plain": "a", "instrumental": False, "source": "lrclib:v5", "synced_duration": 236}
    kept = lyrics_module.settle_upgrade(db, "t1", held, {"synced": None, "plain": None, "instrumental": False})
    assert kept["synced_duration"] == 236 and kept["source"] == lyrics_module.RESOLVER_SOURCE
    assert db.get_lyrics("t1")["synced_duration"] == 236


def test_library_lyrics_name_lrc_red_for_its_credit(monkeypatch):
    monkeypatch.setattr(library_routes, "_get_api", lambda: _fake_api(_track()))
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", MagicMock(return_value={
        "synced": "[00:01.00] a", "plain": "a", "instrumental": False,
        "source": lyrics_module.LRC_RED_SOURCE, "synced_duration": 200,
    }))
    client = _make_app().test_client()

    assert _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()["provider"] == "lrc.red"
    # And once cached.
    assert client.get("/api/library/tracks/track-1/lyrics").get_json()["provider"] == "lrc.red"
