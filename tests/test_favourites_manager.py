"""
FavouritesManager: identity-keyed entries, the saved/favourite split, file
migration, and the library-id contract every existing caller still relies on.
"""

import json

import pytest

from player.favourites_manager import FavouritesManager


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr("player.favourites_manager.user_config_dir", lambda: tmp_path)
    return FavouritesManager()


def _reload(tmp_path, monkeypatch):
    monkeypatch.setattr("player.favourites_manager.user_config_dir", lambda: tmp_path)
    return FavouritesManager()


def _write_v1(tmp_path, ids):
    (tmp_path / "favourites.json").write_text(
        json.dumps({"version": "1.0", "favourites": list(ids)})
    )


def _write_v2(tmp_path, entries):
    (tmp_path / "favourites.json").write_text(
        json.dumps({"version": "2.0", "favourites": list(entries)})
    )


# ── Migration ──

def test_v1_id_array_loads_as_library_entries(tmp_path, monkeypatch):
    _write_v1(tmp_path, ["t1", "t2"])
    manager = _reload(tmp_path, monkeypatch)

    assert manager.get_all() == ["t1", "t2"]
    assert manager.is_favourite("t1")
    assert [e["keys"] for e in manager.get_entries()] == [["lib:t1"], ["lib:t2"]]


def test_pre_split_entries_load_as_favourites(tmp_path, monkeypatch):
    """The heart used to be the only way to save a song, so every entry in an
    older file is one the user marked — reading them as plain saves would wipe
    the marks off a whole library."""
    _write_v2(tmp_path, [{"keys": ["yt:vid"], "title": "Weightless", "artist": "MU"}])
    manager = _reload(tmp_path, monkeypatch)

    assert manager.is_favourite_keys(["yt:vid"])
    assert manager.is_saved_keys(["yt:vid"])


def test_v1_file_is_rewritten_as_v3_on_first_change(tmp_path, monkeypatch):
    _write_v1(tmp_path, ["t1"])
    manager = _reload(tmp_path, monkeypatch)
    manager.add("t2")

    data = json.loads((tmp_path / "favourites.json").read_text())
    assert data["version"] == "3.0"
    assert [e["keys"] for e in data["saved"]] == [["lib:t2"], ["lib:t1"]]
    # Written under the old name too, so an older build reads a list rather
    # than a blank slate.
    assert data["favourites"] == data["saved"]


def test_corrupt_file_starts_fresh(tmp_path, monkeypatch):
    (tmp_path / "favourites.json").write_text("{not json")
    manager = _reload(tmp_path, monkeypatch)

    assert manager.get_entries() == []
    assert manager.size() == 0


# ── Saved and favourite are different facts ──

def test_saving_does_not_mark(manager):
    assert manager.toggle_saved({"keys": ["yt:vid"], "title": "S", "artist": "A"}) is True

    assert manager.is_saved_keys(["yt:vid"])
    assert not manager.is_favourite_keys(["yt:vid"])
    assert manager.get_favourite_entries() == []


def test_marking_an_unsaved_song_saves_it(manager):
    """You cannot single out a song you do not have, so the heart does both."""
    assert manager.set_favourite({"keys": ["yt:vid"], "title": "S", "artist": "A"}) is True

    assert manager.is_saved_keys(["yt:vid"])
    assert manager.is_favourite_keys(["yt:vid"])


def test_unmarking_a_streamed_song_leaves_it_saved(manager):
    manager.set_favourite({"keys": ["yt:vid"], "title": "S", "artist": "A"})

    assert manager.set_favourite({"keys": ["yt:vid"]}) is False
    assert manager.is_saved_keys(["yt:vid"])
    assert not manager.is_favourite_keys(["yt:vid"])


def test_unsaving_drops_the_mark_with_the_song(manager):
    manager.set_favourite({"keys": ["yt:vid"], "title": "S", "artist": "A"})

    assert manager.toggle_saved({"keys": ["yt:vid"]}) is False
    assert not manager.is_saved_keys(["yt:vid"])
    assert not manager.is_favourite_keys(["yt:vid"])


def test_marking_a_bare_save_fills_in_its_snapshot(manager):
    """＋ from a row that knows nothing writes a bare entry; the heart usually
    arrives from a surface that knows the title."""
    manager.toggle_saved({"keys": ["yt:vid"]})
    manager.set_favourite({"keys": ["yt:vid"], "title": "Weightless", "artist": "MU"})

    entry = manager.get_entries()[0]
    assert entry["title"] == "Weightless"
    assert entry["artist"] == "MU"


def test_set_favourite_is_explicit_when_asked(manager):
    manager.toggle_saved({"keys": ["yt:vid"]})

    assert manager.set_favourite({"keys": ["yt:vid"]}, True) is True
    assert manager.set_favourite({"keys": ["yt:vid"]}, True) is True  # idempotent
    assert manager.set_favourite({"keys": ["yt:vid"]}, False) is False


# ── Identity matching ──

def test_toggle_saved_matches_on_any_shared_key(manager):
    assert manager.toggle_saved(
        {"keys": ["yt:vid123", "deezer:99"], "title": "Weightless", "artist": "Marconi Union"}
    ) is True

    # A different surface offering the same song shares only one key.
    assert manager.is_saved_keys(["cat:x", "deezer:99"])
    assert manager.toggle_saved({"keys": ["deezer:99"]}) is False
    assert manager.get_entries() == []


def test_entry_keeps_its_snapshot(manager):
    manager.toggle_saved({
        "keys": ["yt:vid123"],
        "title": "Weightless",
        "artist": "Marconi Union",
        "album": "Ambient",
        "duration": 490.0,
        "thumbnail": "https://example.invalid/t.jpg",
    })
    entry = manager.get_entries()[0]

    assert entry["title"] == "Weightless"
    assert entry["artist"] == "Marconi Union"
    assert entry["album"] == "Ambient"
    assert entry["duration"] == 490
    assert entry["thumbnail"] == "https://example.invalid/t.jpg"
    assert entry["added_at"]


def test_entry_without_keys_is_rejected(manager):
    with pytest.raises(ValueError):
        manager.toggle_saved({"title": "Nameless", "keys": []})
    with pytest.raises(ValueError):
        manager.set_favourite({"title": "Nameless", "keys": []})


def test_get_all_only_reports_marked_library_keys(manager):
    manager.set_favourite({"keys": ["yt:vid123"], "title": "Streamed", "artist": "X"})
    manager.set_favourite({"keys": ["lib:hash1", "yt:vid456"], "title": "Owned", "artist": "Y"})
    manager.toggle_saved({"keys": ["lib:hash2"], "title": "Merely saved", "artist": "Z"})

    assert manager.get_all() == ["hash1"]
    assert manager.size() == 2


# ── Ordering ──

def test_order_is_newest_first_and_survives_a_reload(tmp_path, monkeypatch):
    manager = _reload(tmp_path, monkeypatch)
    manager.add("t1")
    manager.add("t2")
    manager.toggle_saved({"keys": ["yt:vid"], "title": "Third", "artist": "Z"})

    assert manager.get_all() == ["t2", "t1"]
    reloaded = _reload(tmp_path, monkeypatch)
    assert [e["keys"][0] for e in reloaded.get_entries()] == ["yt:vid", "lib:t2", "lib:t1"]
    # A reload of a v3 file keeps saved and marked apart.
    assert not reloaded.is_favourite_keys(["yt:vid"])
    assert reloaded.is_favourite("t2")


# ── Widening and remapping ──

def test_update_keys_widens_an_existing_entry(manager):
    manager.toggle_saved({"keys": ["deezer:99"], "title": "Weightless", "artist": "Marconi Union"})

    assert manager.update_keys(["deezer:99"], ["yt:vid123"]) is True
    assert manager.is_saved_keys(["yt:vid123"])
    # Idempotent: nothing new to learn.
    assert manager.update_keys(["deezer:99"], ["yt:vid123"]) is False
    assert manager.update_keys(["nothing:here"], ["yt:other"]) is False


def test_remap_library_id_preserves_the_snapshot(manager):
    manager.toggle_saved({"keys": ["lib:old", "yt:vid"], "title": "Song", "artist": "A"})
    added_at = manager.get_entries()[0]["added_at"]

    assert manager.remap_library_id("old", "new") is True
    entry = manager.get_entries()[0]
    assert "lib:new" in entry["keys"]
    assert "lib:old" not in entry["keys"]
    assert "yt:vid" in entry["keys"]
    assert entry["title"] == "Song"
    assert entry["added_at"] == added_at
    assert manager.remap_library_id("missing", "other") is False


# ── Library-id compatibility layer ──

def test_library_id_api_round_trip(manager):
    manager.add("t1")
    manager.add("t1")  # idempotent
    assert manager.get_all() == ["t1"]
    assert manager.toggle("t1") is False
    assert manager.get_all() == []
    assert manager.toggle("t1") is True
    assert manager.is_favourite("t1")
    manager.remove("t1")
    assert not manager.is_favourite("t1")


def test_unmarking_a_downloaded_song_drops_its_entry(manager):
    """The library holds the file, so the entry was only ever the mark. Keeping
    a saved-but-unmarked record of a song you own says nothing."""
    manager.set_favourite({"keys": ["lib:hash1", "yt:vid"], "title": "Song", "artist": "A"})
    manager.remove("hash1")

    assert manager.get_entries() == []
    assert not manager.is_favourite_keys(["yt:vid"])


def test_change_callbacks_fire_on_mutation(manager):
    calls = []
    manager.add_change_callback(lambda: calls.append(1))
    manager.add("t1")
    manager.toggle_saved({"keys": ["yt:vid"], "title": "S", "artist": "A"})
    manager.clear()

    assert len(calls) == 3


def test_explicit_unmark_does_not_recreate_a_song_removed_by_another_client(manager):
    entry = {"keys": ["yt:K3JGxj2rvAs"], "title": "Song", "artist": "Artist"}
    manager.set_favourite(entry, True)
    manager.set_favourite(entry, False)
    manager.set_saved([entry], False)
    assert manager.get_entries() == []
    assert manager.set_favourite(entry, False, save_if_missing=False) is False
    assert manager.get_entries() == []
    assert manager.set_favourite(entry, True, save_if_missing=False) is True
    assert manager.set_favourite(entry, True, save_if_missing=False) is True
    assert len(manager.get_entries()) == 1


def test_a_saved_song_keeps_its_place_on_its_record(manager):
    """A saved stream is downloaded later from its entry alone, so the entry is
    what files it under its record."""
    manager.toggle_saved({
        "keys": ["yt:vid"], "title": "Song", "artist": "Artist", "album": "Album",
        "album_artist": "Artist", "track_number": 3, "disc_number": 2, "year": 2001,
    })
    entry = manager.get_entries()[0]
    assert (entry["album_artist"], entry["track_number"], entry["disc_number"], entry["year"]) == ("Artist", 3, 2, 2001)


def test_marking_a_song_never_mixes_two_records(manager):
    # Saved from the single; marked from a search row naming the album only.
    manager.toggle_saved({"keys": ["isrc:X"], "album": "Song (Single)", "year": 2010})
    manager.set_favourite({"keys": ["isrc:X"], "album": "Album", "year": 2011})
    entry = manager.get_entries()[0]
    assert (entry["album"], entry["year"]) == ("Song (Single)", 2010)
    manager.set_favourite({"keys": ["isrc:X"], "favourite": False}, False)
    # Marked from the album's own row, which places it: the record is replaced whole.
    manager.set_favourite({"keys": ["isrc:X"], "album": "Album", "album_artist": "Artist", "track_number": 4})
    entry = manager.get_entries()[0]
    assert (entry["album"], entry["album_artist"], entry["track_number"]) == ("Album", "Artist", 4)
    assert "year" not in entry


def test_marking_fills_a_record_from_the_same_album(manager):
    manager.toggle_saved({"keys": ["isrc:X"], "album": "Album"})
    manager.set_favourite({"keys": ["isrc:X"], "album": "album", "track_number": 4, "disc_number": 1, "year": 2011})
    entry = manager.get_entries()[0]
    assert (entry["album"], entry["track_number"], entry["disc_number"], entry["year"]) == ("Album", 4, 1, 2011)


def test_a_record_without_an_album_is_replaced_whole(manager):
    manager.toggle_saved({"keys": ["isrc:X"], "year": 2010})
    manager.set_favourite({"keys": ["isrc:X"], "album": "Album", "track_number": 4})
    entry = manager.get_entries()[0]
    assert (entry["album"], entry["track_number"]) == ("Album", 4)
    assert "year" not in entry


def test_a_saved_songs_place_is_bounded_like_a_catalog_save(manager):
    # An upload date read as a year, a zero, a fraction, a flag, text.
    manager.toggle_saved({"keys": ["yt:vid"], "year": 20101012, "track_number": 0, "disc_number": 1.5})
    manager.toggle_saved({"keys": ["yt:other"], "track_number": True, "disc_number": "2"})
    for entry in manager.get_entries():
        assert not {"track_number", "disc_number", "year"} & set(entry)


def test_marking_a_bare_save_fills_in_its_place_on_the_record(manager):
    manager.toggle_saved({"keys": ["yt:vid"]})
    manager.set_favourite({"keys": ["yt:vid"], "album": "Album", "track_number": 4, "year": 1999})
    entry = manager.get_entries()[0]
    assert (entry["track_number"], entry["year"]) == (4, 1999)


def test_a_mark_already_set_elsewhere_still_fills_the_record(manager):
    # Another device marked the bare save first; this one knows the album row.
    manager.toggle_saved({"keys": ["isrc:X"]})
    manager.set_favourite({"keys": ["isrc:X"]}, True)
    manager.set_favourite({"keys": ["isrc:X"], "album": "Album", "track_number": 4, "year": 2011}, True)
    entry = manager.get_entries()[0]
    assert (entry["favourite"], entry["album"], entry["track_number"], entry["year"]) == (True, "Album", 4, 2011)


def test_adding_an_album_fills_in_songs_already_saved(manager):
    manager.toggle_saved({"keys": ["isrc:X"], "title": "Song"})
    enriched = []
    changed = manager.set_saved([{"keys": ["isrc:X"], "album": "Album", "track_number": 4, "year": 2011}], True, enriched)
    assert changed == [] and len(enriched) == 1
    entry = manager.get_entries()[0]
    assert (entry["album"], entry["track_number"], entry["year"]) == ("Album", 4, 2011)
    # Nothing new to say: nothing reported.
    enriched.clear()
    manager.set_saved([{"keys": ["isrc:X"], "album": "Album", "track_number": 4}], True, enriched)
    assert enriched == []


def test_a_new_record_brings_its_own_cover(manager):
    manager.toggle_saved({"keys": ["isrc:X"], "album": "Song (Single)", "thumbnail": "https://example.invalid/single.jpg"})
    manager.set_favourite({"keys": ["isrc:X"], "album": "Album", "track_number": 4, "thumbnail": "https://example.invalid/album.jpg"}, True)
    assert manager.get_entries()[0]["thumbnail"] == "https://example.invalid/album.jpg"
