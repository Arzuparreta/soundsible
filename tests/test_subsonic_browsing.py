"""Browsing the catalog: the envelope, the index, and the lists clients page."""

import json

from tests.subsonic_support import XML_NS, build, track


def _library():
    return [
        track("t1", title="Opening", artist="Björk", artists=["Björk"], album="Debut", year=1993, track_number=1),
        track("t2", title="Closing", artist="Björk", artists=["Björk"], album="Debut", year=1993, track_number=2),
        track(
            "t3",
            title="Duet",
            artist="Björk & Rosalía",
            artists=["Björk", "Rosalía"],
            album="Oral",
            album_artist="Björk",
            year=2023,
            genre="Pop",
            disc_number=2,
        ),
        track("t4", title="Solo", artist="The Beatles", album="Revolver", year=1966, genre="Rock"),
    ]


# ---------------------------------------------------------------------------
# The envelope
# ---------------------------------------------------------------------------


def test_json_envelope_carries_the_server_identity(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    body = harness.ok("ping")
    assert body["type"] == "soundsible"
    assert body["openSubsonic"] is True
    assert body["serverVersion"]


def test_xml_is_the_default_format(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    root = harness.xml("ping")
    assert root.tag == f"{XML_NS}subsonic-response"
    assert root.attrib["status"] == "ok"
    assert root.attrib["openSubsonic"] == "true"


def test_xml_maps_scalars_to_attributes_and_lists_to_elements(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    root = harness.xml("getArtists")
    artists = root.find(f"{XML_NS}artists")
    assert artists.attrib["ignoredArticles"].startswith("The")
    names = [node.attrib["name"] for node in artists.iter(f"{XML_NS}artist")]
    assert "Björk" in names


def test_jsonp_wraps_the_document_in_the_callback(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="jsonp", callback="cb"))
    assert response.data.startswith(b"cb({")
    assert response.data.endswith(b");")


def test_jsonp_without_a_callback_does_not_answer_executable_json(tmp_path, monkeypatch):
    """A JSON body served to a script tag would run; XML cannot."""
    harness = build(tmp_path, monkeypatch, _library())
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="jsonp"))
    assert response.mimetype == "text/xml"
    assert b"subsonic-response" in response.data


def test_jsonp_rejects_a_callback_that_is_not_an_identifier(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    response = harness.client.get(
        "/rest/ping", query_string=harness.auth(f="jsonp", callback="alert(1)//")
    )
    assert response.mimetype == "text/xml"


def test_unknown_methods_answer_in_the_protocol(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    response = harness.client.get("/rest/getPodcasts", query_string=harness.auth(f="json"))
    assert response.status_code == 200
    assert json.loads(response.data)["subsonic-response"]["status"] == "failed"


def test_dot_view_spelling_reaches_the_same_method(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    response = harness.client.get("/rest/ping.view", query_string=harness.auth(f="json"))
    assert json.loads(response.data)["subsonic-response"]["status"] == "ok"


def test_form_posts_are_accepted(tmp_path, monkeypatch):
    """The `formPost` extension: credentials in a body, not a URL."""
    harness = build(tmp_path, monkeypatch, _library())
    response = harness.client.post("/rest/ping", data=harness.auth(f="json"))
    assert json.loads(response.data)["subsonic-response"]["status"] == "ok"


# ---------------------------------------------------------------------------
# Artists and albums
# ---------------------------------------------------------------------------


def test_artists_are_indexed_by_letter_ignoring_articles(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    index = harness.ok("getArtists")["artists"]["index"]
    letters = {entry["name"]: [artist["name"] for artist in entry["artist"]] for entry in index}
    assert "The Beatles" in letters["B"]
    assert "Björk" in letters["B"]
    assert "Rosalía" in letters["R"]


def test_get_indexes_answers_the_same_shape_with_a_timestamp(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    indexes = harness.ok("getIndexes")["indexes"]
    assert indexes["lastModified"] > 0
    assert indexes["index"]


def test_get_artist_lists_its_albums(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    bjork = next(
        row for row in harness.db.get_artists() if row["name"] == "Björk"
    )
    payload = harness.ok("getArtist", id=f"ar-{bjork['id']}")["artist"]
    assert payload["name"] == "Björk"
    assert {album["name"] for album in payload["album"]} == {"Debut", "Oral"}
    assert payload["albumCount"] == 2


def test_a_featured_performer_is_an_artist_without_owning_the_album(tmp_path, monkeypatch):
    """`Björk & Rosalía` is two artists; only Björk is credited with the album."""
    harness = build(tmp_path, monkeypatch, _library())
    rosalia = next(row for row in harness.db.get_artists() if row["name"] == "Rosalía")
    payload = harness.ok("getArtist", id=f"ar-{rosalia['id']}")["artist"]
    assert payload["albumCount"] == 0


def test_get_album_returns_songs_in_disc_and_track_order(tmp_path, monkeypatch):
    tracks = [
        track("b2", title="Second", album="Box", disc_number=1, track_number=2),
        track("b3", title="Third", album="Box", disc_number=2, track_number=1),
        track("b1", title="First", album="Box", disc_number=1, track_number=1),
    ]
    harness = build(tmp_path, monkeypatch, tracks)
    album_row = harness.db.get_albums()[0]
    songs = harness.ok("getAlbum", id=f"al-{album_row['id']}")["album"]["song"]
    assert [song["title"] for song in songs] == ["First", "Second", "Third"]


def test_song_carries_its_ordered_performers_and_ids(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    song = harness.ok("getSong", id="tr-t3")["song"]
    assert [entry["name"] for entry in song["artists"]] == ["Björk", "Rosalía"]
    assert song["displayAlbumArtist"] == "Björk"
    assert song["albumId"].startswith("al-")
    assert song["discNumber"] == 2


def test_song_path_is_synthetic_and_hides_the_disk(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    song = harness.ok("getSong", id="tr-t1")["song"]
    assert song["path"] == "Björk/Debut/01 - Opening.mp3"
    assert not song["path"].startswith("/")


def test_homonymous_albums_do_not_collapse(tmp_path, monkeypatch):
    harness = build(
        tmp_path,
        monkeypatch,
        [
            track("x1", album="Greatest Hits", artist="One"),
            track("x2", album="Greatest Hits", artist="Two"),
        ],
    )
    albums = harness.ok("getAlbumList2", type="alphabeticalByName", size=10)["albumList2"]["album"]
    assert len(albums) == 2
    assert len({album["id"] for album in albums}) == 2


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------


def test_album_list_orders_alphabetically_by_artist(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    albums = harness.ok("getAlbumList2", type="alphabeticalByArtist", size=10)["albumList2"]["album"]
    assert [album["artist"] for album in albums] == ["Björk", "Björk", "The Beatles"]


def test_album_list_pages(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    first = harness.ok("getAlbumList2", type="alphabeticalByName", size=1)["albumList2"]["album"]
    second = harness.ok("getAlbumList2", type="alphabeticalByName", size=1, offset=1)["albumList2"]["album"]
    assert len(first) == len(second) == 1
    assert first[0]["id"] != second[0]["id"]


def test_album_list_by_year_filters_the_range(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    albums = harness.ok("getAlbumList2", type="byYear", fromYear=1990, toYear=2000, size=10)
    names = [album["name"] for album in albums["albumList2"]["album"]]
    assert names == ["Debut"]


def test_reversing_the_year_range_reverses_the_order(tmp_path, monkeypatch):
    """`fromYear > toYear` is how the protocol asks for newest first."""
    harness = build(tmp_path, monkeypatch, _library())
    albums = harness.ok("getAlbumList2", type="byYear", fromYear=2030, toYear=1900, size=10)
    years = [album["year"] for album in albums["albumList2"]["album"]]
    assert years == sorted(years, reverse=True)


def test_album_list_by_genre(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    albums = harness.ok("getAlbumList2", type="byGenre", genre="Pop", size=10)["albumList2"]["album"]
    assert [album["name"] for album in albums] == ["Oral"]


def test_unknown_list_type_is_empty_rather_than_wrong(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    assert harness.ok("getAlbumList2", type="byMood", size=10)["albumList2"]["album"] == []


def test_pre_id3_album_list_marks_entries_as_directories(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    albums = harness.ok("getAlbumList", type="alphabeticalByName", size=10)["albumList"]["album"]
    assert all(album["isDir"] for album in albums)


def test_genres_count_songs_and_albums(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    genres = {entry["value"]: entry for entry in harness.ok("getGenres")["genres"]["genre"]}
    assert genres["Rock"]["songCount"] == 3
    assert genres["Rock"]["albumCount"] == 2
    assert genres["Pop"]["songCount"] == 1


def test_songs_by_genre(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    songs = harness.ok("getSongsByGenre", genre="Pop", count=10)["songsByGenre"]["song"]
    assert [song["title"] for song in songs] == ["Duet"]


def test_random_songs_stay_inside_the_filter(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    songs = harness.ok("getRandomSongs", size=10, genre="Rock")["randomSongs"]["song"]
    assert {song["genre"] for song in songs} == {"Rock"}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def test_search3_matches_artists_albums_and_songs(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    result = harness.ok("search3", query="debut")["searchResult3"]
    assert [album["name"] for album in result["album"]] == ["Debut"]
    # An album name matches its songs too — that is what a listener searching
    # for a record expects to get back.
    assert {song["title"] for song in result["song"]} == {"Opening", "Closing"}
    assert result["artist"] == []


def test_search_folds_accents_and_case_like_the_catalog(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    result = harness.ok("search3", query="BJÖRK")["searchResult3"]
    assert "Björk" in [artist["name"] for artist in result["artist"]]


def test_search_counts_limit_each_kind(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    result = harness.ok("search3", query="", artistCount=1, albumCount=1, songCount=2)["searchResult3"]
    assert len(result["artist"]) == 1
    assert len(result["album"]) == 1
    assert len(result["song"]) == 2


# ---------------------------------------------------------------------------
# Podcasts are not music
# ---------------------------------------------------------------------------


def test_podcast_episodes_never_appear_as_songs_albums_or_artists(tmp_path, monkeypatch):
    tracks = _library() + [
        track(
            "p1",
            title="Episode 1",
            artist="Some Show",
            album="Some Show",
            genre="Talk",
            media_kind="podcast_episode",
        )
    ]
    harness = build(tmp_path, monkeypatch, tracks)

    index = harness.ok("getArtists")["artists"]["index"]
    assert "Some Show" not in [a["name"] for entry in index for a in entry["artist"]]

    albums = harness.ok("getAlbumList2", type="alphabeticalByName", size=50)["albumList2"]["album"]
    assert "Some Show" not in [album["name"] for album in albums]

    assert harness.ok("getGenres")["genres"]["genre"]
    assert "Talk" not in [entry["value"] for entry in harness.ok("getGenres")["genres"]["genre"]]

    songs = harness.ok("search3", query="Episode")["searchResult3"]["song"]
    assert songs == []


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------


def test_music_folders_expose_the_single_library(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    folders = harness.ok("getMusicFolders")["musicFolders"]["musicFolder"]
    assert folders == [{"id": 0, "name": "Music"}]


def test_extensions_announce_api_key_and_lyrics(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    names = {entry["name"] for entry in harness.ok("getOpenSubsonicExtensions")["openSubsonicExtensions"]}
    assert {"apiKeyAuthentication", "songLyrics"} <= names


def test_get_user_describes_the_caller_only(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    user = harness.ok("getUser")["user"]
    assert user["username"] == harness.user["username"]
    assert user["streamRole"] is True
    assert harness.json("getUser", username="somebody-else")["status"] == "failed"


def test_scan_status_reports_the_library_size(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    assert harness.ok("getScanStatus")["scanStatus"]["count"] == 4
