"""What a client writes back: stars, ratings, plays and playlists."""

import time

from tests.subsonic_support import build, track


def _library():
    return [
        track("t1", title="One", album="Record", track_number=1),
        track("t2", title="Two", album="Record", track_number=2),
        track("t3", title="Elsewhere", album="Other", artist="Someone"),
    ]


# ---------------------------------------------------------------------------
# Stars are favourites
# ---------------------------------------------------------------------------


def test_star_marks_the_same_favourite_the_player_uses(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("star", id="tr-t1")
    assert harness.favourites().is_favourite("t1") is True


def test_unstar_clears_it(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("star", id="tr-t1")
    harness.ok("unstar", id="tr-t1")
    assert harness.favourites().is_favourite("t1") is False


def test_starring_an_album_stars_every_song_on_it(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    album_row = next(row for row in harness.db.get_albums() if row["album"] == "Record")
    harness.ok("star", albumId=f"al-{album_row['id']}")
    favourites = harness.favourites()
    assert favourites.is_favourite("t1") and favourites.is_favourite("t2")
    assert favourites.is_favourite("t3") is False


def test_starred_songs_come_back_marked(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("star", id="tr-t2")
    starred = harness.ok("getStarred2")["starred2"]["song"]
    assert [song["id"] for song in starred] == ["tr-t2"]
    assert starred[0]["starred"]


def test_a_starred_song_reads_as_starred_everywhere(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("star", id="tr-t1")
    song = harness.ok("getSong", id="tr-t1")["song"]
    assert song["starred"]


def test_star_without_an_id_is_a_missing_parameter(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    assert harness.json("star")["error"]["code"] == 10


# ---------------------------------------------------------------------------
# Ratings
# ---------------------------------------------------------------------------


def test_rating_lands_in_the_catalog_and_comes_back(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("setRating", id="tr-t1", rating=4)
    assert harness.db.get_track_user_state("t1")["rating"] == 4
    assert harness.ok("getSong", id="tr-t1")["song"]["userRating"] == 4


def test_rating_zero_clears_it(tmp_path, monkeypatch):
    """Subsonic spells "no rating" as zero; the store spells it NULL."""
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("setRating", id="tr-t1", rating=5)
    harness.ok("setRating", id="tr-t1", rating=0)
    assert harness.db.get_track_user_state("t1")["rating"] is None
    assert "userRating" not in harness.ok("getSong", id="tr-t1")["song"]


def test_a_rating_out_of_range_is_refused(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    assert harness.json("setRating", id="tr-t1", rating=9)["status"] == "failed"
    assert harness.db.get_track_user_state("t1")["rating"] is None


# ---------------------------------------------------------------------------
# Scrobbles
# ---------------------------------------------------------------------------


def test_scrobble_counts_the_play(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("scrobble", id="tr-t1")
    state = harness.db.get_track_user_state("t1")
    assert state["play_count"] == 1
    assert state["last_played_at"] > 0


def test_scrobble_accepts_the_millisecond_clock_clients_send(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    when_ms = int(time.time() * 1000)
    harness.ok("scrobble", id="tr-t1", time=when_ms)
    assert harness.db.get_track_user_state("t1")["last_played_at"] == when_ms // 1000


def test_a_now_playing_notification_is_not_a_play(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("scrobble", id="tr-t1", submission="false")
    assert harness.db.get_track_user_state("t1")["play_count"] == 0


def test_play_counts_surface_on_the_song_and_its_album(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("scrobble", id="tr-t1")
    harness.ok("scrobble", id="tr-t2")
    assert harness.ok("getSong", id="tr-t1")["song"]["playCount"] == 1
    album_row = next(row for row in harness.db.get_albums() if row["album"] == "Record")
    album = harness.ok("getAlbum", id=f"al-{album_row['id']}")["album"]
    assert album["playCount"] == 2


def test_frequent_and_recent_lists_read_those_plays(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("scrobble", id="tr-t3")
    frequent = harness.ok("getAlbumList2", type="frequent", size=10)["albumList2"]["album"]
    recent = harness.ok("getAlbumList2", type="recent", size=10)["albumList2"]["album"]
    assert [album["name"] for album in frequent] == ["Other"]
    assert [album["name"] for album in recent] == ["Other"]


# ---------------------------------------------------------------------------
# Playlists
# ---------------------------------------------------------------------------


def test_playlists_are_the_ones_in_the_manifest(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library(), playlists={"Drive": ["t1", "t3"]})
    playlists = harness.ok("getPlaylists")["playlists"]["playlist"]
    assert [entry["name"] for entry in playlists] == ["Drive"]
    assert playlists[0]["songCount"] == 2


def test_getting_one_playlist_returns_its_songs_in_order(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library(), playlists={"Drive": ["t3", "t1"]})
    entries = harness.ok("getPlaylist", id="Drive")["playlist"]["entry"]
    assert [song["id"] for song in entries] == ["tr-t3", "tr-t1"]


def test_an_unknown_playlist_is_not_found(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    assert harness.json("getPlaylist", id="Nope")["error"]["code"] == 70


def test_creating_a_playlist_writes_it_to_the_manifest(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    harness.ok("createPlaylist", name="Night", songId="tr-t1")
    assert harness.library.metadata.playlists["Night"] == ["t1"]
    assert harness.library.saves == 1


def test_updating_a_playlist_adds_and_removes_by_index(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library(), playlists={"Drive": ["t1", "t2"]})
    response = harness.client.get(
        "/rest/updatePlaylist",
        query_string=harness.auth(f="json", playlistId="Drive", songIdToAdd="tr-t3", songIndexToRemove="0"),
    )
    assert response.status_code == 200
    assert harness.library.metadata.playlists["Drive"] == ["t2", "t3"]


def test_removing_several_indices_removes_the_songs_the_client_meant(tmp_path, monkeypatch):
    """Indices point into the list as received, so they are applied from the end."""
    harness = build(tmp_path, monkeypatch, _library(), playlists={"Drive": ["t1", "t2", "t3"]})
    harness.client.get(
        "/rest/updatePlaylist",
        query_string=[("u", harness.user["username"]), ("p", harness.secret), ("v", "1.16.1"),
                      ("c", "pytest"), ("f", "json"), ("playlistId", "Drive"),
                      ("songIndexToRemove", "0"), ("songIndexToRemove", "2")],
    )
    assert harness.library.metadata.playlists["Drive"] == ["t2"]


def test_renaming_a_playlist(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library(), playlists={"Drive": ["t1"]})
    harness.ok("updatePlaylist", playlistId="Drive", name="Commute")
    assert "Commute" in harness.library.metadata.playlists
    assert "Drive" not in harness.library.metadata.playlists


def test_deleting_a_playlist(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library(), playlists={"Drive": ["t1"]})
    harness.ok("deletePlaylist", id="Drive")
    assert harness.library.metadata.playlists == {}


def test_deleting_a_playlist_that_is_not_there_is_not_found(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, _library())
    assert harness.json("deletePlaylist", id="Ghost")["error"]["code"] == 70
