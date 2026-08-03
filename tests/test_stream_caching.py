"""A downloaded track must be re-playable without re-downloading it.

The engine has always sent validators and answered a conditional request with a
304 in about a millisecond. What made downloaded music take seconds to start was
that the player asked under a URL nothing had ever seen — a fresh `attempt_id`
per play — so the browser had nothing to revalidate against and fetched the file
again, in full, every time. On a LAN that is invisible. Over a remote link it is
the difference between instant and a spinner.

These tests hold the server's half of that bargain. The client's half is in
`ui_web/src/lib/media.test.ts`.
"""

from __future__ import annotations

import pytest

from tests.conftest import TEST_USER_ID


@pytest.fixture
def client():
    from shared.api import app

    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


@pytest.fixture
def downloaded_track(tmp_path, monkeypatch):
    """One real file on disk, registered in the bound user's library."""
    from shared.api import get_user_core
    from shared.models import Track
    from shared.user_context import user_context

    tracks_dir = tmp_path / "tracks"
    tracks_dir.mkdir(parents=True)
    audio = tracks_dir / "cachetrack.mp3"
    audio.write_bytes(b"ID3" + b"\x00" * 4096)

    monkeypatch.setattr("shared.app_config.get_output_dir", lambda: str(tmp_path))
    monkeypatch.setattr("shared.security.is_safe_path", lambda *a, **k: True)

    track = Track(
        id="cachetrack",
        title="Cached",
        artist="Artist",
        album="Album",
        duration=180,
        file_hash="cachetrack",
        original_filename="cachetrack.mp3",
        compressed=False,
        file_size=audio.stat().st_size,
        bitrate=320,
        format="mp3",
    )
    with user_context(TEST_USER_ID):
        library = get_user_core(TEST_USER_ID).library
        if library.metadata and not library.metadata.get_track_by_id("cachetrack"):
            library.metadata.add_track(track)
    yield "cachetrack"
    with user_context(TEST_USER_ID):
        library = get_user_core(TEST_USER_ID).library
        if library.metadata:
            library.metadata.remove_track("cachetrack")


def test_a_stream_carries_something_to_revalidate_against(client, downloaded_track):
    response = client.get(f"/api/static/stream/{downloaded_track}")

    assert response.status_code == 200
    # Without a validator the browser has no way to ask "is what I already have
    # still good?", and every play is a full download whatever the URL says.
    assert response.headers.get("ETag") or response.headers.get("Last-Modified")
    assert response.headers.get("Accept-Ranges") == "bytes"


def test_a_downloaded_track_may_be_kept_by_the_browser(client, downloaded_track):
    """The bytes behind a track id never change, so asking again is waste.

    `send_file` defaults to `no-cache`, which sends the player back over the
    network for a file it already has on every play. A cached preview has always
    been allowed to skip that; a downloaded track was not, and from outside the
    house that is several round trips in front of a song that is on disk.
    """
    response = client.get(f"/api/static/stream/{downloaded_track}")
    cache_control = response.headers.get("Cache-Control", "")

    assert "no-cache" not in cache_control
    assert "no-store" not in cache_control
    assert "max-age=" in cache_control
    # Someone else's library is not for shared caches to hold.
    assert "private" in cache_control


def test_replaying_a_track_costs_a_304_and_no_bytes(client, downloaded_track):
    first = client.get(f"/api/static/stream/{downloaded_track}")
    etag = first.headers.get("ETag")
    assert etag

    again = client.get(
        f"/api/static/stream/{downloaded_track}", headers={"If-None-Match": etag}
    )

    assert again.status_code == 304
    assert again.get_data() == b""


def test_the_url_a_player_uses_is_the_same_one_it_used_before(client, downloaded_track):
    """A per-play query string is a cache miss by construction.

    Kept as a server-side statement of the same contract: whatever a client puts
    in the query, the response body is identical, so there is never a reason for
    the URL to vary between two plays of one track.
    """
    plain = client.get(f"/api/static/stream/{downloaded_track}")
    tagged = client.get(f"/api/static/stream/{downloaded_track}?attempt_id=abc123")

    assert plain.status_code == tagged.status_code == 200
    assert plain.get_data() == tagged.get_data()
    assert plain.headers.get("ETag") == tagged.headers.get("ETag")
