from types import SimpleNamespace

from shared.discovery_intelligence import emit_discovery_event, reset_discovery_profile
from shared.discovery_seeds import (
    clear_recent_seeds,
    load_saved_entity_artists,
    record_recent_graph_seeds,
    record_recent_taste_seeds,
    select_graph_seed_tracks,
    select_release_seed_artists,
    select_taste_artists,
)
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.user_context import user_context


def _setup_runtime(tmp_path):
    reset_runtime()
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
    clear_recent_seeds(clear_all=True)


def _track(
    tid: str,
    artist: str,
    *,
    added_at: str = "2026-01-01T00:00:00",
    youtube_id: str | None = None,
    media_kind: str | None = None,
) -> Track:
    return Track(
        id=tid,
        title=f"Title {tid}",
        artist=artist,
        album="Album",
        duration=180,
        file_hash=f"h-{tid}",
        original_filename=f"{tid}.mp3",
        file_size=1000,
        bitrate=320,
        format="mp3",
        added_at=added_at,
        youtube_id=youtube_id,
        media_kind=media_kind,
    )


def test_taste_artists_fold_diacritics_and_rotate_per_user(tmp_path):
    _setup_runtime(tmp_path)
    try:
        tracks = [
            _track("t1", "Blue Öyster Cult"),
            _track("t2", "Blue Oyster Cult"),
            _track("t3", "Artist Two"),
            _track("t4", "Artist Three"),
            _track("t5", "Artist Four"),
            _track("t6", "Artist Five"),
            _track("t7", "Artist Six"),
        ]
        metadata = LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})
        emit_discovery_event("music_played_30s", {"title": "Don't Fear the Reaper", "artist": "Blue Oyster Cult"})

        first = select_taste_artists(metadata, ["t1", "t3"], limit=5, user_id="alice", rotate=False)
        assert len(first) == 5
        assert sum(1 for a in first if "oyster" in a.lower().replace("ö", "o")) == 1
        assert first[0] == "Blue Öyster Cult"

        record_recent_taste_seeds("alice", first[:3])
        rotated = select_taste_artists(metadata, ["t1", "t3"], limit=5, user_id="alice", rotate=True)
        # Rotation dampens recent seeds without starving the full limit.
        assert len(rotated) == 5
        assert rotated[:2] != first[:2]

        # Another user keeps independent rotation state.
        bob_seeds = select_taste_artists(metadata, ["t1", "t3"], limit=5, user_id="bob", rotate=True)
        assert bob_seeds == first

        # Small libraries still return all available artists under rotation.
        reset_discovery_profile()
        tiny = LibraryMetadata(version=1, tracks=[_track("a", "Only One"), _track("b", "Only Two")], playlists={}, settings={})
        record_recent_taste_seeds("alice", ["Only One", "Only Two"])
        assert set(select_taste_artists(tiny, [], limit=5, user_id="alice", rotate=True)) == {"Only One", "Only Two"}
    finally:
        clear_recent_seeds(clear_all=True)
        reset_runtime()


def test_graph_seeds_rotate_filter_podcasts_and_reset_clears_history(tmp_path):
    _setup_runtime(tmp_path)
    try:
        tracks = [
            _track("pod", "Host", added_at="2026-11-10T00:00:00", youtube_id="vidpod00001", media_kind="podcast_episode"),
            _track("noyt", "Artist NoYT", added_at="2026-11-09T00:00:00", youtube_id=None),
            _track("t1", "Artist 1", added_at="2026-11-01T00:00:00", youtube_id="vid11111111"),
            _track("t2", "Artist 2", added_at="2026-11-02T00:00:00", youtube_id="vid22222222"),
            _track("t3", "Artist 3", added_at="2026-11-03T00:00:00", youtube_id="vid33333333"),
            _track("t4", "Artist 4", added_at="2026-11-04T00:00:00", youtube_id="vid44444444"),
        ]
        metadata = LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})
        picked = select_graph_seed_tracks(metadata, ["t1"], limit=3, user_id="alice", require_youtube_id=True)
        picked_ids = [t.id for t in picked]
        assert "pod" not in picked_ids
        assert "noyt" not in picked_ids
        assert picked_ids[0] == "t1"

        record_recent_graph_seeds("alice", ["t1", "t4"])
        rotated = [t.id for t in select_graph_seed_tracks(metadata, ["t1"], limit=3, user_id="alice", rotate=True, require_youtube_id=True)]
        assert rotated[0] in ("t3", "t2")
        assert "t1" not in rotated[:2]

        with user_context("alice"):
            reset_discovery_profile()
        after_reset = [t.id for t in select_graph_seed_tracks(metadata, ["t1"], limit=3, user_id="alice", rotate=True, require_youtube_id=True)]
        assert after_reset[0] == "t1"
    finally:
        clear_recent_seeds(clear_all=True)
        reset_runtime()


def test_saved_entities_feed_taste_and_unrotated_release_seeds(tmp_path):
    from player import saved_entities

    _setup_runtime(tmp_path)
    try:
        with user_context("alice"):
            saved_entities.set_saved(
                {
                    "kind": "album",
                    "name": "La ley innata",
                    "artist": "Extremoduro",
                    "destination": "/album/La%20ley%20innata?deezer_id=901&view=discover",
                },
                True,
            )
            saved_entities.set_saved(
                {
                    "kind": "artist",
                    "name": "Marea",
                    "destination": "/artist/Marea?deezer_id=42&view=discover",
                },
                True,
            )
            saved_entities.set_saved(
                {
                    "kind": "artist",
                    "name": "Extremoduro",
                    "destination": "/artist/Extremoduro?deezer_id=77&view=discover",
                },
                True,
            )

        extracted = load_saved_entity_artists("alice")
        assert extracted == [
            {"name": "Extremoduro", "deezer_id": "77", "kind": "artist"},
            {"name": "Marea", "deezer_id": "42", "kind": "artist"},
        ]

        empty_metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
        assert select_taste_artists(empty_metadata, [], limit=5, user_id="alice") == ["Extremoduro", "Marea"]
        assert select_taste_artists(empty_metadata, [], limit=5, user_id="bob") == []

        record_recent_taste_seeds("alice", ["Extremoduro", "Marea"])
        tracks = [_track("t1", "Robe"), _track("t2", "Platero y Tú")]
        rich = LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})
        release_seeds = select_release_seed_artists(rich, ["t1"], limit=5, user_id="alice")
        # Release seeds never rotate away saved artists and keep known deezer_ids.
        assert release_seeds[:2] == [
            {"name": "Extremoduro", "deezer_id": "77"},
            {"name": "Marea", "deezer_id": "42"},
        ]
        assert [item["name"] for item in release_seeds] == ["Extremoduro", "Marea", "Robe", "Platero y Tú"]
    finally:
        clear_recent_seeds(clear_all=True)
        reset_runtime()
