"""Connections, the queue, and delivery — with the services themselves scripted."""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from shared.scrobble import LASTFM, LISTENBRAINZ, MALOJA, ScrobbleError
from shared.scrobble import service as service_module
from shared.scrobble.clients import Outcome, Reply
from shared.scrobble.listen import Listen
from shared.scrobble.service import ScrobbleService, lastfm_app
from shared.scrobble.store import STORE_FILENAME, ScrobbleStore, users_with_store
from shared.user_context import user_config_dir

from tests.conftest import TEST_USER_ID as USER

NOW = 1_700_000_000.0


def song(number: int = 1) -> Listen:
    return Listen(artist="Artist", title=f"Song {number}", duration=200, started_at=int(NOW) + number)


class Remote:
    """One scripted service: what it was sent, and what it answers next."""

    def __init__(self) -> None:
        self.submitted: list[list[Listen]] = []
        self.now_playing: list[Listen] = []
        self.replies: list[Reply] = []
        self.validation = Reply(Outcome.OK, data={"username": "ana"})
        self.built: list[tuple[Any, ...]] = []

    def answer(self) -> Reply:
        return self.replies.pop(0) if self.replies else Reply(Outcome.OK)

    @property
    def titles(self) -> list[list[str]]:
        return [[listen.title for listen in batch] for batch in self.submitted]


@pytest.fixture
def remotes(monkeypatch):
    """Replace both wire clients with scripted ones; keyed by service."""
    scripted = {LISTENBRAINZ: Remote(), MALOJA: Remote(), LASTFM: Remote()}

    class FakeListenBrainz:
        def __init__(self, token, server="", *, maloja=False):
            self.remote = scripted[MALOJA if maloja else LISTENBRAINZ]
            self.remote.built.append((token, server))
            self.batch_size = 1 if maloja else 3

        def validate(self):
            return self.remote.validation

        def now_playing(self, listen):
            self.remote.now_playing.append(listen)
            return self.remote.answer()

        def submit(self, listens):
            self.remote.submitted.append(list(listens))
            return self.remote.answer()

    class FakeLastFm:
        batch_size = 2

        def __init__(self, api_key, api_secret, session_key=""):
            self.remote = scripted[LASTFM]
            self.remote.built.append((api_key, api_secret, session_key))

        def request_token(self):
            reply = self.remote.validation
            return Reply(Outcome.OK, data={"token": "tok-1"}) if reply.ok else reply

        def authorize_url(self, token):
            return f"https://www.last.fm/api/auth/?token={token}"

        def open_session(self, token):
            return self.remote.answer()

        def now_playing(self, listen):
            self.remote.now_playing.append(listen)
            return Reply(Outcome.OK)

        def submit(self, listens):
            self.remote.submitted.append(list(listens))
            return self.remote.answer()

    monkeypatch.setattr(service_module, "ListenBrainzClient", FakeListenBrainz)
    monkeypatch.setattr(service_module, "LastFmClient", FakeLastFm)
    return scripted


@pytest.fixture
def service():
    return ScrobbleService()


def connected(service: ScrobbleService) -> ScrobbleService:
    service.connect_listenbrainz(USER, "lb-token", admin=False)
    return service


def row(name: str = LISTENBRAINZ) -> dict[str, Any]:
    return ScrobbleStore(USER).connections()[name]


# ---------------------------------------------------------------------------
# Connecting
# ---------------------------------------------------------------------------


def test_nothing_is_stored_or_observed_until_a_service_is_connected(service, remotes):
    assert service.is_active(USER) is False
    service.observe(USER, {"device_id": "phone", "track_id": "t1", "position_sec": 0, "is_playing": True})
    service.play(USER, song())
    assert not (user_config_dir(USER) / STORE_FILENAME).exists()
    assert users_with_store() == []
    assert service.status(USER, admin=False)["services"][0] == {"service": LISTENBRAINZ, "connected": False}


def test_connecting_listenbrainz_checks_the_token_and_stores_it_encrypted(service, remotes):
    connected(service)
    entry = service.status(USER, admin=False)["services"][0]
    assert entry == {
        "service": LISTENBRAINZ, "connected": True, "enabled": True, "username": "ana", "server": "",
        "state": "ok", "pending": 0, "last_sent_at": None, "error": "",
    }
    with sqlite3.connect(user_config_dir(USER) / STORE_FILENAME) as conn:
        (stored,) = conn.execute("SELECT secret_enc FROM connections").fetchone()
    assert "lb-token" not in stored
    assert service.is_active(USER) is True
    assert users_with_store() == [USER]


def test_a_token_the_service_refuses_is_not_stored(service, remotes):
    remotes[LISTENBRAINZ].validation = Reply(Outcome.UNAUTHORIZED, "token_rejected")
    with pytest.raises(ScrobbleError) as error:
        service.connect_listenbrainz(USER, "bad", admin=False)
    assert error.value.code == "token_rejected"
    assert ScrobbleStore(USER).connections() == {}

    remotes[LISTENBRAINZ].validation = Reply(Outcome.RETRY, "unreachable:ConnectionError")
    with pytest.raises(ScrobbleError) as error:
        service.connect_listenbrainz(USER, "tok", admin=False)
    assert (error.value.code, error.value.status) == ("unreachable", 502)

    for blank in ("", "   ", "two words", None):
        with pytest.raises(ScrobbleError) as error:
            service.connect_listenbrainz(USER, blank, admin=False)
        assert error.value.code == "token_required"


def test_only_an_admin_may_point_the_engine_at_a_server_of_their_choosing(service, remotes):
    with pytest.raises(ScrobbleError) as error:
        service.connect_listenbrainz(USER, "tok", "http://192.168.1.9:8100", admin=False)
    assert (error.value.code, error.value.status) == ("custom_server_forbidden", 403)
    with pytest.raises(ScrobbleError) as error:
        service.connect_maloja(USER, "http://maloja.lan:42010", "key", admin=False)
    assert error.value.status == 403
    assert remotes[LISTENBRAINZ].built == [] and remotes[MALOJA].built == []

    service.connect_listenbrainz(USER, "tok", "http://192.168.1.9:8100/", admin=True)
    service.connect_maloja(USER, "maloja.lan:42010", "key", admin=True)
    assert row(LISTENBRAINZ)["server"] == "http://192.168.1.9:8100"
    assert row(MALOJA)["server"] == "https://maloja.lan:42010"
    # ListenBrainz's own address is the default, not a custom server.
    service.connect_listenbrainz(USER, "tok", "https://api.listenbrainz.org/", admin=False)
    assert row(LISTENBRAINZ)["server"] == ""

    with pytest.raises(ScrobbleError) as error:
        service.connect_maloja(USER, "not a url", "key", admin=True)
    assert error.value.code == "server_invalid"


# ---------------------------------------------------------------------------
# Last.fm
# ---------------------------------------------------------------------------


def test_lastfm_needs_an_api_account_first(service, remotes):
    assert lastfm_app() is None
    assert service.status(USER, admin=True)["lastfm_app"] == {"configured": False, "from_environment": False}
    assert "lastfm_app" not in service.status(USER, admin=False)
    with pytest.raises(ScrobbleError) as error:
        service.lastfm_authorize(USER)
    assert error.value.code == "lastfm_unavailable"


def test_the_api_account_is_checked_stored_encrypted_and_removable(service, remotes):
    remotes[LASTFM].validation = Reply(Outcome.RETRY, "api_key_rejected")
    with pytest.raises(ScrobbleError) as error:
        service.set_lastfm_app("key", "wrong")
    assert (error.value.code, error.value.status) == ("api_key_rejected", 400)
    assert lastfm_app() is None

    remotes[LASTFM].validation = Reply(Outcome.OK)
    service.set_lastfm_app("key", "s3cr3t-value")
    app = lastfm_app()
    assert (app.api_key, app.api_secret, app.from_environment) == ("key", "s3cr3t-value", False)
    assert "s3cr3t-value" not in service_module._lastfm_app_path().read_text()
    service.clear_lastfm_app()
    assert lastfm_app() is None


def test_an_api_account_from_the_environment_wins_and_cannot_be_edited(service, remotes, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LASTFM_API_KEY", "env-key")
    monkeypatch.setenv("SOUNDSIBLE_LASTFM_API_SECRET", "env-secret")
    assert lastfm_app() == ("env-key", "env-secret", True)
    assert service.status(USER, admin=True)["lastfm_app"] == {"configured": True, "from_environment": True}
    for change in (lambda: service.set_lastfm_app("a", "b"), service.clear_lastfm_app):
        with pytest.raises(ScrobbleError) as error:
            change()
        assert error.value.code == "lastfm_app_from_environment"


def test_connecting_lastfm_is_two_steps_with_the_browser_in_between(service, remotes):
    service.set_lastfm_app("key", "secret")
    with pytest.raises(ScrobbleError) as error:
        service.lastfm_complete(USER)
    assert error.value.code == "lastfm_not_started"

    assert service.lastfm_authorize(USER) == "https://www.last.fm/api/auth/?token=tok-1"
    lastfm = next(entry for entry in service.status(USER, admin=False)["services"] if entry["service"] == LASTFM)
    assert lastfm == {"service": LASTFM, "connected": False, "available": True, "authorizing": True}

    # Not allowed yet: the same token can be tried again.
    remotes[LASTFM].replies.append(Reply(Outcome.REJECTED, "lastfm_14", data={"code": 14}))
    with pytest.raises(ScrobbleError) as error:
        service.lastfm_complete(USER)
    assert error.value.code == "lastfm_not_authorized"

    remotes[LASTFM].replies.append(Reply(Outcome.OK, data={"username": "ana_fm", "session_key": "sk-1"}))
    service.lastfm_complete(USER)
    assert row(LASTFM)["username"] == "ana_fm"
    lastfm = next(entry for entry in service.status(USER, admin=False)["services"] if entry["service"] == LASTFM)
    assert lastfm["connected"] and not lastfm["authorizing"]

    service.play(USER, song())
    service.deliver_due(NOW)
    assert remotes[LASTFM].built[-1] == ("key", "secret", "sk-1")
    assert remotes[LASTFM].titles == [["Song 1"]]


def test_an_expired_lastfm_token_starts_the_flow_over(service, remotes):
    service.set_lastfm_app("key", "secret")
    service.lastfm_authorize(USER)
    remotes[LASTFM].replies.append(Reply(Outcome.REJECTED, "lastfm_15", data={"code": 15}))
    with pytest.raises(ScrobbleError) as error:
        service.lastfm_complete(USER)
    assert error.value.code == "lastfm_expired"
    with pytest.raises(ScrobbleError) as error:
        service.lastfm_complete(USER)
    assert error.value.code == "lastfm_not_started"


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------


def test_a_play_goes_to_every_connected_service_in_order(service, remotes):
    connected(service)
    service.connect_maloja(USER, "http://maloja.lan:42010", "key", admin=True)
    for number in (1, 2, 3, 4):
        service.play(USER, song(number))
    assert row()["pending"] == 4

    assert service.deliver_due(NOW) == service_module.IDLE_SECONDS
    assert remotes[LISTENBRAINZ].titles == [["Song 1", "Song 2", "Song 3"], ["Song 4"]]
    assert remotes[MALOJA].titles == [["Song 1"], ["Song 2"], ["Song 3"], ["Song 4"]]
    assert row()["pending"] == 0 and row()["last_sent_at"] == int(NOW)
    # Nothing left: the next pass sends nothing.
    service.deliver_due(NOW + 1)
    assert len(remotes[LISTENBRAINZ].submitted) == 2


def test_a_service_that_is_down_keeps_its_plays_and_is_retried_with_backoff(service, remotes):
    connected(service)
    service.play(USER, song())
    remotes[LISTENBRAINZ].replies += [Reply(Outcome.RETRY, "http_503"), Reply(Outcome.RETRY, "http_503")]

    assert service.deliver_due(NOW) == 30
    assert (row()["pending"], row()["failures"], row()["retry_at"], row()["last_error"]) == (1, 1, int(NOW) + 30, "http_503")
    assert service.status(USER, admin=False)["services"][0]["state"] == "retrying"
    # Not yet due: nothing is sent, and the wait is what is left of the back-off.
    assert service.deliver_due(NOW + 10) == 20
    assert len(remotes[LISTENBRAINZ].submitted) == 1
    # Second failure doubles the wait.
    assert service.deliver_due(NOW + 30) == 60
    assert service.deliver_due(NOW + 90) == service_module.IDLE_SECONDS
    assert (row()["pending"], row()["failures"], row()["last_error"]) == (0, 0, "")


def test_a_service_can_say_how_long_to_wait_and_retry_now_skips_the_wait(service, remotes):
    connected(service)
    service.play(USER, song())
    remotes[LISTENBRAINZ].replies.append(Reply(Outcome.RETRY, "rate_limited", retry_after=7))
    assert service.deliver_due(NOW) == 7
    service.retry_now(USER, LISTENBRAINZ)
    service.deliver_due(NOW + 1)
    assert row()["pending"] == 0


def test_a_revoked_token_stops_delivery_and_keeps_the_queue_until_reconnected(service, remotes):
    connected(service)
    service.play(USER, song(1))
    remotes[LISTENBRAINZ].replies.append(Reply(Outcome.UNAUTHORIZED, "token_rejected"))
    service.deliver_due(NOW)
    assert service.status(USER, admin=False)["services"][0]["state"] == "reconnect"

    service.play(USER, song(2))  # still listening while disconnected from the service
    service.deliver_due(NOW + 60)
    assert len(remotes[LISTENBRAINZ].submitted) == 1
    assert row()["pending"] == 2

    service.connect_listenbrainz(USER, "new-token", admin=False)
    service.deliver_due(NOW + 120)
    assert remotes[LISTENBRAINZ].titles[-1] == ["Song 1", "Song 2"]
    assert remotes[LISTENBRAINZ].built[-1] == ("new-token", "")


def test_one_play_a_service_refuses_does_not_take_the_rest_with_it(service, remotes):
    connected(service)
    for number in (1, 2, 3):
        service.play(USER, song(number))
    remotes[LISTENBRAINZ].replies += [
        Reply(Outcome.REJECTED, "http_400"),  # the batch of three
        Reply(Outcome.OK),  # Song 1 alone
        Reply(Outcome.REJECTED, "http_400"),  # Song 2 alone: this is the one
        Reply(Outcome.OK),  # Song 3 alone
    ]
    service.deliver_due(NOW)
    assert remotes[LISTENBRAINZ].titles == [["Song 1", "Song 2", "Song 3"], ["Song 1"], ["Song 2"], ["Song 3"]]
    assert row()["pending"] == 0


def test_a_paused_service_gets_nothing_and_a_disconnected_one_forgets_its_queue(service, remotes):
    connected(service)
    service.play(USER, song(1))
    service.set_enabled(USER, LISTENBRAINZ, False)
    assert service.is_active(USER) is False
    service.play(USER, song(2))  # not recorded for a paused service
    service.deliver_due(NOW)
    assert remotes[LISTENBRAINZ].submitted == []
    assert row()["pending"] == 1

    service.set_enabled(USER, LISTENBRAINZ, True)
    service.deliver_due(NOW)
    assert remotes[LISTENBRAINZ].titles == [["Song 1"]]

    service.play(USER, song(3))
    service.disconnect(USER, LISTENBRAINZ)
    assert ScrobbleStore(USER).connections() == {}
    assert service.is_active(USER) is False
    service.connect_listenbrainz(USER, "tok", admin=False)
    assert row()["pending"] == 0


def test_the_queue_is_bounded(service, remotes, monkeypatch):
    from shared.scrobble import store

    monkeypatch.setattr(store, "MAX_QUEUED", 3)
    connected(service)
    for number in range(1, 6):
        service.play(USER, song(number))
    assert [listen.title for _, listen in ScrobbleStore(USER).batch(LISTENBRAINZ, 10)] == ["Song 3", "Song 4", "Song 5"]


def test_plays_left_by_a_stopped_engine_are_sent_by_the_next_one(service, remotes):
    connected(service)
    service.play(USER, song())
    restarted = ScrobbleService()
    assert restarted.deliver_due(NOW) == service_module.IDLE_SECONDS
    assert remotes[LISTENBRAINZ].submitted == []  # a pass on its own knows of nobody
    assert restarted.start() is True
    try:
        for _ in range(200):
            if remotes[LISTENBRAINZ].submitted:
                break
            restarted._wake.wait(0.01)
        assert remotes[LISTENBRAINZ].titles == [["Song 1"]]
        assert restarted.start() is False
    finally:
        restarted.stop()


def test_a_token_that_can_no_longer_be_decrypted_asks_to_reconnect(service, remotes):
    from shared.keyfile import reset_key_cache
    from shared.runtime import get_config_dir

    connected(service)
    service.play(USER, song())
    (get_config_dir() / "scrobble.key").unlink()
    reset_key_cache()
    service.deliver_due(NOW)
    assert (row()["needs_reconnect"], row()["last_error"], row()["pending"]) == (1, "token_unreadable", 1)


# ---------------------------------------------------------------------------
# From playback state to the queue
# ---------------------------------------------------------------------------


def _publish(service, monkeypatch, at: float, **state) -> None:
    monkeypatch.setattr(service_module.time, "time", lambda: NOW + at)
    service.observe(USER, {"device_id": "phone", "is_playing": True, **state})


def test_published_playback_becomes_now_playing_and_then_a_queued_play(service, remotes, monkeypatch):
    connected(service)
    track = {"id": "yt-1", "title": "Salir", "artist": "Extremoduro", "album": "Agíla", "duration": 240, "source": "preview"}
    _publish(service, monkeypatch, 0, track_id="yt-1", track=track, position_sec=0)
    service.deliver_due(NOW)
    assert [listen.title for listen in remotes[LISTENBRAINZ].now_playing] == ["Salir"]

    for tick in range(1, 9):
        _publish(service, monkeypatch, tick * 15, track_id="yt-1", track=track, position_sec=tick * 15)
    service.deliver_due(NOW + 121)
    (batch,) = remotes[LISTENBRAINZ].submitted
    assert (batch[0].artist, batch[0].title, batch[0].album, batch[0].started_at) == ("Extremoduro", "Salir", "Agíla", int(NOW))


def test_the_library_record_is_used_over_what_the_client_published(service, remotes, monkeypatch):
    from shared.database import user_db
    from shared.models import LibraryMetadata
    from tests.subsonic_support import track as make_track

    library = make_track("t1", title="Proper Title", artist="Proper Artist", album="Record", duration=180)
    user_db(USER).sync_from_metadata(LibraryMetadata(version=1, tracks=[library], playlists={}, settings={}))
    connected(service)
    # The iOS client publishes an id and nothing else.
    _publish(service, monkeypatch, 0, track_id="t1", position_sec=0)
    for tick in range(1, 7):
        _publish(service, monkeypatch, tick * 15, track_id="t1", position_sec=tick * 15)
    service.deliver_due(NOW + 91)
    (batch,) = remotes[LISTENBRAINZ].submitted
    assert (batch[0].artist, batch[0].title, batch[0].duration) == ("Proper Artist", "Proper Title", 180)


def test_podcasts_and_unknown_tracks_are_not_scrobbled(service, remotes, monkeypatch):
    connected(service)
    episode = {"id": "ep", "title": "Episode", "artist": "Show", "duration": 240, "media_kind": "podcast_episode"}
    for tick in range(0, 20):
        _publish(service, monkeypatch, tick * 15, track_id="ep", track=episode, position_sec=tick * 15)
    for tick in range(20, 40):
        _publish(service, monkeypatch, tick * 15, track_id="mystery", position_sec=(tick - 20) * 15)
    service.deliver_due(NOW + 700)
    assert remotes[LISTENBRAINZ].submitted == [] and remotes[LISTENBRAINZ].now_playing == []


def test_a_malformed_publication_is_ignored(service, remotes):
    connected(service)
    service.observe(USER, {"track_id": "t1", "is_playing": True})  # no device
    service.observe(USER, {"device_id": "phone", "track_id": "t1", "position_sec": "soon", "is_playing": True})
    service.observe(USER, {"device_id": "phone", "track": "not a dict", "is_playing": True})
    assert row()["pending"] == 0
