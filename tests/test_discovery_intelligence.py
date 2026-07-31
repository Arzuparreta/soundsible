import json
from pathlib import Path

import pytest

from shared.database import user_db
from shared.discovery_intelligence import (
    ListeningRollup,
    build_music_recommendations,
    build_podcast_recommendations,
    compose_discovery_feed,
    emit_discovery_event,
    load_discovery_settings,
    load_listening_event_rollups,
    load_recently_saved_tracks,
    recommendation_multiplier,
    record_not_interested,
    rank_recommendation_rows,
    reset_discovery_profile,
    save_discovery_settings,
    undo_discovery_feedback,
)
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import init_telemetry, reset_telemetry, user_telemetry_dir
from shared.user_context import user_config_dir, user_context, user_data_dir


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
    assert load_discovery_settings()["autoplay_enabled"] is True
    saved = save_discovery_settings({"learning_enabled": False, "autoplay_enabled": False})

    assert saved["learning_enabled"] is False
    assert saved["autoplay_enabled"] is False
    persisted = json.loads((user_config_dir() / "discovery_settings.json").read_text())
    assert persisted["learning_enabled"] is False
    assert persisted["autoplay_enabled"] is False


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
            "query": "private search text",
        },
    )
    save_discovery_settings({"learning_enabled": False})
    assert emit_discovery_event("music_saved_to_library", {"title": "Muted"}) is False
    reset_telemetry()

    events = [
        json.loads(line)
        for line in (user_telemetry_dir() / "listening-events.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(events) == 1
    assert events[0]["event"] == "music_saved_to_library"
    assert events[0]["title"] == "Saved Track"
    assert "unsafe" not in events[0]
    assert "query" not in events[0]


def test_generated_listening_does_not_reinforce_its_own_exact_choice(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    payload = {
        "media_type": "music_track",
        "youtube_id": "abcdefghijk",
        "track_id": "local-track",
        "title": "Generated Song",
        "artist": "Generated Artist",
        "source": "auto_mode",
    }

    assert emit_discovery_event("music_played_30s", payload)
    assert recommendation_multiplier("music:youtube:abcdefghijk") == 1
    assert "generated artist" not in load_listening_event_rollups().artist_plays

    assert emit_discovery_event("music_generated_completed", payload)
    rollup = load_listening_event_rollups()
    assert rollup.artist_affinity["generated artist"] == pytest.approx(0.15, rel=0.01)
    assert recommendation_multiplier("music:youtube:abcdefghijk") == 1

    assert emit_discovery_event("music_generated_skipped_early", payload)
    assert recommendation_multiplier("music:youtube:abcdefghijk") < 1

    requested = {**payload, "youtube_id": "request0001"}
    assert emit_discovery_event("music_requested_from_dj", requested)
    assert recommendation_multiplier("music:youtube:request0001") > 1


def test_profile_policy_rebuild_removes_historical_generated_play_bias(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    payload = {
        "v": 2,
        "event": "music_played_30s",
        "media_type": "music_track",
        "youtube_id": "abcdefghijk",
        "title": "Old Auto Pick",
        "artist": "Looped Artist",
        "source": "auto_mode",
    }
    user_db().record_discovery_signal(
        event_id="old-auto-event",
        event="music_played_30s",
        identity="music:youtube:abcdefghijk",
        media_type="music_track",
        positive_delta=1.0,
        negative_delta=0,
        payload=payload,
        created_at=1,
    )

    assert recommendation_multiplier("music:youtube:abcdefghijk") == 1
    assert recommendation_multiplier("music:youtube:abcdefghijk") == 1
    events = user_db().get_discovery_events()
    assert events[0]["positive_delta"] == 0


def test_not_interested_is_monotonic_soft_and_undoable(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    item = {
        "media_type": "music_track",
        "youtube_id": "abcdefghijk",
        "title": "Exact Song",
        "artist": "Exact Artist",
    }
    identity = "music:youtube:abcdefghijk"
    factors = [recommendation_multiplier(identity)]
    event_ids = []
    for _ in range(4):
        event_ids.append(record_not_interested(item))
        factors.append(recommendation_multiplier(identity))

    assert all(left > right for left, right in zip(factors, factors[1:]))
    assert factors[-1] > 0
    ranked = rank_recommendation_rows(
        [
            {"id": "abcdefghijk", "title": "Exact Song", "artist": "Exact Artist", "score": 1.0},
            {"id": "other123456", "title": "Other", "artist": "Other", "score": 0.7},
        ],
        source="radio",
    )
    assert len(ranked) == 2
    assert {row["id"] for row in ranked} == {"abcdefghijk", "other123456"}

    before_undo = recommendation_multiplier(identity)
    assert undo_discovery_feedback(event_ids[-1]) is True
    assert recommendation_multiplier(identity) > before_undo


def test_reset_clears_profile_and_listening_log(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    identity = "music:youtube:abcdefghijk"
    record_not_interested({
        "media_type": "music_track",
        "youtube_id": "abcdefghijk",
        "title": "Exact Song",
        "artist": "Exact Artist",
    })
    assert recommendation_multiplier(identity) < 1
    assert (user_telemetry_dir() / "listening-events.jsonl").exists()

    reset_discovery_profile()

    assert recommendation_multiplier(identity) == 1
    assert not (user_telemetry_dir() / "listening-events.jsonl").exists()


def test_recommendation_profile_is_isolated_per_account(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    identity = "music:youtube:abcdefghijk"
    item = {
        "media_type": "music_track",
        "youtube_id": "abcdefghijk",
        "title": "Exact Song",
        "artist": "Exact Artist",
    }

    with user_context("listener-a"):
        record_not_interested(item)
        assert recommendation_multiplier(identity) < 1
    with user_context("listener-b"):
        assert recommendation_multiplier(identity) == 1
    with user_context("listener-a"):
        assert recommendation_multiplier(identity) < 1


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


def _write_jsonl_events(_data_dir: Path, events: list[dict]) -> None:
    """Seed listening history for the bound account."""
    tel_dir = user_telemetry_dir()
    tel_dir.mkdir(parents=True, exist_ok=True)
    path = tel_dir / "listening-events.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def test_rollup_aggregates_plays_correctly(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    events = [
        {"event": "music_played_30s", "artist": "Queen", "album": "Innuendo", "track_id": "t1"},
        {"event": "music_played_30s", "artist": "Queen", "album": "Innuendo", "track_id": "t2"},
        {"event": "music_search_played", "artist": "Queen", "track_id": "t1"},
        {"event": "music_saved_to_library", "artist": "Bowie"},
        {"event": "podcast_episode_played_30s", "itunes_collection_id": "123"},
        {"event": "podcast_episode_played_30s", "itunes_collection_id": "123"},
    ]
    _write_jsonl_events(runtime.data_dir, events)

    rollup = load_listening_event_rollups()

    assert rollup.has_data
    assert rollup.artist_plays["queen"] == 3
    assert rollup.played_track_ids == {"t1", "t2"}
    assert rollup.artist_saves["bowie"] == 1
    assert rollup.podcast_plays["123"] == 2
    assert rollup.saved_artists == ["bowie"]


def test_rollup_returns_empty_when_learning_disabled(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    save_discovery_settings({"learning_enabled": False})

    events = [{"event": "music_played_30s", "artist": "Queen", "track_id": "t1"}]
    _write_jsonl_events(runtime.data_dir, events)

    rollup = load_listening_event_rollups()
    assert not rollup.has_data


def test_rollup_returns_empty_when_no_file(tmp_path):
    _make_runtime(tmp_path)
    rollup = load_listening_event_rollups()
    assert not rollup.has_data


def test_rollup_boosts_played_artist_scores(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    events = [
        {"event": "music_played_30s", "artist": "Artist One", "track_id": "a"},
        {"event": "music_played_30s", "artist": "Artist One", "track_id": "a"},
    ]
    _write_jsonl_events(runtime.data_dir, events)

    a = _track("a", "Track A", "Artist One")
    b = _track("b", "Track B", "Artist Two")
    metadata = LibraryMetadata(version=1, tracks=[a, b], playlists={}, settings={})

    result = build_music_recommendations(metadata, favourite_ids=[], limit=10)
    scores = {item["track_id"]: item["score"] for item in result["items"]}

    assert scores["a"] > scores["b"], "Played artist should score higher"


def test_saved_artists_boost_scores_without_because_saved_section(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    events = [{"event": "music_saved_to_library", "artist": "Artist One"}]
    _write_jsonl_events(runtime.data_dir, events)

    a = _track("a", "Track A", "Artist One")
    b = _track("b", "Track B", "Artist Two")
    metadata = LibraryMetadata(version=1, tracks=[a, b], playlists={}, settings={})

    result = build_music_recommendations(metadata, favourite_ids=[], limit=10)
    section_ids = [s["id"] for s in result["sections"]]
    scores = {item["track_id"]: item["score"] for item in result["items"]}

    assert "because_you_saved" not in section_ids
    assert scores["a"] > scores["b"], "Saved artist should still score higher"


def test_rollup_adds_rediscover_section(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    # Only t1/t2/t3 played — t4 should appear in rediscover
    events = [
        {"event": "music_played_30s", "artist": "A", "track_id": "t1"},
        {"event": "music_played_30s", "artist": "A", "track_id": "t2"},
        {"event": "music_played_30s", "artist": "A", "track_id": "t3"},
    ]
    _write_jsonl_events(runtime.data_dir, events)

    tracks = [_track(f"t{i}", f"Track {i}", "A") for i in range(1, 5)]
    metadata = LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})

    result = build_music_recommendations(metadata, favourite_ids=[], limit=20)
    rediscover = next((s for s in result["sections"] if s["id"] == "rediscover"), None)
    assert rediscover is not None
    assert "music:t4" in rediscover["item_ids"]


def test_podcast_rollup_boosts_recently_played_show(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    events = [
        {"event": "podcast_episode_played_30s", "itunes_collection_id": "999"},
        {"event": "podcast_episode_played_30s", "itunes_collection_id": "999"},
    ]
    _write_jsonl_events(runtime.data_dir, events)

    metadata = LibraryMetadata(
        version=1, tracks=[], playlists={}, settings={},
        podcast_subscriptions=[
            {"id": "s1", "title": "Popular Show", "rss_url": "http://a.com/feed", "itunes_collection_id": "999"},
            {"id": "s2", "title": "Other Show", "rss_url": "http://b.com/feed", "itunes_collection_id": "888"},
        ],
    )
    result = build_podcast_recommendations(metadata)
    assert result["items"][0]["external_ids"]["itunes_collection_id"] == "999"
    assert result["items"][0]["reason_code"] == "podcast_recently_played"


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


def test_recently_saved_returns_most_recent_first(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    events = [
        {"event": "music_saved_to_library", "track_id": "t1", "title": "Old Track", "artist": "A"},
        {"event": "music_saved_to_library", "track_id": "t2", "title": "New Track", "artist": "B"},
        {"event": "music_saved_to_library", "track_id": "t3", "title": "Newest Track", "artist": "C"},
    ]
    _write_jsonl_events(runtime.data_dir, events)

    result = load_recently_saved_tracks(limit=10)
    assert [r["track_id"] for r in result] == ["t3", "t2", "t1"]


def test_recently_saved_deduplicates_track_ids(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    events = [
        {"event": "music_saved_to_library", "track_id": "t1", "title": "A", "artist": "X"},
        {"event": "music_saved_to_library", "track_id": "t1", "title": "A again", "artist": "X"},
        {"event": "music_saved_to_library", "track_id": "t2", "title": "B", "artist": "Y"},
    ]
    _write_jsonl_events(runtime.data_dir, events)

    result = load_recently_saved_tracks(limit=10)
    ids = [r["track_id"] for r in result]
    assert ids.count("t1") == 1
    assert len(ids) == 2


def test_recently_saved_respects_opt_out(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    save_discovery_settings({"learning_enabled": False})

    events = [{"event": "music_saved_to_library", "track_id": "t1", "title": "X", "artist": "Y"}]
    _write_jsonl_events(runtime.data_dir, events)

    result = load_recently_saved_tracks(limit=10)
    assert result == []


def test_from_your_playlists_section_appears(tmp_path):
    _make_runtime(tmp_path)
    a = _track("a", "Track A", "Artist One")
    b = _track("b", "Track B", "Artist Two")
    metadata = LibraryMetadata(
        version=1, tracks=[a, b], playlists={"Road Trip": ["a", "b"]}, settings={}
    )

    result = build_music_recommendations(metadata, favourite_ids=[], limit=20)
    pl_sections = [s for s in result["sections"] if s.get("section_type") == "from_your_playlists"]
    assert len(pl_sections) >= 1
    assert pl_sections[0]["playlist_name"] == "Road Trip"
    assert "music:a" in pl_sections[0]["item_ids"] or "music:b" in pl_sections[0]["item_ids"]


def test_temporal_profile_values_recent_events_more_than_old_events(tmp_path, monkeypatch):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    now = 2_000_000_000
    monkeypatch.setattr("shared.discovery_intelligence.time.time", lambda: now)
    _write_jsonl_events(runtime.data_dir, [
        {
            "event": "music_played_30s",
            "track_id": "old",
            "artist": "Old Artist",
            "ts": now - 180 * 86400,
        },
        {
            "event": "music_played_30s",
            "track_id": "new",
            "artist": "New Artist",
            "ts": now,
        },
    ])

    profile = load_listening_event_rollups()

    assert profile.maturity == "cold"
    assert profile.event_count == 2
    assert profile.artist_affinity["new artist"] > profile.artist_affinity["old artist"] * 10
    assert profile.recent_track_ids == ["new", "old"]


def test_compose_discovery_feed_ranks_sections_diversifies_artists_and_removes_duplicates(tmp_path):
    _make_runtime(tmp_path)
    items = [
        {
            "id": f"item:{index}",
            "title": f"Track {index}",
            "artist": "Repeated Artist" if index < 4 else f"Artist {index}",
            "source": "external" if index >= 4 else "library",
            "score": 1.2 - index * 0.04,
            "confidence": 0.9,
            "action_state": {"in_library": index < 4},
        }
        for index in range(8)
    ]
    response = compose_discovery_feed({
        "items": items,
        "sections": [
            {"id": "broad", "title": "Broad", "item_ids": [item["id"] for item in items]},
            {"id": "duplicate", "title": "Duplicate", "item_ids": ["item:0", "item:1"]},
        ],
        "settings": {"learning_enabled": True},
    }, max_sections=4, section_size=8)

    assert response["v"] == 1
    assert response["sections"][0]["id"] == "broad"
    assert response["sections"][0]["item_ids"][:2] == ["item:0", "item:1"]
    assert "item:2" not in response["sections"][0]["item_ids"]
    assert all(section["id"] != "duplicate" for section in response["sections"])
    assert len(response["items"]) == len({item["id"] for item in response["items"]})
    assert response["profile"]["learning_enabled"] is True
