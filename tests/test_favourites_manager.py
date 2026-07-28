"""
FavouritesManager: identity-keyed entries, v1 migration, and the library-id
contract every existing caller still relies on.
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


# ── v1 → v2 migration ──

def test_v1_id_array_loads_as_library_entries(tmp_path, monkeypatch):
    _write_v1(tmp_path, ["t1", "t2"])
    manager = _reload(tmp_path, monkeypatch)

    assert manager.get_all() == ["t1", "t2"]
    assert manager.is_favourite("t1")
    assert [e["keys"] for e in manager.get_entries()] == [["lib:t1"], ["lib:t2"]]


def test_v1_file_is_rewritten_as_v2_on_first_change(tmp_path, monkeypatch):
    _write_v1(tmp_path, ["t1"])
    manager = _reload(tmp_path, monkeypatch)
    manager.add("t2")

    data = json.loads((tmp_path / "favourites.json").read_text())
    assert data["version"] == "2.0"
    assert [e["keys"] for e in data["favourites"]] == [["lib:t2"], ["lib:t1"]]


def test_corrupt_file_starts_fresh(tmp_path, monkeypatch):
    (tmp_path / "favourites.json").write_text("{not json")
    manager = _reload(tmp_path, monkeypatch)

    assert manager.get_entries() == []
    assert manager.size() == 0


# ── Identity matching ──

def test_toggle_entry_matches_on_any_shared_key(manager):
    assert manager.toggle_entry(
        {"keys": ["yt:vid123", "deezer:99"], "title": "Weightless", "artist": "Marconi Union"}
    ) is True

    # A different surface offering the same song shares only one key.
    assert manager.is_favourite_keys(["cat:x", "deezer:99"])
    assert manager.toggle_entry({"keys": ["deezer:99"]}) is False
    assert manager.get_entries() == []


def test_entry_keeps_its_snapshot(manager):
    manager.toggle_entry({
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
        manager.toggle_entry({"title": "Nameless", "keys": []})


def test_get_all_only_reports_library_keys(manager):
    manager.toggle_entry({"keys": ["yt:vid123"], "title": "Streamed", "artist": "X"})
    manager.toggle_entry({"keys": ["lib:hash1", "yt:vid456"], "title": "Owned", "artist": "Y"})

    assert manager.get_all() == ["hash1"]
    assert manager.size() == 2


# ── Ordering ──

def test_order_is_newest_first_and_survives_a_reload(tmp_path, monkeypatch):
    manager = _reload(tmp_path, monkeypatch)
    manager.add("t1")
    manager.add("t2")
    manager.toggle_entry({"keys": ["yt:vid"], "title": "Third", "artist": "Z"})

    assert manager.get_all() == ["t2", "t1"]
    reloaded = _reload(tmp_path, monkeypatch)
    assert [e["keys"][0] for e in reloaded.get_entries()] == ["yt:vid", "lib:t2", "lib:t1"]


# ── Widening and remapping ──

def test_update_keys_widens_an_existing_entry(manager):
    manager.toggle_entry({"keys": ["deezer:99"], "title": "Weightless", "artist": "Marconi Union"})

    assert manager.update_keys(["deezer:99"], ["yt:vid123"]) is True
    assert manager.is_favourite_keys(["yt:vid123"])
    # Idempotent: nothing new to learn.
    assert manager.update_keys(["deezer:99"], ["yt:vid123"]) is False
    assert manager.update_keys(["nothing:here"], ["yt:other"]) is False


def test_remap_library_id_preserves_the_snapshot(manager):
    manager.toggle_entry({"keys": ["lib:old", "yt:vid"], "title": "Song", "artist": "A"})
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


def test_removing_by_library_id_drops_the_whole_entry(manager):
    manager.toggle_entry({"keys": ["lib:hash1", "yt:vid"], "title": "Song", "artist": "A"})
    manager.remove("hash1")

    assert manager.get_entries() == []
    assert not manager.is_favourite_keys(["yt:vid"])


def test_change_callbacks_fire_on_mutation(manager):
    calls = []
    manager.add_change_callback(lambda: calls.append(1))
    manager.add("t1")
    manager.toggle_entry({"keys": ["yt:vid"], "title": "S", "artist": "A"})
    manager.clear()

    assert len(calls) == 3
