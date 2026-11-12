"""The two wire protocols scrobbling services speak.

* **ListenBrainz** — ``POST /1/submit-listens`` with a user token. Maloja
  serves the same protocol under ``/apis/listenbrainz``, so one client covers
  ListenBrainz, a self-hosted ListenBrainz and Maloja.
* **Last.fm** — signed calls to ``ws.audioscrobbler.com``, with a session key
  the listener grants in their browser.

Every call answers with a :class:`Reply` whose outcome is one of four things,
because those four are all the delivery queue can act on: it went through, try
again later, this will never be accepted, or the credential stopped working.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional
from urllib.parse import urlencode, urlsplit

import requests

from shared.version import resolve_version

from .listen import Listen

logger = logging.getLogger(__name__)

LISTENBRAINZ_URL = "https://api.listenbrainz.org"
LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/"
LASTFM_AUTH_URL = "https://www.last.fm/api/auth/"

#: Connect, then read. A scrobble is small and nobody is waiting on it.
TIMEOUT = (5.0, 15.0)

#: ListenBrainz accepts 1000 listens in one request; this keeps a retry cheap.
LISTENBRAINZ_BATCH = 100
#: Maloja stops at the first listen it already has and reports the whole
#: request as a duplicate, so the ones after it would never be stored.
MALOJA_BATCH = 1
#: Last.fm's documented maximum for `track.scrobble`.
LASTFM_BATCH = 50

PLAYER_NAME = "Soundsible"


class Outcome(Enum):
    OK = "ok"
    RETRY = "retry"
    REJECTED = "rejected"
    UNAUTHORIZED = "unauthorized"


@dataclass(frozen=True)
class Reply:
    outcome: Outcome
    #: A short machine-readable reason, shown in Settings and written to the log.
    detail: str = ""
    #: Seconds the service asked to wait, when it said.
    retry_after: Optional[float] = None
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.outcome is Outcome.OK


def _user_agent() -> str:
    return f"{PLAYER_NAME}/{resolve_version()}"


def normalize_server(raw: str) -> Optional[str]:
    """A server address as ``scheme://host[:port][/path]`` with no trailing slash, or ``None``."""
    text = str(raw or "").strip().rstrip("/")
    if not text or any(ch.isspace() for ch in text):
        return None
    if "://" not in text:
        text = f"https://{text}"
    try:
        parts = urlsplit(text)
        # Reading the port is what raises on one that is not a number.
        if parts.port == 0:
            return None
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.query or parts.fragment:
        return None
    return text


def _seconds(value: Optional[str]) -> Optional[float]:
    try:
        return max(0.0, float(value)) if value is not None else None
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# ListenBrainz (and Maloja, which speaks it)
# ---------------------------------------------------------------------------


class ListenBrainzClient:
    def __init__(self, token: str, server: str = "", *, maloja: bool = False) -> None:
        base = server or LISTENBRAINZ_URL
        self._base = f"{base}/apis/listenbrainz" if maloja else base
        self._token = token
        self._maloja = maloja
        self.batch_size = MALOJA_BATCH if maloja else LISTENBRAINZ_BATCH

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Token {self._token}", "User-Agent": _user_agent()}

    def _reply(self, response: requests.Response) -> Reply:
        status = response.status_code
        if status == 200:
            return Reply(Outcome.OK)
        if status == 401:
            return Reply(Outcome.UNAUTHORIZED, "token_rejected")
        if status == 409 and self._maloja:
            # Maloja already holds a scrobble with this timestamp.
            return Reply(Outcome.OK, "duplicate")
        if status == 429:
            return Reply(Outcome.RETRY, "rate_limited", _seconds(response.headers.get("X-RateLimit-Reset-In")))
        if status >= 500:
            return Reply(Outcome.RETRY, f"http_{status}")
        return Reply(Outcome.REJECTED, f"http_{status}")

    def validate(self) -> Reply:
        """Whether the server accepts this token. ``data['username']`` names its owner."""
        try:
            response = requests.get(f"{self._base}/1/validate-token", headers=self._headers(), timeout=TIMEOUT)
        except requests.RequestException as error:
            return Reply(Outcome.RETRY, f"unreachable:{type(error).__name__}")
        reply = self._reply(response)
        if reply.outcome is Outcome.REJECTED:
            # Something answered, and not the way this protocol does.
            return Reply(Outcome.REJECTED, "not_listenbrainz")
        if not reply.ok:
            return reply
        try:
            body = response.json()
        except ValueError:
            return Reply(Outcome.REJECTED, "not_listenbrainz")
        if not isinstance(body, dict) or "valid" not in body:
            return Reply(Outcome.REJECTED, "not_listenbrainz")
        if not body.get("valid"):
            return Reply(Outcome.UNAUTHORIZED, "token_rejected")
        return Reply(Outcome.OK, data={"username": str(body.get("user_name") or "")})

    def _track(self, listen: Listen) -> dict[str, Any]:
        info: dict[str, Any] = {
            "media_player": PLAYER_NAME,
            "media_player_version": resolve_version(),
            "submission_client": PLAYER_NAME,
            "submission_client_version": resolve_version(),
        }
        if listen.duration:
            # Maloja reads `duration`, in seconds; ListenBrainz takes either and
            # asks for only one.
            info["duration" if self._maloja else "duration_ms"] = listen.duration * (1 if self._maloja else 1000)
        if listen.recording_mbid:
            info["recording_mbid"] = listen.recording_mbid
        if listen.track_number:
            info["tracknumber"] = str(listen.track_number)
        if listen.isrc:
            info["isrc"] = listen.isrc
        metadata: dict[str, Any] = {
            "artist_name": listen.artist,
            "track_name": listen.title,
            "additional_info": info,
        }
        if listen.album:
            metadata["release_name"] = listen.album
        return metadata

    def _submit(self, listen_type: str, payload: list[dict[str, Any]]) -> Reply:
        try:
            response = requests.post(
                f"{self._base}/1/submit-listens",
                json={"listen_type": listen_type, "payload": payload},
                headers=self._headers(),
                timeout=TIMEOUT,
            )
        except requests.RequestException as error:
            return Reply(Outcome.RETRY, f"unreachable:{type(error).__name__}")
        return self._reply(response)

    def now_playing(self, listen: Listen) -> Reply:
        return self._submit("playing_now", [{"track_metadata": self._track(listen)}])

    def submit(self, listens: list[Listen]) -> Reply:
        payload = [{"listened_at": item.started_at, "track_metadata": self._track(item)} for item in listens]
        return self._submit("single" if len(payload) == 1 else "import", payload)


# ---------------------------------------------------------------------------
# Last.fm
# ---------------------------------------------------------------------------

#: Last.fm error numbers, from the method pages of its API documentation.
_LASTFM_RETRY = {8, 11, 16, 29}
_LASTFM_SESSION_GONE = {9}
#: The API key itself is wrong, suspended, or signed with the wrong secret.
#: That is the instance's to fix, not something to drop listens over.
_LASTFM_APP_BROKEN = {10, 13, 26}


class LastFmClient:
    def __init__(self, api_key: str, api_secret: str, session_key: str = "") -> None:
        self._api_key = api_key
        self._api_secret = api_secret
        self._session_key = session_key
        self.batch_size = LASTFM_BATCH

    def _sign(self, params: dict[str, str]) -> str:
        """md5 of every parameter as ``<name><value>``, in name order, then the secret."""
        text = "".join(f"{name}{params[name]}" for name in sorted(params)) + self._api_secret
        return hashlib.md5(text.encode("utf-8"), usedforsecurity=False).hexdigest()

    def _call(self, method: str, params: dict[str, str], *, session: bool) -> Reply:
        signed = {"method": method, "api_key": self._api_key, **params}
        if session:
            signed["sk"] = self._session_key
        # `format` is not part of the signature.
        body = {**signed, "api_sig": self._sign(signed), "format": "json"}
        try:
            response = requests.post(
                LASTFM_API_URL, data=body, headers={"User-Agent": _user_agent()}, timeout=TIMEOUT
            )
        except requests.RequestException as error:
            return Reply(Outcome.RETRY, f"unreachable:{type(error).__name__}")
        try:
            data = response.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            outcome = Outcome.RETRY if response.status_code >= 500 or response.status_code == 429 else Outcome.REJECTED
            return Reply(outcome, f"http_{response.status_code}")
        code = data.get("error")
        if code is None:
            return Reply(Outcome.OK, data=data) if response.ok else Reply(Outcome.RETRY, f"http_{response.status_code}")
        try:
            code = int(code)
        except (TypeError, ValueError):
            return Reply(Outcome.REJECTED, "lastfm_error")
        if code in _LASTFM_SESSION_GONE:
            return Reply(Outcome.UNAUTHORIZED, "session_revoked")
        if code in _LASTFM_APP_BROKEN:
            return Reply(Outcome.RETRY, "api_key_rejected", data={"code": code})
        if code in _LASTFM_RETRY:
            return Reply(Outcome.RETRY, f"lastfm_{code}")
        return Reply(Outcome.REJECTED, f"lastfm_{code}", data={"code": code})

    # -- connecting --------------------------------------------------------

    def request_token(self) -> Reply:
        """Start the browser authorization. ``data['token']`` is good for sixty minutes."""
        reply = self._call("auth.getToken", {}, session=False)
        if reply.ok and not reply.data.get("token"):
            return Reply(Outcome.REJECTED, "lastfm_error")
        return reply

    def authorize_url(self, token: str) -> str:
        return f"{LASTFM_AUTH_URL}?{urlencode({'api_key': self._api_key, 'token': token})}"

    def open_session(self, token: str) -> Reply:
        """Exchange an authorized token. ``data`` gets ``username`` and ``session_key``.

        Error 14 means the listener has not pressed "Allow" yet; 4 and 15 mean
        the token is no good and the flow starts over.
        """
        reply = self._call("auth.getSession", {"token": token}, session=False)
        if not reply.ok:
            return reply
        session = reply.data.get("session")
        if not isinstance(session, dict) or not session.get("key"):
            return Reply(Outcome.REJECTED, "lastfm_error")
        return Reply(Outcome.OK, data={"username": str(session.get("name") or ""), "session_key": str(session["key"])})

    # -- listens -----------------------------------------------------------

    @staticmethod
    def _track(listen: Listen, suffix: str = "") -> dict[str, str]:
        params = {f"artist{suffix}": listen.artist, f"track{suffix}": listen.title}
        if listen.album:
            params[f"album{suffix}"] = listen.album
        if listen.album_artist:
            params[f"albumArtist{suffix}"] = listen.album_artist
        if listen.duration:
            params[f"duration{suffix}"] = str(listen.duration)
        if listen.track_number:
            params[f"trackNumber{suffix}"] = str(listen.track_number)
        if listen.recording_mbid:
            params[f"mbid{suffix}"] = listen.recording_mbid
        return params

    def now_playing(self, listen: Listen) -> Reply:
        return self._call("track.updateNowPlaying", self._track(listen), session=True)

    def submit(self, listens: list[Listen]) -> Reply:
        """Scrobble up to fifty plays.

        A play Last.fm accepts and then filters (an ignored artist, a timestamp
        it finds too old) comes back as accepted with a note. It is delivered:
        sending it again would be filtered again.
        """
        params: dict[str, str] = {}
        for index, listen in enumerate(listens):
            suffix = f"[{index}]"
            params.update(self._track(listen, suffix))
            params[f"timestamp{suffix}"] = str(listen.started_at)
        return self._call("track.scrobble", params, session=True)
