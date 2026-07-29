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
