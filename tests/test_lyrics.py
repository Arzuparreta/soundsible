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
        "source": lyrics_module.RESOLVER_SOURCE,
    })
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", fetch)

    client = _make_app().test_client()
    body = _get_until_ready(client, "/api/library/tracks/track-1/lyrics").get_json()
    assert body == {
        "status": "ready",
        "synced": "[00:01.00] hello",
        "plain": "hello",
        "instrumental": False,
        "cached": False,
        "pending": False,
        "timing_safe": True,
        "synced_duration": None,
        "offset_ms": None,
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
        "plain": None,
        "instrumental": False,
        "cached": False,
        "pending": False,
        "timing_safe": True,
        "synced_duration": None,
        "offset_ms": None,
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


def test_unverified_preview_flags_album_timed_lrc_as_untrusted(monkeypatch):
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

    # The lines still travel, so the listener can line them up by hand.
    assert body["status"] == "ready"
    assert body["synced"] == "[00:01.00] line"
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
    for _ in range(100):
        body = client.get("/api/library/tracks/video-track/lyrics").get_json()
        if body["synced_duration"] is not None:
            break
        time.sleep(0.001)
    assert body["timing_safe"] is False and body["synced_duration"] == 236
    body = client.get("/api/library/tracks/video-track/lyrics").get_json()
    assert body["cached"] is True and body["synced_duration"] == 236
    assert fetch.call_count == 1


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
    monkeypatch.setattr(lyrics_module, "fetch_lyrics", MagicMock(return_value=answer))

    body = _get_until_ready(_make_app().test_client(), "/api/library/tracks/video-track/lyrics").get_json()
    assert body["status"] == "ready"
    assert body["synced"] == "[00:01.00] line"
    assert instance_db().get_lyrics("video-track")["synced"] == "[00:01.00] line"


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
