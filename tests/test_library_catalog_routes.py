"""`/api/library/albums|artists|genres|years` — the player's view of the catalog.

The contract these tests defend is that the player and a Subsonic client browse
*one* catalog. Every case below is one the browser-side grouping this surface
replaces used to get wrong: homonymous records collapsing into one, a
compilation filed under whichever guest came first, a display string standing in
for structured credits.
"""

import json

import pytest
from flask import Flask

from shared.api.routes.library_catalog import library_catalog_bp
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track


def _track(
    track_id: str,
    *,
    title: str = "Song",
    artist: str = "Artist",
    artists=None,
    album: str = "Album",
    album_artist: str | None = None,
    genre: str | None = "Rock",
    year: int | None = 2001,
    track_number: int | None = 1,
    disc_number: int | None = None,
    is_compilation: bool = False,
    media_kind: str | None = None,
) -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        artists=artists,
        album=album,
        album_artist=album_artist,
        duration=180,
        file_hash=f"hash-{track_id}",
        original_filename=f"{track_id}.flac",
        compressed=False,
        file_size=10,
        bitrate=900,
        format="flac",
        year=year,
        genre=genre,
        track_number=track_number,
        disc_number=disc_number,
        is_compilation=is_compilation,
        media_kind=media_kind,
    )


class _FakeLibrary:
    """Just enough library for these routes: a manifest and a real index."""

    def __init__(self, metadata: LibraryMetadata, db: DatabaseManager | None):
        self.metadata = metadata
        self.db = db

    def refresh_if_stale(self) -> None:
        return None

    def sync_library(self) -> bool:
        return True


def _client(tmp_path, monkeypatch, *tracks: Track, with_index: bool = True):
    metadata = LibraryMetadata(version=1, tracks=list(tracks), playlists={}, settings={})
    db = None
    if with_index:
        db = DatabaseManager(str(tmp_path / "library.db"))
        db.sync_from_metadata(metadata)
    library = _FakeLibrary(metadata, db)
    monkeypatch.setattr("shared.api.get_core", lambda: (library, None, None), raising=False)

    app = Flask(__name__)
    app.register_blueprint(library_catalog_bp)
    return app.test_client()


def _json(client, path: str, expect: int = 200):
    response = client.get(path)
    assert response.status_code == expect, response.data
    return json.loads(response.data)


def test_records_sharing_a_title_stay_two_albums(tmp_path, monkeypatch):
    client = _client(
        tmp_path,
        monkeypatch,
        _track("a", artist="Björk", album="Same Name", album_artist="Björk"),
        _track("b", artist="Another Artist", album="Same Name"),
    )

    albums = _json(client, "/api/library/albums")["albums"]
    assert [row["title"] for row in albums] == ["Same Name", "Same Name"]
    assert len({row["id"] for row in albums}) == 2
    assert {row["album_artist"] for row in albums} == {"Björk", "Another Artist"}


def test_a_compilation_is_filed_under_various_artists(tmp_path, monkeypatch):
    client = _client(
        tmp_path,
        monkeypatch,
        _track("c1", artist="Guest One", album="Summer Collection", is_compilation=True),
        _track("c2", artist="Guest Two", album="Summer Collection", is_compilation=True),
    )

    [album] = _json(client, "/api/library/albums")["albums"]
    assert album["album_artist"] == "Various Artists"
    assert album["is_compilation"] is True
    assert album["track_count"] == 2


def test_album_cover_is_the_opening_track_not_the_lowest_id(tmp_path, monkeypatch):
    """The same track `getCoverArt` would hand a Subsonic client for this album."""
    client = _client(
        tmp_path,
        monkeypatch,
        _track("zz-opener", title="Opener", track_number=1, disc_number=1),
        _track("aa-closer", title="Closer", track_number=2, disc_number=1),
    )

    [album] = _json(client, "/api/library/albums")["albums"]
    assert album["cover_track_id"] == "zz-opener"


def test_albums_can_be_filtered_by_genre_and_by_year(tmp_path, monkeypatch):
    client = _client(
        tmp_path,
        monkeypatch,
        _track("r", album="Rock Record", genre="Rock", year=1994),
        _track("j", artist="Other", album="Jazz Record", genre="Jazz", year=2011),
    )

    by_genre = _json(client, "/api/library/albums?genre=jazz")["albums"]
    assert [row["title"] for row in by_genre] == ["Jazz Record"]

    by_year = _json(client, "/api/library/albums?year=1994")["albums"]
    assert [row["title"] for row in by_year] == ["Rock Record"]

    in_range = _json(client, "/api/library/albums?from_year=1990&to_year=2000")["albums"]
    assert [row["title"] for row in in_range] == ["Rock Record"]


def test_a_year_filter_needs_no_second_bound(tmp_path, monkeypatch):
    """`from_year` alone is "since", not "nothing" — an open range is still a range."""
    client = _client(
        tmp_path,
        monkeypatch,
        _track("old", album="Old", year=1975),
        _track("new", artist="Other", album="New", year=2020),
    )

    since = _json(client, "/api/library/albums?from_year=2000")["albums"]
    assert [row["title"] for row in since] == ["New"]

    until = _json(client, "/api/library/albums?to_year=2000")["albums"]
    assert [row["title"] for row in until] == ["Old"]


@pytest.mark.parametrize("sort", ["alphabeticalByName", "alphabeticalByArtist", "newest", "byYear"])
def test_every_offered_ordering_is_one_subsonic_also_serves(tmp_path, monkeypatch, sort):
    client = _client(tmp_path, monkeypatch, _track("t"))
    assert sort in DatabaseManager.ALBUM_ORDERINGS
    assert len(_json(client, f"/api/library/albums?sort={sort}")["albums"]) == 1


def test_an_ordering_nobody_serves_is_refused_rather_than_ignored(tmp_path, monkeypatch):
    """A silently empty grid reads as an empty library, which is a lie."""
    client = _client(tmp_path, monkeypatch, _track("t"))
    assert "error" in _json(client, "/api/library/albums?sort=byVibes", expect=400)


def test_album_tracks_arrive_in_disc_and_track_order(tmp_path, monkeypatch):
    client = _client(
        tmp_path,
        monkeypatch,
        _track("d2t1", title="Third", disc_number=2, track_number=1),
        _track("d1t2", title="Second", disc_number=1, track_number=2),
        _track("d1t1", title="First", disc_number=1, track_number=1),
    )

    [album] = _json(client, "/api/library/albums")["albums"]
    body = _json(client, f"/api/library/albums/{album['id']}")
    assert body["track_ids"] == ["d1t1", "d1t2", "d2t1"]
    assert body["album"]["title"] == "Album"


def test_an_artist_owns_the_tracks_they_perform_on_not_a_string_match(tmp_path, monkeypatch):
    """`Earth, Wind & Fire` is one artist; `["Björk", "Rosalía"]` is two."""
    client = _client(
        tmp_path,
        monkeypatch,
        _track("duet", artist="Björk & Rosalía", artists=["Björk", "Rosalía"], album="Duets"),
        _track("solo", artist="Earth, Wind & Fire", album="Gratitude"),
    )

    artists = {row["name"]: row for row in _json(client, "/api/library/artists")["artists"]}
    assert set(artists) == {"Björk", "Rosalía", "Earth, Wind & Fire"}

    body = _json(client, f"/api/library/artists/{artists['Rosalía']['id']}")
    assert body["track_ids"] == ["duet"]
    assert [album["title"] for album in body["albums"]] == []

    bjork = _json(client, f"/api/library/artists/{artists['Björk']['id']}")
    assert [album["title"] for album in bjork["albums"]] == ["Duets"]


def test_an_album_artist_who_performs_nothing_is_not_a_face_in_the_grid(tmp_path, monkeypatch):
    client = _client(
        tmp_path,
        monkeypatch,
        _track("c1", artist="Guest", album="Summer Collection", is_compilation=True),
    )

    names = [row["name"] for row in _json(client, "/api/library/artists")["artists"]]
    assert names == ["Guest"]


def test_genres_and_years_report_what_carries_them(tmp_path, monkeypatch):
    client = _client(
        tmp_path,
        monkeypatch,
        _track("r1", album="Rock Record", genre="Rock", year=1994),
        _track("r2", album="Rock Record", genre="Rock", year=1994, track_number=2),
        _track("j1", artist="Other", album="Jazz Record", genre="Jazz", year=2011),
    )

    genres = {row["name"]: row for row in _json(client, "/api/library/genres")["genres"]}
    assert genres["Rock"] == {"name": "Rock", "song_count": 2, "album_count": 1}

    years = _json(client, "/api/library/years")["years"]
    # Newest first: a library is browsed backwards from now.
    assert [row["year"] for row in years] == [2011, 1994]
    assert years[1] == {"year": 1994, "album_count": 1, "track_count": 2}


def test_a_podcast_episode_is_not_an_album_a_genre_or_a_year(tmp_path, monkeypatch):
    client = _client(
        tmp_path,
        monkeypatch,
        _track("song", album="Real Album", genre="Rock", year=1994),
        _track(
            "episode",
            title="Episode 1",
            artist="Some Host",
            album="Some Show",
            genre="Talk",
            year=2024,
            media_kind="podcast_episode",
        ),
    )

    assert [row["title"] for row in _json(client, "/api/library/albums")["albums"]] == ["Real Album"]
    assert [row["name"] for row in _json(client, "/api/library/genres")["genres"]] == ["Rock"]
    assert [row["year"] for row in _json(client, "/api/library/years")["years"]] == [1994]
    assert [row["name"] for row in _json(client, "/api/library/artists")["artists"]] == ["Artist"]


def test_an_unknown_entity_is_a_404_not_an_empty_page(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, _track("t"))
    assert "error" in _json(client, "/api/library/albums/nope", expect=404)
    assert "error" in _json(client, "/api/library/artists/nope", expect=404)


def test_a_library_without_an_index_says_try_again_rather_than_failing(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, _track("t"), with_index=False)
    assert "error" in _json(client, "/api/library/albums", expect=503)
