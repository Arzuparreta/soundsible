"""Unit tests for the multi-horizon artist taste profile (Phase 1)."""

from __future__ import annotations

import time
from types import SimpleNamespace

from flask import Flask
import pytest

from shared.api.routes import subsonic as subsonic_routes
from shared.database import user_db
from shared.discovery_intelligence import (
    emit_discovery_event,
    load_listening_event_rollups,
    reset_discovery_profile,
)
from shared.discovery_profile import build_artist_taste_profile, select_release_profile_artists
from shared.discovery_seeds import select_release_seed_artists, select_taste_artists
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context


def _track(tid: str, artist: str, *, title: str | None = None, youtube_id: str | None = None) -> Track:
    return Track(
        id=tid,
        title=title or f"Song {tid}",
        artist=artist,
        album="Album",
        duration=180,
        file_hash=f"h-{tid}",
        original_filename=f"{tid}.mp3",
        file_size=1000,
        bitrate=320,
        format="mp3",
        youtube_id=youtube_id,
    )


def test_bookmarks_pins_carry_zero_weight_in_taste_and_releases():
    from player import saved_entities

    saved_entities.set_saved(
        {
            "kind": "artist",
            "name": "Pinned Artist",
            "destination": "/artist/Pinned%20Artist?deezer_id=999&view=discover",
        },
        True,
    )
    saved_entities.set_saved(
        {
            "kind": "album",
            "name": "Pinned Album",
            "artist": "Pinned Album Artist",
            "destination": "/album/Pinned%20Album?deezer_id=998&view=discover",
        },
        True,
    )
    empty = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})

    assert build_artist_taste_profile(empty, [], persist=True) == []
    assert select_taste_artists(empty, [], limit=5) == []
    assert select_release_seed_artists(empty, [], limit=8) == []


def test_session_dedup_search_click_non_counting_and_binge_cap():
    now = 1_800_000_000
    # Clicking play from search must not count as a listen.
    emit_discovery_event(
        "music_search_played",
        {"title": "Clicked Only", "artist": "Click Bait", "source": "search"},
        created_at=now - 60,
    )
    empty = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    assert build_artist_taste_profile(empty, [], now=now) == []

    # Same play_session_id emitting 30s then completed upgrades once instead of double-counting.
    emit_discovery_event(
        "music_played_30s",
        {
            "title": "Track 1",
            "artist": "Binge Artist",
            "source": "library",
            "play_session_id": "sess-1",
        },
        created_at=now - 180,
    )
    emit_discovery_event(
        "music_play_completed",
        {
            "title": "Track 1",
            "artist": "Binge Artist",
            "source": "library",
            "play_session_id": "sess-1",
        },
        created_at=now - 30,
    )
    # 19 more plays on the exact same day should saturate at the daily cap (2.5).
    for idx in range(19):
        emit_discovery_event(
            "music_play_completed",
            {
                "title": "Track 1",
                "artist": "Binge Artist",
                "source": "library",
                "play_session_id": f"sess-binge-{idx}",
            },
            created_at=now - 10,
        )

    # Habit artist: only 8 completions spread across 8 distinct weeks & 4 tracks.
    for w in range(8):
        emit_discovery_event(
            "music_play_completed",
            {
                "title": f"Song {w % 4}",
                "artist": "Habit Artist",
                "source": "library",
                "play_session_id": f"habit-{w}",
            },
            created_at=now - (w * 7 * 86400),
        )

    profile = {entry.display_name: entry for entry in build_artist_taste_profile(empty, [], now=now)}
    assert "Click Bait" not in profile
    assert profile["Binge Artist"].active_plays == 20.0
    assert profile["Habit Artist"].effective_score > profile["Binge Artist"].effective_score
    assert profile["Habit Artist"].distinct_days == 8
    assert profile["Habit Artist"].distinct_tracks == 4


def test_passive_generated_weight_and_early_skip_behavior():
    now = 1_800_000_000
    empty = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    emit_discovery_event(
        "music_play_completed",
        {"title": "Active Song", "artist": "Active Choice", "source": "search", "play_session_id": "a1"},
        created_at=now - 100,
    )
    emit_discovery_event(
        "music_played_30s",
        {"title": "Auto Song", "artist": "Autoplay Choice", "source": "autoplay", "play_session_id": "g1"},
        created_at=now - 100,
    )
    # Early skip in library must not penalize; early skip in discover gently attenuates.
    emit_discovery_event(
        "music_play_completed",
        {"title": "Owned Song", "artist": "Library Band", "source": "library", "play_session_id": "l1"},
        created_at=now - 200,
    )
    emit_discovery_event(
        "music_play_skipped_early",
        {"title": "Owned Song 2", "artist": "Library Band", "source": "library", "play_session_id": "l2"},
        created_at=now - 100,
    )
    emit_discovery_event(
        "music_play_completed",
        {"title": "Discovered Song", "artist": "Discover Band", "source": "discover", "play_session_id": "d1"},
        created_at=now - 200,
    )
    emit_discovery_event(
        "music_play_skipped_early",
        {"title": "Discovered Song 2", "artist": "Discover Band", "source": "discover", "play_session_id": "d2"},
        created_at=now - 100,
    )

    profile = {entry.display_name: entry for entry in build_artist_taste_profile(empty, [], now=now)}
    assert profile["Active Choice"].effective_score > profile["Autoplay Choice"].effective_score
    assert profile["Autoplay Choice"].passive_plays == 1.0
    assert profile["Library Band"].early_skips == 0.0
    assert profile["Discover Band"].early_skips == 1.0
    assert profile["Library Band"].effective_score > profile["Discover Band"].effective_score


def test_cold_start_priors_saturate_and_yield_as_listening_matures():
    now = 1_800_000_000
    tracks = [_track(f"h{i}", "Hoarded Band") for i in range(50)] + [_track("f1", "Fav Band")]
    metadata = LibraryMetadata(version=1, tracks=tracks, playlists={"Mix": [f"h{i}" for i in range(10)]}, settings={})

    cold_profile = {e.display_name: e for e in build_artist_taste_profile(metadata, ["f1"], now=now)}
    assert cold_profile["Hoarded Band"].library_prior <= 6.0
    assert cold_profile["Fav Band"].library_prior > 0.0

    # Once the listener builds 105 real sessions for another artist, gamma drops from 1.0 to 0.2.
    for i in range(105):
        emit_discovery_event(
            "music_play_completed",
            {
                "title": f"Real {i % 10}",
                "artist": "Listened Real",
                "source": "library",
                "play_session_id": f"real-{i}",
            },
            created_at=now - (i % 30) * 86400,
        )

    mature_profile = {e.display_name: e for e in build_artist_taste_profile(metadata, ["f1"], now=now)}
    assert mature_profile["Listened Real"].effective_score > mature_profile["Hoarded Band"].effective_score


def test_subsonic_scrobble_emits_profile_listen_and_persists_profile(monkeypatch):
    db = user_db()
    track = _track("sub-1", "Subsonic Artist", title="Subsonic Song")
    db.replace_library(LibraryMetadata(version=1, tracks=[track], playlists={}, settings={}))

    import shared.scrobble as scrobble_mod

    app = Flask(__name__)
    app.register_blueprint(subsonic_routes.subsonic_bp)
    monkeypatch.setattr(subsonic_routes, "_authenticate", lambda: {"id": "testuser"})
    monkeypatch.setattr(subsonic_routes, "_db", lambda: db)
    monkeypatch.setattr(
        scrobble_mod,
        "get_scrobble_service",
        lambda: SimpleNamespace(is_active=lambda _uid: False),
    )

    now_sec = int(time.time()) - 120
    with app.test_client() as client:
        res = client.get(f"/rest/scrobble.view?id={track.id}&time={now_sec}&f=json")
    assert res.status_code == 200

    rollup = load_listening_event_rollups()
    assert rollup.artist_plays["subsonic artist"] == 1

    meta = LibraryMetadata(version=1, tracks=[track], playlists={}, settings={})
    profile = build_artist_taste_profile(meta, [], persist=True)
    assert profile[0].display_name == "Subsonic Artist"
    persisted = db.get_discovery_artist_profile()
    assert persisted and persisted[0]["display_name"] == "Subsonic Artist"

    reset_discovery_profile()
    assert db.get_discovery_artist_profile() == []


def test_select_release_profile_artists_unions_short_and_long_term():
    now = 1_800_000_000
    empty = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    for i in range(6):
        emit_discovery_event(
            "music_play_completed",
            {"title": f"Old {i}", "artist": "Legacy Core", "source": "library", "play_session_id": f"lc-{i}"},
            created_at=now - (i + 1) * 20 * 86400,
        )
    for i in range(3):
        emit_discovery_event(
            "music_play_completed",
            {"title": f"Fresh {i}", "artist": "New Obsession", "source": "discover", "play_session_id": f"no-{i}"},
            created_at=now - i * 86400,
        )
    profile = build_artist_taste_profile(empty, [], now=now)
    releases = select_release_profile_artists(profile, limit=35)
    assert {r.display_name for r in releases} == {"Legacy Core", "New Obsession"}
