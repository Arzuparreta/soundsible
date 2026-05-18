"""Unit tests for migration parsers and matching (no Flask)."""

from shared.migration.match import (
    AUTO_ACCEPT_THRESHOLD,
    CONFIRM_THRESHOLD,
    match_sources_to_library,
    migration_stats,
    track_match_score,
)
from shared.migration.models import SourceTrack
from shared.migration.parsers import ParseError, parse_apple_music_csv, parse_export, parse_spotify_json
from shared.models import Track


def _lib_track(i: int) -> Track:
    return Track(
        id=f"t{i}",
        title=f"Gate Track {i:03d}",
        artist="Gate Artist",
        album="Gate Album",
        duration=180,
        file_hash=f"h{i}",
        original_filename=f"{i}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


def test_parse_spotify_playlist_items():
    raw = """
    {"tracks":{"items":[
      {"track":{"name":"Alpha","artists":[{"name":"Artist One"}],"album":{"name":"Album One"}}},
      {"track":{"name":"Beta","artists":[{"name":"Artist Two"}],"album":{"name":"Album Two"}}}
    ]}}
    """
    rows = parse_spotify_json(raw)
    assert len(rows) == 2
    assert rows[0].title == "Alpha"
    assert rows[1].artist == "Artist Two"


def test_parse_apple_csv_flexible_headers():
    csv_text = "Track Name,Album Artist,Album\nFoo Song,Bar Artist,Baz Album\n"
    rows = parse_apple_music_csv(csv_text)
    assert len(rows) == 1
    assert rows[0].title == "Foo Song"
    assert rows[0].artist == "Bar Artist"


def test_parse_export_dispatch():
    rows = parse_export("spotify_json", '{"tracks":{"items":[{"track":{"name":"Z","artists":[]}}]}}')
    assert len(rows) == 1


def test_parse_invalid_json_raises():
    try:
        parse_spotify_json("{not json")
    except ParseError as e:
        assert "Invalid JSON" in str(e)
    else:
        raise AssertionError("expected ParseError")


def test_track_match_score_identical_high():
    src = SourceTrack(title="Hello World", artist="Some Artist", album="LP")
    lib = Track(
        id="x",
        title="Hello World",
        artist="Some Artist",
        album="LP",
        duration=1,
        file_hash="h",
        original_filename="x.mp3",
        compressed=False,
        file_size=1,
        bitrate=128,
        format="mp3",
    )
    assert track_match_score(src, lib) >= AUTO_ACCEPT_THRESHOLD


def test_fixture_apple_csv_sample_loads():
    from pathlib import Path

    p = Path(__file__).resolve().parent / "fixtures" / "migration" / "apple_two_rows.csv"
    rows = parse_apple_music_csv(p.read_text(encoding="utf-8"))
    assert len(rows) == 2
    assert rows[0].title == "Gate Track 001"


def test_phase1_migration_gate_matched_ratio():
    """Reference gate: >=98% rows match library at or above CONFIRM_THRESHOLD."""
    library = [_lib_track(i) for i in range(1, 51)]
    sources = [SourceTrack(title=f"Gate Track {i:03d}", artist="Gate Artist", album="Gate Album") for i in range(1, 50)]
    sources.append(SourceTrack(title="Completely Unknown Track XYZ", artist="Nobody", album="Nope"))
    results = match_sources_to_library(sources, library)
    stats = migration_stats(results)
    assert stats["total"] == 50
    assert stats["matched"] == 49
    assert stats["matched_ratio"] >= 0.98


def test_confirmation_band_between_thresholds():
    """Near-match title (single candidate) lands between CONFIRM and AUTO_ACCEPT."""
    src = SourceTrack(title="Hello World", artist="Artist A", album="Album")
    mid = Track(
        id="mid",
        title="Yellow World",
        artist="Artist A",
        album="Album",
        duration=1,
        file_hash="hm",
        original_filename="x.mp3",
        compressed=False,
        file_size=1,
        bitrate=128,
        format="mp3",
    )
    results = match_sources_to_library([src], [mid])
    assert len(results) == 1
    r = results[0]
    assert r.matched_track_id == mid.id
    assert CONFIRM_THRESHOLD <= r.confidence < AUTO_ACCEPT_THRESHOLD
    assert r.needs_confirmation is True
    assert r.auto_accept is False
