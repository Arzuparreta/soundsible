"""What happens to a playlist change when something else writes the library.

Every library write is a whole-library write: `replace_library` rewrites every
track, playlist and setting from one in-memory snapshot. That makes "which
snapshot was this applied to?" the only question that matters. Applied to a
stale one, an innocuous "add this song to that playlist" does not just risk
losing itself — it reverts whatever was committed in between, and the client is
told it all worked.

This is the failure these tests pin down: a song added to a playlist that never
appears, and playlist names that come back from weeks ago.
"""

import pytest

from player.library import LibraryManager
from shared.api import app as api_app
from shared.api import get_user_core, reset_user_cores
from shared.hardening import _rate_limiter
from shared.models import LibraryMetadata, Track
from shared.multiuser_migration import ensure_multiuser_layout
from shared.user_context import user_context


@pytest.fixture(autouse=True)
def _clear_rate_limits():
    _rate_limiter._events.clear()
    yield
    _rate_limiter._events.clear()


@pytest.fixture
def client():
    reset_user_cores()
    return api_app.test_client()


def _track(track_id: str) -> Track:
    return Track(
        id=track_id,
        title=f"Song {track_id}",
        artist="Extremoduro",
        album="Album",
        duration=255,
        file_hash=track_id,
        original_filename=f"{track_id}.m4a",
        file_size=10,
        bitrate=128,
        format="m4a",
    )


def _seed_library(user_id: str) -> None:
    """One account, two songs, and a playlist holding the first of them."""
    with user_context(user_id):
        library = get_user_core(user_id).library
        library.metadata = LibraryMetadata(
            version=1,
            tracks=[_track("tunnel"), _track("emparedado")],
            playlists={"Arma Reforger": ["tunnel"]},
            settings={},
        )
        assert library._save_metadata() is True


def _other_writer(user_id: str) -> LibraryManager:
    """A second manager over the same account — the other engine, the other tab.

    It loads the canonical library for itself, exactly like the process that
    has been running since before whatever the request is about to do.
    """
    with user_context(user_id):
        manager = LibraryManager(silent=True)
        manager.sync_library(silent=True)
        return manager


def test_adding_a_song_applies_to_the_library_as_it_is_now(client):
    """The reported bug: the song is added, and the playlist stays as it was.

    Somebody else renamed a playlist through a second writer. The request must
    build on that, not on the snapshot this process happened to be holding —
    otherwise the save that lands the song is the same save that undoes the
    rename, and the client is handed a library the engine will not serve.
    """
    user_id = ensure_multiuser_layout()["user_id"]
    _seed_library(user_id)
    # Warm the core's snapshot, then let another writer move the library on.
    with user_context(user_id):
        get_user_core(user_id).library.metadata.playlists  # noqa: B018 — loaded
    other = _other_writer(user_id)
    with user_context(user_id):
        assert other.metadata.rename_playlist("Arma Reforger", "Arma Reforger 2026") is True
        assert other._save_metadata() is True

    response = client.post(
        "/api/library/playlists/Arma%20Reforger%202026/tracks",
        json={"track_id": "emparedado"},
    )

    assert response.status_code == 200, response.get_json()
    playlists = response.get_json()["playlists"]
    assert playlists == {"Arma Reforger 2026": ["tunnel", "emparedado"]}
    # And the library the next sync fetches says the same thing. This is the
    # part the user sees: the song stays in the list instead of vanishing.
    assert client.get("/api/library").get_json()["playlists"] == playlists


def test_a_stale_writer_cannot_take_the_song_back_out(client):
    """The other half: a snapshot from before the add may not be committed.

    The write is refused rather than applied, so the playlist keeps the song
    and the stale writer is told its change did not land.
    """
    user_id = ensure_multiuser_layout()["user_id"]
    _seed_library(user_id)
    stale = _other_writer(user_id)

    response = client.post(
        "/api/library/playlists/Arma%20Reforger/tracks",
        json={"track_id": "emparedado"},
    )
    assert response.status_code == 200, response.get_json()

    with user_context(user_id):
        stale.metadata.create_playlist("Halo")
        assert stale._save_metadata() is False

    assert client.get("/api/library").get_json()["playlists"] == {
        "Arma Reforger": ["tunnel", "emparedado"]
    }


def test_a_refused_playlist_write_is_reported_as_a_conflict(client, monkeypatch):
    """A save that did not happen must not answer with the map it would have
    written. Echoing it back is what makes the change look applied until the
    next sync silently takes it away again."""
    user_id = ensure_multiuser_layout()["user_id"]
    _seed_library(user_id)

    with user_context(user_id):
        library = get_user_core(user_id).library
    monkeypatch.setattr(library, "_save_metadata", lambda **kwargs: False)
    library.last_save_error = "library_conflict"

    response = client.post(
        "/api/library/playlists/Arma%20Reforger/tracks",
        json={"track_id": "emparedado"},
    )

    assert response.status_code == 409
    assert response.get_json()["code"] == "library_conflict"


def test_captured_track_edit_rejects_a_newer_membership_without_losing_it(client):
    user_id = ensure_multiuser_layout()["user_id"]
    _seed_library(user_id)
    assert client.post("/api/library/playlists/Arma%20Reforger/tracks", json={"track_id": "emparedado"}).status_code == 200
    stale = {"expected_track_ids": ["tunnel"], "track_ids": []}
    assert client.patch("/api/library/playlists/Arma%20Reforger", json=stale).status_code == 409
    assert client.delete("/api/library/playlists/Arma%20Reforger", json=stale).status_code == 409
    assert client.get("/api/library").get_json()["playlists"]["Arma Reforger"] == ["tunnel", "emparedado"]


def test_reorder_cannot_drop_a_new_playlist_and_explicit_order_survives_json(client):
    user_id = ensure_multiuser_layout()["user_id"]
    _seed_library(user_id)
    assert client.post("/api/library/playlists", json={"name": "Second"}).status_code == 200
    assert client.patch("/api/library/playlists", json={"expected_order": ["Arma Reforger"], "order": ["Arma Reforger"]}).status_code == 409
    assert client.patch("/api/library/playlists", json={"expected_order": ["Arma Reforger", "Second"], "order": ["Second"]}).status_code == 400
    response = client.patch("/api/library/playlists", json={"expected_order": ["Arma Reforger", "Second"], "order": ["Second", "Arma Reforger"]})
    assert response.status_code == 200
    assert response.get_json()["settings"]["playlist_order"] == ["Second", "Arma Reforger"]
    assert client.patch("/api/library/playlists/Second", json={"name": "Renamed", "expected_track_ids": []}).status_code == 200
    assert client.get("/api/library").get_json()["settings"]["playlist_order"] == ["Renamed", "Arma Reforger"]
    assert client.delete("/api/library/playlists/Renamed", json={"expected_track_ids": []}).status_code == 200
    assert client.get("/api/library").get_json()["settings"]["playlist_order"] == ["Arma Reforger"]


def test_invalid_combined_edit_does_not_partly_rename_shared_metadata(client):
    user_id = ensure_multiuser_layout()["user_id"]
    _seed_library(user_id)
    response = client.patch("/api/library/playlists/Arma%20Reforger", json={"name": "Incorrect", "track_ids": "bad"})
    assert response.status_code == 400
    assert client.get("/api/library").get_json()["playlists"] == {"Arma Reforger": ["tunnel"]}


def test_new_edit_routes_require_preconditions_and_do_not_mutate_without_them(client):
    user_id = ensure_multiuser_layout()["user_id"]
    _seed_library(user_id)
    assert client.patch("/api/library/playlist-edits", json={"order": []}).status_code == 400
    assert client.patch("/api/library/playlist-edits/Arma%20Reforger", json={"name": "Unsafe"}).status_code == 400
    assert client.delete("/api/library/playlist-edits/Arma%20Reforger").status_code == 400
    assert client.get("/api/library").get_json()["playlists"] == {"Arma Reforger": ["tunnel"]}
    reply = client.patch("/api/library/playlist-edits/Arma%20Reforger", json={"expected_track_ids": ["tunnel"], "track_ids": []})
    assert reply.status_code == 200
    assert reply.get_json()["playlists"]["Arma Reforger"] == []
