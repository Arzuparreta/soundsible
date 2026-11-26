import json
from pathlib import Path

import pytest

from shared.database import user_db
from shared.discovery_intelligence import (
    ListeningRollup,
    artist_aliases,
    artist_identity,
    artist_recommendation_multiplier,
    build_music_recommendations,
    build_podcast_recommendations,
    compose_discovery_feed,
    emit_discovery_event,
    identity_aliases,
    load_discovery_settings,
    load_listening_event_rollups,
    load_recently_saved_tracks,
    recommendation_multiplier,
    record_less_from_artist,
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
    assert result["sections"] == []


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
    # music_search_played is click intent, never a second play count.
    assert rollup.artist_plays["queen"] == 2
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


def test_music_recommendations_omits_local_library_shelves(tmp_path):
    """Local recommendations rank library items for the Radio/Autoplay/DJ local
    pool without emitting Made for Your Library, Rediscover, or From Playlist shelves."""
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    events = [
        {"event": "music_played_30s", "artist": "A", "track_id": "t1"},
        {"event": "music_played_30s", "artist": "A", "track_id": "t2"},
        {"event": "music_played_30s", "artist": "A", "track_id": "t3"},
    ]
    _write_jsonl_events(runtime.data_dir, events)

    tracks = [_track(f"t{i}", f"Track {i}", "A") for i in range(1, 5)]
    metadata = LibraryMetadata(version=1, tracks=tracks, playlists={"Road Trip": ["t1", "t2"]}, settings={})

    result = build_music_recommendations(metadata, favourite_ids=["t1"], limit=20)
    assert result["sections"] == []
    assert [item["track_id"] for item in result["items"]] == ["t1", "t2", "t3", "t4"]
    empty = build_music_recommendations(LibraryMetadata(version=1, tracks=[], playlists={}, settings={}), favourite_ids=[], limit=10)
    assert empty["items"] == []
    assert empty["sections"] == []


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


def test_podcast_country_persists_without_changing_music_settings(tmp_path):
    _make_runtime(tmp_path)
    original = load_discovery_settings()
    assert original['podcast_country'] == 'us'
    saved = save_discovery_settings({'podcast_country': ' ES '})
    assert saved['podcast_country'] == 'es'
    assert load_discovery_settings()['podcast_country'] == 'es'
    assert {k: v for k, v in saved.items() if k != 'podcast_country'} == {k: v for k, v in original.items() if k != 'podcast_country'}


def test_rank_recommendation_rows_preserves_canonical_deezer_and_library_identities(tmp_path):
    _make_runtime(tmp_path)
    deezer_row = {
        "id": "deezer:300",
        "title": "Deezer Song",
        "artist": "Artist One",
        "source": "deezer",
        "external_ids": {"deezer_id": "300"},
    }
    library_row = {
        "id": "lib-1",
        "track_id": "lib-1",
        "title": "Library Song",
        "artist": "Artist Two",
        "source": "library",
    }
    youtube_row = {
        "id": "dQw4w9WgXcQ",
        "video_id": "dQw4w9WgXcQ",
        "title": "Video Song",
        "artist": "Artist Three",
        "source": "youtube",
    }
    ranked = rank_recommendation_rows([deezer_row, library_row, youtube_row], source="discover")
    by_title = {row["title"]: row["recommendation_identity"] for row in ranked}
    assert by_title["Deezer Song"] == "music:deezer:300"
    assert by_title["Library Song"] == "music:track:lib-1"
    assert by_title["Video Song"] == "music:youtube:dqw4w9wgxcq"


def test_not_interested_deezer_feedback_demotes_deezer_recommendation_row(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    disliked = {
        "id": "deezer:300",
        "title": "Skipped Song",
        "artist": "Artist One",
        "source": "deezer",
        "external_ids": {"deezer_id": "300"},
        "score": 1.0,
    }
    kept = {
        "id": "deezer:301",
        "title": "Kept Song",
        "artist": "Artist Two",
        "source": "deezer",
        "external_ids": {"deezer_id": "301"},
        "score": 1.0,
    }
    event_id = record_not_interested({
        "media_type": "music_track",
        "title": "Skipped Song",
        "artist": "Artist One",
        "deezer_id": "300",
        "source": "discover",
    })
    assert event_id
    ranked = rank_recommendation_rows([disliked, kept], source="discover")
    assert [row["id"] for row in ranked] == ["deezer:301", "deezer:300"]
    assert ranked[1]["score"] < ranked[0]["score"]
    assert recommendation_multiplier("music:deezer:300") < 1.0


def test_identity_aliases_cover_all_provider_ids_and_folded_meta():
    aliases = identity_aliases({
        "youtube_id": "dQw4w9WgXcQ",
        "track_id": "lib-1",
        "isrc": "USRC17607839",
        "deezer_id": "300",
        "mbid": "MBID-123",
        "artist": "Blue Öyster Cult",
        "title": "Don’t Fear (The Reaper)",
    })
    assert aliases == [
        "music:youtube:dqw4w9wgxcq",
        "music:track:lib-1",
        "music:isrc:usrc17607839",
        "music:deezer:300",
        "music:mbid:mbid-123",
        "music:meta:blue oyster cult\x00don’t fear (the reaper)",
    ]
    assert artist_identity({"artist": "Blue Öyster Cult", "deezer_artist_id": "77"}) == (
        "music:artist:blue oyster cult",
        "music_artist",
    )
    assert artist_aliases({"artist": "Blue Öyster Cult", "deezer_artist_id": "77"}) == [
        "music:artist:blue oyster cult",
        "music:deezer_artist:77",
    ]


def test_cross_provider_alias_demotes_across_deezer_youtube_isrc_and_accented_meta_without_double_counting(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    # Record negative feedback from a Deezer row carrying deezer_id + isrc + accented artist.
    event_id = record_not_interested({
        "media_type": "music_track",
        "title": "Été Sauvage",
        "artist": "Café Tacvba",
        "deezer_id": "999",
        "isrc": "MX1234567890",
        "mbid": "mbid-abc",
        "source": "discover",
    })
    assert event_id

    # Lookup by any alias resolves to the exact same single stored signal (no double counting).
    direct = recommendation_multiplier("music:isrc:mx1234567890")
    by_deezer = recommendation_multiplier("music:deezer:999")
    by_mbid = recommendation_multiplier("music:mbid:mbid-abc")
    by_payload = recommendation_multiplier(
        "music:youtube:yt999999999",
        {
            "youtube_id": "yt999999999",
            "isrc": "MX1234567890",
            "deezer_id": "999",
            "artist": "Cafe Tacvba",
            "title": "Ete Sauvage",
        },
    )
    assert direct < 1.0
    assert by_deezer == pytest.approx(direct)
    assert by_mbid == pytest.approx(direct)
    assert by_payload == pytest.approx(direct)

    # YouTube row carrying only youtube_id + isrc (different title) is demoted once.
    yt_by_isrc = {
        "id": "yt111111111",
        "video_id": "yt111111111",
        "title": "Ete Sauvage (Official Video)",
        "artist": "Cafe Tacvba",
        "external_ids": {"youtube_id": "yt111111111", "isrc": "MX1234567890"},
        "score": 1.0,
    }
    # YouTube row carrying no shared provider id matches via diacritic-folded meta fallback.
    yt_by_meta = {
        "id": "yt222222222",
        "video_id": "yt222222222",
        "title": "Ete Sauvage",
        "artist": "Cafe Tacvba",
        "score": 1.0,
    }
    untouched = {
        "id": "yt333333333",
        "video_id": "yt333333333",
        "title": "Other Song",
        "artist": "Other Band",
        "score": 1.0,
    }
    ranked = rank_recommendation_rows([yt_by_isrc, yt_by_meta, untouched], source="discover")
    scores = {row["id"]: row["score"] for row in ranked}
    assert ranked[0]["id"] == "yt333333333"
    assert scores["yt111111111"] == pytest.approx(direct, rel=1e-4)
    assert scores["yt222222222"] == pytest.approx(direct, rel=1e-4)

    # Undo restores every alias back to neutral.
    assert undo_discovery_feedback(event_id) is True
    assert recommendation_multiplier("music:deezer:999") == 1.0
    assert recommendation_multiplier("music:isrc:mx1234567890") == 1.0


def test_less_from_artist_demotes_across_shelves_is_undoable_and_respects_learning_disabled(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    event_id = record_less_from_artist({
        "artist": "Blue Öyster Cult",
        "deezer_artist_id": "42",
        "title": "Track One",
        "source": "discover",
    })
    assert event_id
    mult = artist_recommendation_multiplier("Blue Oyster Cult")
    assert 0.08 <= mult < 1.0
    assert artist_recommendation_multiplier("", deezer_artist_id="42") == pytest.approx(mult)

    rows = [
        {"id": "deezer:1", "title": "Another Song", "artist": "Blue Oyster Cult", "score": 1.0},
        {"id": "deezer:2", "title": "By ID Only", "artist": "BOC", "external_ids": {"deezer_artist_id": "42"}, "score": 1.0},
        {"id": "deezer:3", "title": "Unrelated", "artist": "Thin Lizzy", "score": 1.0},
    ]
    for source in ("discover", "radio", "auto_mode"):
        ranked = rank_recommendation_rows(rows, source=source)
        assert len(ranked) == 3  # soft demotion, never hard-filters
        assert ranked[0]["id"] == "deezer:3"
        assert ranked[1]["score"] == pytest.approx(mult, rel=1e-4)
        assert ranked[2]["score"] == pytest.approx(mult, rel=1e-4)

    # Undo reverses artist demotion.
    assert undo_discovery_feedback(event_id) is True
    assert artist_recommendation_multiplier("Blue Oyster Cult") == 1.0

    # learning_enabled=False records nothing and returns neutral multiplier.
    save_discovery_settings({"learning_enabled": False})
    assert record_less_from_artist({"artist": "Muted Artist", "deezer_artist_id": "99"}) == ""
    assert artist_recommendation_multiplier("Muted Artist", deezer_artist_id="99") == 1.0


def test_discovery_feedback_route_accepts_less_from_artist_and_validates_artist(tmp_path):
    from flask import Flask
    from shared.api.routes.discovery import discovery_bp

    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    app = Flask(__name__)
    app.register_blueprint(discovery_bp)
    client = app.test_client()

    missing = client.post("/api/discovery/feedback", json={"feedback": "less_from_artist", "item": {"title": "No Artist"}})
    assert missing.status_code == 400

    ok = client.post(
        "/api/discovery/feedback",
        json={"feedback": "less_from_artist", "item": {"artist": "Rejected Band", "deezer_artist_id": "77"}},
    )
    assert ok.status_code == 200
    body = ok.get_json()
    assert body["recorded"] is True
    assert body["event_id"]
    assert artist_recommendation_multiplier("Rejected Band") < 1.0

    undone = client.delete(f"/api/discovery/feedback/{body['event_id']}")
    assert undone.status_code == 200
    assert artist_recommendation_multiplier("Rejected Band") == 1.0

    save_discovery_settings({"learning_enabled": False})
    disabled = client.post(
        "/api/discovery/feedback",
        json={"feedback": "less_from_artist", "item": {"artist": "Rejected Band"}},
    )
    assert disabled.status_code == 200
    assert disabled.get_json()["recorded"] is False


def test_collaborations_match_structured_artists_and_record_primary_artist(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    event_id = record_less_from_artist({
        "artist": "Daft Punk, Pharrell Williams",
        "artists": ["Daft Punk", "Pharrell Williams"],
        "title": "Get Lucky",
        "source": "discover",
    })
    assert event_id
    signals = user_db().get_discovery_signals()
    assert "music:artist:daft punk" in signals
    assert "music:artist:pharrell williams" not in signals

    collab = {
        "id": "deezer:10",
        "title": "Lose Yourself to Dance",
        "artist": "Daft Punk, Pharrell Williams",
        "artists": ["Daft Punk", "Pharrell Williams"],
        "score": 1.0,
    }
    solo_pharrell = {
        "id": "deezer:11",
        "title": "Happy",
        "artist": "Pharrell Williams",
        "score": 1.0,
    }
    unstructured_feat = {
        "id": "deezer:12",
        "title": "Other Collab",
        "artist": "Daft Punk feat. Pharrell Williams",
        "score": 1.0,
    }
    ranked = rank_recommendation_rows([collab, solo_pharrell, unstructured_feat], source="discover")
    scores = {row["id"]: row["score"] for row in ranked}
    assert scores["deezer:10"] < scores["deezer:11"]
    assert scores["deezer:11"] == pytest.approx(1.0)
    # Never splits unstructured artist strings on delimiters.
    assert scores["deezer:12"] == pytest.approx(1.0)


def test_profile_policy_v3_backfills_discovery_signal_aliases_from_existing_events(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    db = user_db()
    # Seed a legacy v2 install: signal + event exist, alias table is empty, policy is "2".
    db.record_discovery_signal(
        event_id="legacy-ev-1",
        event="not_interested",
        identity="music:deezer:777",
        media_type="music_track",
        positive_delta=0,
        negative_delta=1,
        payload={
            "media_type": "music_track",
            "title": "Legacy Song",
            "artist": "Blue Öyster Cult",
            "deezer_id": "777",
            "isrc": "USLEG0000001",
        },
        created_at=100,
        aliases=(),
    )
    with db._get_connection() as conn:
        conn.execute("DELETE FROM discovery_signal_aliases")
        conn.execute(
            "INSERT OR REPLACE INTO library_info (key, value) VALUES ('discovery_profile_policy', '2')"
        )
        conn.commit()
    assert db.get_discovery_signal_aliases() == []

    # Reading any multiplier triggers one-time policy v4 backfill into discovery_signal_aliases.
    assert recommendation_multiplier("music:isrc:usleg0000001") < 1.0
    assert db.discovery_profile_policy_version() == "4"
    stored_aliases = set(db.get_discovery_signal_aliases())
    assert ("music:isrc:usleg0000001", "music:deezer:777") in stored_aliases
    assert ("music:meta:blue oyster cult\x00legacy song", "music:deezer:777") in stored_aliases
