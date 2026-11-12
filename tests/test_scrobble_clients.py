"""What goes on the wire to ListenBrainz, Maloja and Last.fm, and how their answers are read."""

from __future__ import annotations

import hashlib
from typing import Any, Optional

import pytest
import requests

from shared.scrobble import clients
from shared.scrobble.clients import LastFmClient, ListenBrainzClient, Outcome, normalize_server
from shared.scrobble.listen import Listen, listen_from_track

LISTEN = Listen(
    artist="Extremoduro",
    title="Salir",
    album="Agíla",
    album_artist="",
    duration=242,
    track_number=3,
    recording_mbid="98255a8c-017a-4bc7-8dd6-1fa36124572b",
    started_at=1_700_000_000,
)


class FakeResponse:
    def __init__(self, status: int = 200, body: Any = None, headers: Optional[dict[str, str]] = None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("no JSON")
        return self._body


class Wire:
    """Stands in for `requests`: records each call and answers from a script."""

    def __init__(self, monkeypatch):
        self.calls: list[dict[str, Any]] = []
        self.answers: list[Any] = []
        monkeypatch.setattr(clients.requests, "post", lambda url, **kw: self._call("POST", url, kw))
        monkeypatch.setattr(clients.requests, "get", lambda url, **kw: self._call("GET", url, kw))

    def _call(self, method: str, url: str, kwargs: dict[str, Any]):
        self.calls.append({"method": method, "url": url, **kwargs})
        answer = self.answers.pop(0) if self.answers else FakeResponse(200, {})
        if isinstance(answer, Exception):
            raise answer
        return answer


@pytest.fixture
def wire(monkeypatch):
    return Wire(monkeypatch)


# ---------------------------------------------------------------------------
# What is reported at all
# ---------------------------------------------------------------------------


def test_a_published_track_becomes_a_listen():
    listen = listen_from_track(
        {"title": " Salir ", "artist": "Extremoduro", "album": "Agíla", "album_artist": "Extremoduro", "duration": 242.4}
    )
    assert listen == Listen(artist="Extremoduro", title="Salir", album="Agíla", duration=242)


def test_podcasts_uploader_credits_and_placeholders_are_never_reported():
    song = {"title": "Song", "artist": "Artist"}
    assert listen_from_track({**song, "media_kind": "podcast_episode"}) is None
    assert listen_from_track({**song, "podcast_episode_guid": "ep-1"}) is None
    assert listen_from_track({**song, "artist_is_channel": True}) is None
    assert listen_from_track({"title": "Song", "artist": "Unknown Artist"}) is None
    assert listen_from_track({"title": "", "artist": "Artist"}) is None


def test_a_loose_musicbrainz_id_is_not_passed_on():
    assert listen_from_track({"title": "Song", "artist": "Artist", "musicbrainz_id": "not-a-uuid"}).recording_mbid == ""


def test_server_addresses_are_normalized_or_refused():
    assert normalize_server("maloja.lan:42010/") == "https://maloja.lan:42010"
    assert normalize_server("http://192.168.1.5:42010") == "http://192.168.1.5:42010"
    assert normalize_server("ftp://example.org") is None
    assert normalize_server("https://user:pass@example.org") is None
    assert normalize_server("https://example.org/?x=1") is None
    assert normalize_server("not a url") is None
    assert normalize_server("https://example.org:port") is None
    assert normalize_server("") is None


# ---------------------------------------------------------------------------
# ListenBrainz
# ---------------------------------------------------------------------------


def test_listenbrainz_submits_a_single_listen(wire):
    assert ListenBrainzClient("tok").submit([LISTEN]).ok
    call = wire.calls[0]
    assert call["url"] == "https://api.listenbrainz.org/1/submit-listens"
    assert call["headers"]["Authorization"] == "Token tok"
    assert call["headers"]["User-Agent"].startswith("Soundsible/")
    assert call["json"]["listen_type"] == "single"
    (entry,) = call["json"]["payload"]
    assert entry["listened_at"] == 1_700_000_000
    metadata = entry["track_metadata"]
    assert (metadata["artist_name"], metadata["track_name"], metadata["release_name"]) == ("Extremoduro", "Salir", "Agíla")
    info = metadata["additional_info"]
    assert info["duration_ms"] == 242_000 and "duration" not in info
    assert info["recording_mbid"] == LISTEN.recording_mbid
    assert info["tracknumber"] == "3"
    assert info["media_player"] == info["submission_client"] == "Soundsible"


def test_listenbrainz_sends_several_as_an_import(wire):
    ListenBrainzClient("tok").submit([LISTEN, LISTEN.at(1_700_000_300)])
    assert wire.calls[0]["json"]["listen_type"] == "import"
    assert len(wire.calls[0]["json"]["payload"]) == 2


def test_listenbrainz_now_playing_carries_no_timestamp(wire):
    ListenBrainzClient("tok").now_playing(LISTEN)
    body = wire.calls[0]["json"]
    assert body["listen_type"] == "playing_now"
    assert "listened_at" not in body["payload"][0]


@pytest.mark.parametrize(
    "answer, outcome",
    [
        (FakeResponse(200), Outcome.OK),
        (FakeResponse(401), Outcome.UNAUTHORIZED),
        (FakeResponse(400), Outcome.REJECTED),
        (FakeResponse(429, headers={"X-RateLimit-Reset-In": "7"}), Outcome.RETRY),
        (FakeResponse(503), Outcome.RETRY),
        (requests.ConnectionError("down"), Outcome.RETRY),
    ],
)
def test_listenbrainz_answers_are_one_of_four_outcomes(wire, answer, outcome):
    wire.answers.append(answer)
    reply = ListenBrainzClient("tok").submit([LISTEN])
    assert reply.outcome is outcome
    if isinstance(answer, FakeResponse) and answer.status_code == 429:
        assert reply.retry_after == 7


def test_listenbrainz_validation_names_the_account(wire):
    wire.answers.append(FakeResponse(200, {"code": 200, "valid": True, "user_name": "ana"}))
    reply = ListenBrainzClient("tok").validate()
    assert reply.ok and reply.data["username"] == "ana"
    assert wire.calls[0]["url"] == "https://api.listenbrainz.org/1/validate-token"


def test_listenbrainz_validation_refuses_a_bad_token_and_a_server_that_is_something_else(wire):
    wire.answers += [
        FakeResponse(200, {"code": 200, "valid": False}),
        FakeResponse(200, {"hello": "world"}),
        FakeResponse(200, None),
        FakeResponse(404, {"error": "Not found"}),
    ]
    assert ListenBrainzClient("tok").validate().outcome is Outcome.UNAUTHORIZED
    for _ in range(3):
        assert ListenBrainzClient("tok").validate().detail == "not_listenbrainz"


# ---------------------------------------------------------------------------
# Maloja, over the same protocol
# ---------------------------------------------------------------------------


def test_maloja_is_reached_under_its_listenbrainz_path_with_seconds(wire):
    client = ListenBrainzClient("key", "http://maloja.lan:42010", maloja=True)
    client.submit([LISTEN])
    call = wire.calls[0]
    assert call["url"] == "http://maloja.lan:42010/apis/listenbrainz/1/submit-listens"
    info = call["json"]["payload"][0]["track_metadata"]["additional_info"]
    assert info["duration"] == 242 and "duration_ms" not in info


def test_maloja_takes_one_listen_per_request_and_a_duplicate_is_delivered(wire):
    client = ListenBrainzClient("key", "http://maloja.lan:42010", maloja=True)
    assert client.batch_size == 1
    wire.answers.append(FakeResponse(409))
    assert client.submit([LISTEN]).ok
    # A real ListenBrainz does not answer 409 for that, so there it is a refusal.
    wire.answers.append(FakeResponse(409))
    assert ListenBrainzClient("tok").submit([LISTEN]).outcome is Outcome.REJECTED


# ---------------------------------------------------------------------------
# Last.fm
# ---------------------------------------------------------------------------


def _md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8"), usedforsecurity=False).hexdigest()


def _signature(params: dict[str, str], secret: str) -> str:
    return _md5("".join(f"{name}{params[name]}" for name in sorted(params)) + secret)


def test_lastfm_signs_every_parameter_except_the_format(wire):
    wire.answers.append(FakeResponse(200, {"token": "abc"}))
    reply = LastFmClient("key", "secret").request_token()
    assert reply.ok and reply.data["token"] == "abc"
    call = wire.calls[0]
    assert call["url"] == "https://ws.audioscrobbler.com/2.0/"
    data = dict(call["data"])
    assert data.pop("format") == "json"
    signature = data.pop("api_sig")
    assert data == {"method": "auth.getToken", "api_key": "key"}
    assert signature == _signature(data, "secret")
    # The documentation's own worked example.
    assert LastFmClient("xxxxxxxx", "mysecret")._sign(
        {"api_key": "xxxxxxxx", "method": "auth.getSession", "token": "xxxxxxx"}
    ) == _md5("api_keyxxxxxxxxmethodauth.getSessiontokenxxxxxxxmysecret")


def test_lastfm_authorization_page_and_session_exchange(wire):
    client = LastFmClient("key", "secret")
    assert client.authorize_url("abc") == "https://www.last.fm/api/auth/?api_key=key&token=abc"
    wire.answers.append(FakeResponse(200, {"session": {"name": "ana", "key": "sk-1", "subscriber": 0}}))
    reply = client.open_session("abc")
    assert reply.ok and reply.data == {"username": "ana", "session_key": "sk-1"}
    assert wire.calls[0]["data"]["token"] == "abc"
    assert "sk" not in wire.calls[0]["data"]


def test_lastfm_scrobbles_a_batch_with_indexed_parameters(wire):
    wire.answers.append(FakeResponse(200, {"scrobbles": {"@attr": {"accepted": 2, "ignored": 0}}}))
    other = Listen(artist="Rosendo", title="Maneras de vivir", album_artist="Leño", started_at=1_700_000_500)
    assert LastFmClient("key", "secret", "sk-1").submit([LISTEN, other]).ok
    data = wire.calls[0]["data"]
    assert data["method"] == "track.scrobble" and data["sk"] == "sk-1"
    assert (data["artist[0]"], data["track[0]"], data["timestamp[0]"]) == ("Extremoduro", "Salir", "1700000000")
    assert (data["album[0]"], data["duration[0]"], data["trackNumber[0]"]) == ("Agíla", "242", "3")
    assert data["mbid[0]"] == LISTEN.recording_mbid
    assert (data["artist[1]"], data["albumArtist[1]"], data["timestamp[1]"]) == ("Rosendo", "Leño", "1700000500")
    assert "album[1]" not in data and "albumArtist[0]" not in data
    signed = {key: value for key, value in data.items() if key not in {"api_sig", "format"}}
    assert data["api_sig"] == _signature(signed, "secret")


def test_lastfm_now_playing(wire):
    wire.answers.append(FakeResponse(200, {"nowplaying": {}}))
    assert LastFmClient("key", "secret", "sk-1").now_playing(LISTEN).ok
    data = wire.calls[0]["data"]
    assert data["method"] == "track.updateNowPlaying" and "timestamp" not in data


@pytest.mark.parametrize(
    "answer, outcome, detail",
    [
        (FakeResponse(403, {"error": 9, "message": "Invalid session key"}), Outcome.UNAUTHORIZED, "session_revoked"),
        (FakeResponse(200, {"error": 11, "message": "Service Offline"}), Outcome.RETRY, "lastfm_11"),
        (FakeResponse(200, {"error": 16, "message": "Temporarily unavailable"}), Outcome.RETRY, "lastfm_16"),
        (FakeResponse(429, {"error": 29, "message": "Rate limit exceeded"}), Outcome.RETRY, "lastfm_29"),
        (FakeResponse(403, {"error": 10, "message": "Invalid API key"}), Outcome.RETRY, "api_key_rejected"),
        (FakeResponse(403, {"error": 13, "message": "Invalid method signature"}), Outcome.RETRY, "api_key_rejected"),
        (FakeResponse(400, {"error": 6, "message": "Invalid parameters"}), Outcome.REJECTED, "lastfm_6"),
        (FakeResponse(502, None), Outcome.RETRY, "http_502"),
        (requests.Timeout("slow"), Outcome.RETRY, "unreachable:Timeout"),
    ],
)
def test_lastfm_errors_are_one_of_four_outcomes(wire, answer, outcome, detail):
    wire.answers.append(answer)
    reply = LastFmClient("key", "secret", "sk-1").submit([LISTEN])
    assert (reply.outcome, reply.detail) == (outcome, detail)


def test_lastfm_says_when_the_listener_has_not_allowed_it_yet(wire):
    wire.answers.append(FakeResponse(403, {"error": 14, "message": "This token has not been authorized"}))
    reply = LastFmClient("key", "secret").open_session("abc")
    assert reply.outcome is Outcome.REJECTED and reply.data["code"] == 14
