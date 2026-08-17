"""When a song joined the library, and everything that must not move it.

"Recently added" used to be inferred from list position — the manifest is
appended to, so later meant newer — and that inference cannot survive contact
with the second way of having a song. A saved song has no file and no place in
the manifest, so no arrangement of the two lists can put a song saved today
above a file downloaded last week. On the station this was found on the songs
tab opened on the same track for twelve days while 137 songs were saved behind
it.

`Track.added_at` is that missing fact. These tests pin the two halves of making
it trustworthy: every way of acquiring music writes it, and nothing that
rewrites a row is allowed to change it.
"""

import os
import time

from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.track_identity import preserve_track_identity


def _track(track_id: str, **overrides) -> Track:
    values = {
        "id": track_id,
        "title": f"Song {track_id}",
        "artist": "Artist",
        "album": "Album",
        "duration": 180,
        "file_hash": track_id,
        "original_filename": f"{track_id}.flac",
        "compressed": False,
        "file_size": 10,
        "bitrate": 900,
        "format": "flac",
    }
    values.update(overrides)
    return Track(**values)


def _library(*tracks: Track) -> LibraryMetadata:
    return LibraryMetadata(version=1, tracks=list(tracks), playlists={}, settings={})


def _dates(db: DatabaseManager) -> dict:
    metadata = db.load_library_metadata()
    return {track.id: track.added_at for track in metadata.tracks}


def test_a_song_is_dated_when_it_joins_the_library():
    """`add_track` is where every acquisition path meets — download, migration,
    a shared track, the ODST tool — so it is where a song learns its date."""
    library = _library()

    library.add_track(_track("new"))

    assert library.tracks[0].added_at


def test_a_caller_that_knows_better_keeps_its_own_date():
    """A folder scan reads mtimes, and a download of a song saved weeks ago
    carries the date of the save. Neither is "now"."""
    library = _library()

    library.add_track(_track("scanned", added_at="2026-07-02T10:00:00"))

    assert library.tracks[0].added_at == "2026-07-02T10:00:00"


def test_the_date_survives_a_round_trip_through_sqlite(tmp_path):
    db = DatabaseManager(str(tmp_path / "library.db"))

    db.replace_library(_library(_track("song", added_at="2026-07-02T10:00:00")))

    assert _dates(db) == {"song": "2026-07-02T10:00:00"}


def test_a_rewrite_cannot_redate_a_song_the_library_already_holds(tmp_path):
    """Saving the library rewrites every row. A manifest that has forgotten the
    date — an older export, a copy from another machine — must not be able to
    hand the whole library the date of that one save."""
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(_library(_track("song", added_at="2026-07-02T10:00:00")))

    db.replace_library(_library(_track("song", title="Renamed", added_at=None)))

    assert _dates(db) == {"song": "2026-07-02T10:00:00"}


def test_a_re_keyed_song_keeps_the_date_of_the_row_it_replaced(tmp_path):
    """A rescan or a lossless upgrade gives one song a new id. It is the same
    song, in the library since the same day, and it must not resurface at the
    top of "recently added" as though it had just arrived."""
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(_library(_track("old", added_at="2026-07-02T10:00:00")))

    db.replace_library(_library(_track("new")), id_replacements={"old": "new"})

    assert _dates(db) == {"new": "2026-07-02T10:00:00"}


def test_a_tag_edit_that_re_hashes_the_file_keeps_the_date():
    original = _track("before", added_at="2026-07-02T10:00:00")

    refreshed = preserve_track_identity(original, _track("after"))

    assert refreshed.added_at == "2026-07-02T10:00:00"


def test_an_undated_library_is_dated_from_its_own_audio_files(tmp_path):
    """The upgrade path. A library built before this column existed has no dates
    anywhere — and `last_updated` is not one, because every row carries the
    instant of the last migration. The files do remember: each was written when
    it was acquired.
    """
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(_library(_track("april"), _track("august")))
    files = {}
    for track_id, when in (("april", "2026-04-30 19:42:07"), ("august", "2026-08-05 02:52:05")):
        path = tmp_path / f"{track_id}.flac"
        path.write_bytes(b"audio")
        stamp = time.mktime(time.strptime(when, "%Y-%m-%d %H:%M:%S"))
        os.utime(path, (stamp, stamp))
        files[track_id] = str(path)

    assert db.backfill_added_at(lambda track: files.get(track.id)) == 2

    dated = _dates(db)
    assert dated["april"] < dated["august"]
    assert dated["april"].startswith("2026-04-30")


def test_a_file_that_cannot_be_reached_keeps_its_place_in_the_library(tmp_path):
    """Remote storage, a deleted file, a manifest imported from elsewhere. The
    manifest order is the only thing known about those songs, so it is what they
    are dated by — never dropped to the bottom of the list."""
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(_library(_track("first"), _track("second"), _track("third")))
    reachable = tmp_path / "second.flac"
    reachable.write_bytes(b"audio")
    stamp = time.mktime(time.strptime("2026-06-01 09:00:00", "%Y-%m-%d %H:%M:%S"))
    os.utime(reachable, (stamp, stamp))

    db.backfill_added_at(lambda track: str(reachable) if track.id == "second" else None)

    dated = _dates(db)
    assert dated["first"] < dated["second"] < dated["third"]


def test_dating_an_already_dated_library_does_nothing(tmp_path):
    """It runs whenever a library is opened, so it has to be free once it has
    nothing to do — and it must never touch a date it did not write."""
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(_library(_track("song", added_at="2026-07-02T10:00:00")))

    assert db.backfill_added_at(lambda track: None) == 0
    assert _dates(db) == {"song": "2026-07-02T10:00:00"}


def test_albums_are_ordered_by_when_their_songs_joined(tmp_path):
    """What `getAlbumList2` and the player's album grid both read. It used to be
    `MAX(last_updated)`, which is identical across a migrated library, so the
    newest albums were whatever sorted first by title."""
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(
        _library(
            _track("old", album="First", added_at="2026-01-01T00:00:00"),
            _track("new", album="Second", added_at="2026-08-01T00:00:00"),
        )
    )

    albums = db.get_albums_page("newest", size=10)

    assert [album["title"] for album in albums] == ["Second", "First"]
