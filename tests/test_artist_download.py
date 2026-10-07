"""Everything by an artist: their albums, singles and EPs, each song once, each
filed on its own record."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from shared.api.routes import catalog
from shared.migration import collections


def _release(release_id: str, title: str, record_type: str, year: str) -> dict:
    return {"id": release_id, "title": title, "record_type": record_type, "release_date": f"{year}-01-01", "cover_xl": ""}


def _track(track_id: int, title: str, isrc: str, position: int = 1) -> dict:
    return {
        "id": track_id, "title": title, "title_short": title, "duration": 240, "isrc": isrc,
        "artist": {"id": 27, "name": "Daft Punk"}, "disk_number": 1, "track_position": position,
    }


LISTINGS = {
    "10": [_track(1, "One More Time", "GBDUW0000053", 1), _track(2, "Digital Love", "GBDUW0000055", 3)],
    # The single of a song the album already has: same recording, same ISRC.
    "20": [_track(3, "One More Time", "GB-DUW-00-00053")],
    # Somebody else's compilation that includes them.
    "30": [_track(4, "One More Time", "GBDUW0000053")],
    "40": [_track(5, "Something About Us (Live)", "GBDUW0100001")],
}


@pytest.fixture
def deezer(monkeypatch):
    unreadable: set[str] = set()

    def fake_get(path, params=None, timeout=8):
        if path == "artist/27":
            return {"id": 27, "name": "Daft Punk"}
        if path == "artist/27/albums":
            return {"data": [
                _release("20", "One More Time (Single)", "single", "2000"),
                _release("10", "Discovery", "album", "2001"),
                _release("30", "Now That's What I Call 2001", "compile", "2001"),
                _release("40", "Alive EP", "ep", "2003"),
                _release("50", "Lost Tapes", "album", "1999"),
            ]}
        release_id = path.split("/")[1]
        if release_id in unreadable or release_id not in LISTINGS:
            raise RuntimeError("unreadable")
        rows = LISTINGS[release_id]
        start = int(params["index"])
        return {"data": rows[start:start + int(params["limit"])], "total": len(rows)}

    monkeypatch.setattr(catalog, "_deezer_get", fake_get)
    catalog._discography_memo.clear()
    return unreadable


def test_the_discography_is_albums_then_singles_and_eps_each_song_once(deezer):
    discography = catalog._deezer_artist_discography("27")

    assert discography["artist"] == "Daft Punk"
    assert [release["title"] for release in discography["releases"]] == ["Discovery", "Alive EP"]
    assert [item["title"] for item in discography["tracklist"]] == [
        "One More Time", "Digital Love", "Something About Us (Live)",
    ]
    # Kept on the album, not the single; the compilation never counts.
    assert discography["tracklist"][0]["album"] == "Discovery"
    assert discography["tracklist"][0]["external_ids"]["isrc"] == "GBDUW0000053"
    # Each song carries the year of the record it is kept on.
    assert [item["raw"].get("year") for item in discography["tracklist"]] == [2001, 2001, 2003]
    assert discography["partial_failures"] == ["Lost Tapes"]
    assert discography["truncated"] is False


def test_a_runaway_discography_is_bounded(deezer, monkeypatch):
    monkeypatch.setattr(catalog, "_DISCOGRAPHY_MAX_SONGS", 2)

    discography = catalog._deezer_artist_discography("27")

    assert len(discography["tracklist"]) == 2
    assert discography["truncated"] is True


def test_every_song_is_filed_on_its_own_record(deezer):
    manifest = collections.artist_manifest("27", catalog._deezer_artist_discography("27"))

    assert manifest.provider == "artist:27"
    assert manifest.source_name == "Daft Punk"
    placed = {source.title: source for source in manifest.tracks.values()}
    assert (placed["Digital Love"].album, placed["Digital Love"].year, placed["Digital Love"].track_number) == ("Discovery", 2001, 3)
    assert (placed["Something About Us (Live)"].album, placed["Something About Us (Live)"].year) == ("Alive EP", 2003)
    assert all(source.album_artist == "Daft Punk" for source in manifest.tracks.values())
    assert placed["One More Time"].identity_keys == ("cat:deezer:track:1", "isrc:GBDUW0000053", "deezer:1")


def test_the_artist_routes_list_download_and_report(deezer, monkeypatch):
    from shared.api import app

    monkeypatch.setattr(catalog, "_library_tracks", lambda: [])
    monkeypatch.setattr("shared.migration.service.start_migration_job", MagicMock())
    app.config["TESTING"] = True
    client = app.test_client()

    listing = client.get("/api/catalog/artist/discography?deezer_id=27").get_json()
    assert len(listing["tracklist"]) == 3
    assert client.get("/api/catalog/artist/download?deezer_id=27").get_json() == {"job": None}

    response = client.post("/api/catalog/artist/download", json={"deezer_id": "27"})
    assert response.status_code == 202
    job = response.get_json()["job"]
    assert (job["provider"], job["selected_track_count"]) == ("artist:27", 3)
    assert client.get("/api/catalog/artist/download?deezer_id=27").get_json()["job"]["id"] == job["id"]
    assert client.get("/api/catalog/artist/discography?deezer_id=x").status_code == 400
