import sqlite3

import pytest

from shared.database import DatabaseManager
from shared.library_catalog import build_catalog_snapshot
from shared.models import LibraryMetadata, Track


def _track(
    track_id: str,
    *,
    title: str = "Song",
    artist: str = "Artist",
    artists=None,
    album: str = "Album",
    album_artist: str | None = None,
    disc_number: int | None = None,
    disc_total: int | None = None,
    is_compilation: bool = False,
) -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        artists=artists,
        album=album,
        album_artist=album_artist,
        duration=180,
        file_hash=track_id,
        original_filename=f"{track_id}.flac",
        compressed=False,
        file_size=10,
        bitrate=900,
        format="flac",
        track_number=1,
        disc_number=disc_number,
        disc_total=disc_total,
        is_compilation=is_compilation,
    )


def _metadata(*tracks: Track) -> LibraryMetadata:
    return LibraryMetadata(version=1, tracks=list(tracks), playlists={}, settings={})


def test_sync_builds_first_class_albums_and_ordered_artists(tmp_path):
    collaboration = _track(
        "a1",
        artist="Björk & Rosalía",
        artists=["Björk", "Rosalía"],
        album="Same Name",
        album_artist="Björk",
        disc_number=2,
        disc_total=3,
    )
    homonym = _track("b1", artist="Another Artist", album="Same Name")
    compilation = _track(
        "c1",
        artist="Guest",
        album="Summer Collection",
        is_compilation=True,
    )
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(_metadata(collaboration, homonym, compilation))

    albums = db.get_albums()
    assert len(albums) == 3
    assert len({row["id"] for row in albums if row["album"] == "Same Name"}) == 2
    assert next(row for row in albums if row["album"] == "Summer Collection")["artist"] == "Various Artists"

    [stored] = db.get_tracks_by_album_id(next(row["id"] for row in albums if row["artist"] == "Björk"))
    assert stored.artists == ["Björk", "Rosalía"]
    assert stored.disc_number == 2
    assert stored.disc_total == 3

    artist_rows = {row["name"]: row for row in db.get_artists()}
    assert artist_rows["Björk"]["track_count"] == 1
    assert artist_rows["Rosalía"]["track_count"] == 1
    assert artist_rows["Various Artists"]["album_count"] == 1


def test_legacy_artist_display_is_never_split_heuristically(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(_metadata(_track("funk", artist="Earth, Wind & Fire")))

    performers = [row for row in db.get_artists() if row["track_count"]]
    assert [row["name"] for row in performers] == ["Earth, Wind & Fire"]


def test_catalog_ids_are_stable_across_case_spacing_and_input_order():
    left = _track("one", artist="Björk", album="Debut", album_artist="Björk")
    right = _track("two", artist=" björk ", album="  debut ", album_artist="BJÖRK")

    first = build_catalog_snapshot([left, right])
    second = build_catalog_snapshot([right, left])

    assert {row.id for row in first.artists} == {row.id for row in second.artists}
    assert {row.id for row in first.albums} == {row.id for row in second.albums}
    assert len(first.artists) == 1
    assert len(first.albums) == 1


def test_user_state_survives_resync_and_is_pruned_with_the_track(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(_metadata(_track("keep"), _track("remove")))
    assert db.set_track_rating("keep", 5) is True
    assert db.record_track_play("keep", 100) is True
    assert db.record_track_play("keep", 90) is True

    db.sync_from_metadata(_metadata(_track("keep", title="Renamed")))
    assert db.get_track_user_state("keep") == {
        "play_count": 2,
        "rating": 5,
        "last_played_at": 100,
    }
    assert db.get_track_user_state("remove") is None


@pytest.mark.parametrize("rating", [0, 6, 2.5, True])
def test_rating_contract_rejects_values_outside_one_to_five(tmp_path, rating):
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(_metadata(_track("t")))
    with pytest.raises(ValueError):
        db.set_track_rating("t", rating)


def test_existing_flat_database_is_backfilled_on_upgrade(tmp_path):
    path = tmp_path / "legacy.db"
    db = DatabaseManager(str(path))
    with db._get_connection() as conn:
        conn.execute(
            "INSERT INTO tracks (id, title, artist, album, duration, file_hash, original_filename, compressed, file_size, bitrate, format) "
            "VALUES ('legacy', 'Song', 'Legacy Artist', 'Legacy Album', 180, 'hash', 'song.mp3', 0, 10, 128, 'mp3')"
        )
        conn.execute("DROP TABLE track_user_state")
        conn.execute("DROP TABLE track_artists")
        conn.execute("DROP TABLE albums")
        conn.execute("DROP TABLE artists")
        conn.execute("ALTER TABLE tracks DROP COLUMN album_id")
        conn.execute("ALTER TABLE tracks DROP COLUMN is_compilation")
        conn.execute("ALTER TABLE tracks DROP COLUMN disc_total")
        conn.execute("ALTER TABLE tracks DROP COLUMN disc_number")

    upgraded = DatabaseManager(str(path))

    assert upgraded.get_albums()[0]["album"] == "Legacy Album"
    assert upgraded.get_artists()[0]["name"] == "Legacy Artist"


def test_new_track_fields_round_trip_through_json_and_sqlite(tmp_path):
    original = _track(
        "structured",
        artists=["One", "Two"],
        artist="One & Two",
        disc_number=1,
        disc_total=2,
        is_compilation=True,
    )
    serialized = _metadata(original).to_json()
    [parsed] = LibraryMetadata.from_json(serialized).tracks
    assert parsed.artists == ["One", "Two"]
    assert parsed.disc_number == 1
    assert parsed.disc_total == 2
    assert parsed.is_compilation is True

    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(_metadata(parsed))
    [stored] = db.get_all_tracks()
    assert stored.artists == ["One", "Two"]
    assert stored.is_compilation is True
