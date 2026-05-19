import json
from pathlib import Path

import pytest

from shared.discovery_intelligence import (
    build_music_recommendations,
    build_podcast_recommendations,
    emit_discovery_event,
    load_discovery_settings,
    save_discovery_settings,
)
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import init_telemetry, reset_telemetry


def _make_runtime(tmp_path: Path) -> RuntimeConfig:
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


def _track(track_id: str, title: str, artist: str = "Artist Unit") -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        album="Album Unit",
        duration=120,
        file_hash=f"hash-{track_id}",
        original_filename=f"{track_id}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
        album_artist=artist,
        youtube_id=f"yt-{track_id}",
    )


@pytest.fixture(autouse=True)
def _reset_runtime_and_telemetry():
    reset_runtime()
    reset_telemetry()
    yield
    reset_telemetry()
    reset_runtime()


def test_discovery_settings_default_and_persist(tmp_path):
    runtime = _make_runtime(tmp_path)

    assert load_discovery_settings()["learning_enabled"] is True
    saved = save_discovery_settings({"learning_enabled": False})

    assert saved["learning_enabled"] is False
    assert json.loads((runtime.config_dir / "discovery_settings.json").read_text())["learning_enabled"] is False


def test_emit_discovery_event_respects_local_opt_out(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    assert emit_discovery_event(
        "music_saved_to_library",
        {
            "media_type": "music_track",
            "title": "Saved Track",
            "artist": "Artist",
            "unsafe": "not persisted",
        },
    )
    save_discovery_settings({"learning_enabled": False})
    assert emit_discovery_event("music_saved_to_library", {"title": "Muted"}) is False
    reset_telemetry()

    events = [
        json.loads(line)
        for line in (runtime.data_dir / "telemetry" / "listening-events.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(events) == 1
    assert events[0]["event"] == "music_saved_to_library"
    assert events[0]["title"] == "Saved Track"
    assert "unsafe" not in events[0]


def test_music_recommendations_prioritize_favourites_and_playlists(tmp_path):
    _make_runtime(tmp_path)
    a = _track("a", "Favourite", "Artist One")
    b = _track("b", "Playlist Cut", "Artist Two")
    c = _track("c", "Deep Cut", "Artist Two")
    metadata = LibraryMetadata(
        version=1,
        tracks=[a, b, c],
        playlists={"Road": ["b", "c"]},
        settings={},
    )

    result = build_music_recommendations(metadata, favourite_ids=["a"], limit=3)

    assert [item["track_id"] for item in result["items"]][:2] == ["a", "b"]
    assert result["items"][0]["reason_code"] == "library_favourite"
    assert result["items"][1]["reason"] == 'From your playlist "Road".'
    assert result["sections"][0]["id"] == "made_for_your_library"


def test_podcast_recommendations_use_subscriptions(tmp_path):
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[],
        playlists={},
        settings={},
        podcast_subscriptions=[
            {
                "id": "sub-1",
                "title": "Show Unit",
                "author": "Host Unit",
                "rss_url": "https://example.com/feed.xml",
                "itunes_collection_id": "123",
            }
        ],
    )

    result = build_podcast_recommendations(metadata)

    assert result["items"][0]["media_type"] == "podcast_show"
    assert result["items"][0]["reason_code"] == "podcast_subscription"
    assert result["items"][0]["action_state"]["subscribed"] is True
