"""The HTTP surface of scrobbling, and the two places plays enter it from."""

from __future__ import annotations

import pytest

from shared.hardening import _reset_rate_limits_for_tests
from shared.scrobble import LISTENBRAINZ, get_scrobble_service
from shared.scrobble import service as service_module
from shared.scrobble.clients import Outcome, Reply
from shared.scrobble.store import ScrobbleStore
from shared.users import ROLE_ADMIN, ROLE_MEMBER, create_user

from tests.conftest import TEST_USER_ID


class FakeListenBrainz:
    """Accepts every token except ``bad``; remembers what it was sent."""

    built: list[tuple[str, str, bool]] = []
    submitted: list[list] = []
    announced: list = []
    batch_size = 50

    def __init__(self, token, server="", *, maloja=False):
        self.token = token
        FakeListenBrainz.built.append((token, server, maloja))

    def validate(self):
        if self.token == "bad":
            return Reply(Outcome.UNAUTHORIZED, "token_rejected")
        return Reply(Outcome.OK, data={"username": "ana"})

    def now_playing(self, listen):
        FakeListenBrainz.announced.append(listen)
        return Reply(Outcome.OK)

    def submit(self, listens):
        FakeListenBrainz.submitted.append(list(listens))
        return Reply(Outcome.OK)


@pytest.fixture(autouse=True)
def remote(monkeypatch):
    _reset_rate_limits_for_tests()
    FakeListenBrainz.built, FakeListenBrainz.submitted, FakeListenBrainz.announced = [], [], []
    monkeypatch.setattr(service_module, "ListenBrainzClient", FakeListenBrainz)
    return FakeListenBrainz


@pytest.fixture
def client():
    from shared.api import app

    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


def _entry(body: dict, service: str = LISTENBRAINZ) -> dict:
    return next(entry for entry in body["services"] if entry["service"] == service)


def test_status_lists_every_service_and_starts_disconnected(client):
    body = client.get("/api/scrobble").get_json()
    assert [entry["service"] for entry in body["services"]] == ["listenbrainz", "lastfm", "maloja"]
    assert all(entry["connected"] is False for entry in body["services"])
    assert _entry(body, "lastfm")["available"] is False


def test_connect_pause_and_disconnect_over_http(client):
    response = client.put("/api/scrobble/listenbrainz", json={"token": "lb-token"})
    assert response.status_code == 200
    entry = _entry(response.get_json())
    assert (entry["connected"], entry["enabled"], entry["username"]) == (True, True, "ana")
    # The token went in; it never comes back out.
    assert "lb-token" not in response.get_data(as_text=True)
    assert "lb-token" not in client.get("/api/scrobble").get_data(as_text=True)

    paused = client.patch("/api/scrobble/listenbrainz", json={"enabled": False})
    assert _entry(paused.get_json())["enabled"] is False
    assert client.patch("/api/scrobble/listenbrainz", json={"enabled": "no"}).status_code == 400

    assert client.post("/api/scrobble/listenbrainz/retry").status_code == 200
    gone = client.delete("/api/scrobble/listenbrainz")
    assert _entry(gone.get_json())["connected"] is False


def test_refusals_carry_a_code_the_player_can_translate(client):
    response = client.put("/api/scrobble/listenbrainz", json={"token": "bad"})
    assert (response.status_code, response.get_json()) == (400, {"error": "token_rejected"})
    assert client.put("/api/scrobble/listenbrainz", json={}).get_json() == {"error": "token_required"}
    assert client.put("/api/scrobble/maloja", json={"server": "nope nope", "token": "k"}).get_json() == {"error": "server_invalid"}
    assert client.post("/api/scrobble/lastfm/authorize").get_json() == {"error": "lastfm_unavailable"}
    assert client.post("/api/scrobble/lastfm/complete").get_json() == {"error": "lastfm_not_started"}
    for method in (client.patch, client.delete):
        assert method("/api/scrobble/spotify", json={"enabled": True}).status_code == 404
    assert client.post("/api/scrobble/spotify/retry").status_code == 404


def test_a_member_cannot_choose_the_server_or_set_the_lastfm_account(client, remote):
    create_user("owner", password="owner-password", role=ROLE_ADMIN)
    create_user("ana", password="ana-password", role=ROLE_MEMBER)
    assert client.post("/api/auth/login", json={"username": "ana", "password": "ana-password"}).status_code == 200

    status = client.get("/api/scrobble").get_json()
    assert status["custom_servers"] is False and "lastfm_app" not in status

    custom = client.put("/api/scrobble/listenbrainz", json={"token": "t", "server": "http://10.0.0.5:8100"})
    assert (custom.status_code, custom.get_json()) == (403, {"error": "custom_server_forbidden"})
    assert client.put("/api/scrobble/maloja", json={"server": "http://10.0.0.5", "token": "k"}).status_code == 403
    assert remote.built == []  # nothing was sent anywhere
    assert client.put("/api/scrobble/lastfm/app", json={"api_key": "k", "api_secret": "s"}).status_code in (401, 403)
    assert client.delete("/api/scrobble/lastfm/app").status_code in (401, 403)
    # Their own ListenBrainz account is theirs to connect.
    assert client.put("/api/scrobble/listenbrainz", json={"token": "t"}).status_code == 200


def test_one_account_never_sees_or_sends_for_another(client):
    create_user("owner", password="owner-password", role=ROLE_ADMIN)
    ana = create_user("ana", password="ana-password", role=ROLE_MEMBER)
    client.post("/api/auth/login", json={"username": "owner", "password": "owner-password"})
    client.put("/api/scrobble/listenbrainz", json={"token": "owner-token"})
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "ana", "password": "ana-password"})
    assert _entry(client.get("/api/scrobble").get_json())["connected"] is False
    assert ScrobbleStore(ana["id"]).connections() == {}


def test_publishing_playback_state_scrobbles_and_never_breaks_the_publication(client, remote, monkeypatch):
    client.put("/api/scrobble/listenbrainz", json={"token": "lb-token"})
    track = {"id": "yt-1", "title": "Salir", "artist": "Extremoduro", "duration": 100, "source": "preview"}
    clock = [1_700_000_000.0]
    monkeypatch.setattr(service_module.time, "time", lambda: clock[0])

    def publish(position: float, **extra):
        body = {"device_id": "phone", "track_id": "yt-1", "track": track, "position_sec": position, "is_playing": True, **extra}
        assert client.put("/api/playback/state", json=body).status_code == 200

    publish(0)
    for tick in range(1, 5):
        clock[0] += 15
        publish(tick * 15)
    service = get_scrobble_service()
    service.deliver_due(clock[0])
    assert [listen.title for listen in remote.announced] == ["Salir"]
    assert [[listen.title for listen in batch] for batch in remote.submitted] == [["Salir"]]
    assert remote.submitted[0][0].started_at == 1_700_000_000

    # A scrobbling failure is logged, not returned to the device.
    monkeypatch.setattr(service, "observe", lambda *args: (_ for _ in ()).throw(RuntimeError("boom")))
    publish(75)


def test_a_handoff_written_by_the_server_is_not_listening(client, remote, monkeypatch):
    """The state a handoff stores for the target device is an instruction, not a publication."""
    from shared.playback_state import put_state

    client.put("/api/scrobble/listenbrainz", json={"token": "lb-token"})
    put_state(TEST_USER_ID, {"device_id": "desktop", "track_id": "yt-1", "position_sec": 0, "is_playing": True})
    assert get_scrobble_service()._observer._sessions == {}


def test_an_opensubsonic_scrobble_is_passed_on(tmp_path, monkeypatch, remote):
    from shared.user_context import user_context
    from tests.subsonic_support import build, track

    harness = build(tmp_path, monkeypatch, [track("t1", title="Salir", artist="Extremoduro", album="Agíla", duration=242)])
    user_id = harness.user["id"]
    service = get_scrobble_service()

    # Not connected: the local play count moves and nothing else happens.
    harness.ok("scrobble", id="tr-t1")
    assert harness.db.get_track_user_state("t1")["play_count"] == 1
    assert ScrobbleStore(user_id).connections() == {}

    with user_context(user_id):
        service.connect_listenbrainz(user_id, "lb-token", admin=False)
    harness.ok("scrobble", id="tr-t1", submission="false")
    harness.ok("scrobble", id="tr-t1", time=1_700_000_123_000)
    harness.ok("scrobble", id="tr-missing")
    service.deliver_due()

    assert [listen.title for listen in remote.announced] == ["Salir"]
    (batch,) = remote.submitted
    assert (batch[0].artist, batch[0].title, batch[0].album, batch[0].duration) == ("Extremoduro", "Salir", "Agíla", 242)
    assert batch[0].started_at == 1_700_000_123
    assert harness.db.get_track_user_state("t1")["play_count"] == 2
