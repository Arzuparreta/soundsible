"""Downloading a song you had already hearted must promote the same entry.

Favouriting from a search row saves a bare ``yt:<video id>`` entry, because at
that moment that is the only identity the song has. The library view and the
favourites view both read ``lib:`` keys, so until the download hands the entry
that key the song is present in the library, present in favourites.json, and
invisible in both.
"""

import pytest

from player.favourites_manager import library_key
from shared.models import Track
from tests.conftest import TEST_USER_ID


@pytest.fixture
def api(monkeypatch):
    import shared.api as api_mod

    # The real one defers a manifest write onto a worker thread; the assertions
    # here are about favourites, and a synchronous commit keeps the test honest
    # about ordering rather than about timing.
    monkeypatch.setattr(
        api_mod.orchestrator,
        "schedule_metadata_commit",
        lambda save, after=None: (save(), after and after()),
    )
    monkeypatch.setattr(api_mod, "emit_to_user", lambda *a, **k: None)
    return api_mod


def _track(track_id: str, video_id: str | None = None) -> Track:
    return Track(
        id=track_id,
        title="I Follow Rivers",
        artist="Lykke Li",
        album="Wounded Rhymes",
        duration=284,
        file_hash=track_id,
        original_filename=f"{track_id}.m4a",
        compressed=False,
        file_size=1024,
        bitrate=320,
        format="m4a",
        youtube_id=video_id,
    )


def test_downloading_a_hearted_song_gives_its_entry_the_library_key(api):
    manager = api.get_favourites_manager(TEST_USER_ID)
    manager.set_favourite({"keys": ["yt:K3JGxj2rvAs"], "title": "I Follow Rivers"})

    assert manager.get_all() == [], "a song with no file yet owns no library id"

    assert api.add_tracks_to_user_library([_track("hash-1", "K3JGxj2rvAs")]) == 1

    assert manager.get_all() == ["hash-1"], "the favourites view lists lib: keys"
    entries = [e for e in manager.get_entries() if "yt:K3JGxj2rvAs" in e["keys"]]
    assert len(entries) == 1, "the entry is widened, never duplicated"
    assert library_key("hash-1") in entries[0]["keys"]
    assert entries[0]["title"] == "I Follow Rivers", "the snapshot survives promotion"


def test_downloading_a_saved_song_keeps_the_day_it_was_saved(api):
    """Downloading gives a song a file, not a place in the library — it has had
    one since it was saved. Dating it "now" would push a song you have owned for
    weeks to the top of "recently added", and would do it again for every song
    you ever get round to downloading."""
    manager = api.get_favourites_manager(TEST_USER_ID)
    manager.toggle_saved(
        {"keys": ["yt:K3JGxj2rvAs"], "title": "I Follow Rivers", "added_at": "2026-07-02T10:00:00"}
    )

    api.add_tracks_to_user_library([_track("hash-6", "K3JGxj2rvAs")])

    library = api.get_user_core(TEST_USER_ID).library
    stored = library.metadata.get_track_by_id("hash-6")
    assert stored.added_at == "2026-07-02T10:00:00"


def test_a_song_downloaded_without_ever_being_saved_is_dated_now(api):
    api.add_tracks_to_user_library([_track("hash-7", "K3JGxj2rvAs")])

    library = api.get_user_core(TEST_USER_ID).library
    assert library.metadata.get_track_by_id("hash-7").added_at


def test_promotion_leaves_unrelated_favourites_alone(api):
    manager = api.get_favourites_manager(TEST_USER_ID)
    manager.set_favourite({"keys": ["yt:other-video"], "title": "Something else"})

    api.add_tracks_to_user_library([_track("hash-2", "K3JGxj2rvAs")])

    entry = [e for e in manager.get_entries() if "yt:other-video" in e["keys"]][0]
    assert entry["keys"] == ["yt:other-video"]
    assert manager.get_all() == []


def test_a_track_without_a_video_id_promotes_nothing(api):
    manager = api.get_favourites_manager(TEST_USER_ID)
    manager.set_favourite({"keys": ["yt:K3JGxj2rvAs"]})

    api.add_tracks_to_user_library([_track("hash-3", None)])

    assert manager.get_all() == []


def test_a_song_downloaded_before_it_was_hearted_still_works(api):
    """The other order: the file arrives first, the heart later."""
    manager = api.get_favourites_manager(TEST_USER_ID)

    api.add_tracks_to_user_library([_track("hash-4", "K3JGxj2rvAs")])
    manager.add("hash-4")

    assert manager.get_all() == ["hash-4"]


def test_re_adding_an_already_owned_track_does_not_duplicate_keys(api):
    manager = api.get_favourites_manager(TEST_USER_ID)
    manager.set_favourite({"keys": ["yt:K3JGxj2rvAs"]})

    api.add_tracks_to_user_library([_track("hash-5", "K3JGxj2rvAs")])
    api.add_tracks_to_user_library([_track("hash-5", "K3JGxj2rvAs")])

    entry = [e for e in manager.get_entries() if "yt:K3JGxj2rvAs" in e["keys"]][0]
    assert entry["keys"].count(library_key("hash-5")) == 1
