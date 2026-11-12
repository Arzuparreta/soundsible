"""Scrobbling: who is connected to what, and getting each play there.

Three ways a play arrives, one way it leaves:

* a Soundsible client publishes its playback state and the observer decides the
  song has been listened to (:mod:`shared.scrobble.observer`);
* an OpenSubsonic app calls ``scrobble`` — that app has already decided;
* either of those also reports the song that just started, as "now playing".

A play is written to the account's queue before anything is sent, and leaves it
only when the service has answered. The delivery thread sends in order, backs
off when a service is down, and stops — keeping the queue — when a token has
been revoked, until the listener connects again. "Now playing" is never queued:
it is only true for the length of a song, so one that fails is forgotten.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, NamedTuple, Optional

from shared import atomic_file
from shared.runtime import get_config_dir

from .clients import (
    LISTENBRAINZ_URL,
    LastFmClient,
    ListenBrainzClient,
    Outcome,
    Reply,
    normalize_server,
)
from .listen import Listen, listen_from_track
from .observer import ListeningObserver
from .store import ScrobbleStore, decrypt_secret, encrypt_secret, users_with_store

logger = logging.getLogger(__name__)

LISTENBRAINZ = "listenbrainz"
LASTFM = "lastfm"
MALOJA = "maloja"
SERVICES = (LISTENBRAINZ, LASTFM, MALOJA)

LASTFM_APP_FILENAME = "lastfm_app.json"
LASTFM_KEY_ENV = "SOUNDSIBLE_LASTFM_API_KEY"
LASTFM_SECRET_ENV = "SOUNDSIBLE_LASTFM_API_SECRET"

#: First retry after a failed delivery; doubles up to the ceiling.
RETRY_BASE_SECONDS = 30.0
RETRY_MAX_SECONDS = 3600.0
#: How long the delivery thread sleeps when nothing is waiting on a timer.
IDLE_SECONDS = 300.0

_MAX_TOKEN_LENGTH = 512


class ScrobbleError(Exception):
    """A request the service refuses. ``code`` is what the player translates."""

    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class LastFmApp(NamedTuple):
    api_key: str
    api_secret: str
    #: True when it comes from the environment, which Settings cannot change.
    from_environment: bool


def _lastfm_app_path() -> Path:
    return Path(get_config_dir()) / LASTFM_APP_FILENAME


def lastfm_app() -> Optional[LastFmApp]:
    """The Last.fm API account this instance scrobbles through, if it has one.

    Last.fm identifies the application as well as the listener, and Soundsible
    ships no application key: an instance uses its operator's own, from the
    environment or from Settings.
    """
    key = os.environ.get(LASTFM_KEY_ENV, "").strip()
    secret = os.environ.get(LASTFM_SECRET_ENV, "").strip()
    if key and secret:
        return LastFmApp(key, secret, True)
    try:
        stored = json.loads(_lastfm_app_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(stored, dict):
        return None
    key = str(stored.get("api_key") or "")
    secret = decrypt_secret(str(stored.get("api_secret_enc") or "")) or ""
    return LastFmApp(key, secret, False) if key and secret else None


def _clean_token(raw: Any) -> str:
    token = str(raw or "").strip()
    if not token or len(token) > _MAX_TOKEN_LENGTH or any(ch.isspace() for ch in token):
        raise ScrobbleError("token_required")
    return token


def _connect_error(reply: Reply) -> ScrobbleError:
    if reply.outcome is Outcome.UNAUTHORIZED:
        return ScrobbleError("token_rejected")
    if reply.outcome is Outcome.RETRY:
        return ScrobbleError("api_key_rejected" if reply.detail == "api_key_rejected" else "unreachable", 502)
    return ScrobbleError("not_listenbrainz" if reply.detail == "not_listenbrainz" else "rejected")


class ScrobbleService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._observer = ListeningObserver(self.now_playing, self.play)
        #: Whether an account has any connection that is switched on. Asked on
        #: every playback publication, so it is not read from disk each time.
        self._active: dict[str, bool] = {}
        self._now_playing: dict[str, Listen] = {}
        self._due: set[str] = set()
        #: Last.fm tokens waiting for their owner to press "Allow".
        self._lastfm_tokens: dict[str, str] = {}
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- plays coming in ---------------------------------------------------

    def is_active(self, user_id: str) -> bool:
        with self._lock:
            known = self._active.get(user_id)
            if known is None:
                known = any(row["enabled"] for row in ScrobbleStore(user_id).connections().values())
                self._active[user_id] = known
            return known

    def observe(self, user_id: str, state: dict[str, Any]) -> None:
        """One ``PUT /api/playback/state`` from one of this account's devices."""
        if not self.is_active(user_id):
            return
        device_id = str(state.get("device_id") or "").strip()
        if not device_id:
            return
        track = state.get("track") if isinstance(state.get("track"), dict) else None
        track_key = str(state.get("track_id") or (track or {}).get("id") or "")
        try:
            position = max(0.0, float(state.get("position_sec") or 0))
        except (TypeError, ValueError):
            position = 0.0
        with self._lock:
            self._observer.observe(
                user_id,
                device_id,
                track_key,
                position,
                bool(state.get("is_playing")),
                time.time(),
                lambda: self._resolve(user_id, track_key, track),
            )

    @staticmethod
    def _resolve(user_id: str, track_id: str, published: Optional[dict[str, Any]]) -> Optional[Listen]:
        """The library's own record of a track when it has one, else what the client published.

        The library is asked first because its tags are the ones the listener
        curated, and because the iOS client publishes an id and nothing else.
        """
        try:
            from shared.database import user_db

            found = user_db(user_id).get_tracks_by_ids([track_id])
        except Exception:
            logger.debug("Scrobble: library lookup failed for %s", track_id, exc_info=True)
            found = []
        if found:
            return listen_from_track(found[0])
        return listen_from_track(published) if published else None

    def now_playing(self, user_id: str, listen: Listen) -> None:
        with self._lock:
            self._now_playing[user_id] = listen
        self._wake.set()

    def play(self, user_id: str, listen: Listen) -> None:
        """A song that counted. Queued for every connected service that is switched on."""
        if not listen.started_at:
            listen = listen.at(time.time())
        if not ScrobbleStore(user_id).enqueue(listen):
            return
        with self._lock:
            self._due.add(user_id)
        self._wake.set()

    # -- connections -------------------------------------------------------

    def status(self, user_id: str, *, admin: bool) -> dict[str, Any]:
        connections = ScrobbleStore(user_id).connections()
        app = lastfm_app()
        services = []
        for service in SERVICES:
            row = connections.get(service)
            entry: dict[str, Any] = {"service": service, "connected": row is not None}
            if row is not None:
                state = "reconnect" if row["needs_reconnect"] else "retrying" if row["failures"] else "ok"
                entry.update(
                    enabled=bool(row["enabled"]),
                    username=row["username"],
                    server=row["server"],
                    state=state,
                    pending=row["pending"],
                    last_sent_at=row["last_sent_at"],
                    error=row["last_error"],
                )
            if service == LASTFM:
                entry["available"] = app is not None
                with self._lock:
                    entry["authorizing"] = user_id in self._lastfm_tokens
            services.append(entry)
        payload: dict[str, Any] = {"services": services, "custom_servers": admin}
        if admin:
            payload["lastfm_app"] = {
                "configured": app is not None,
                "from_environment": bool(app and app.from_environment),
            }
        return payload

    def _connected(self, user_id: str) -> None:
        with self._lock:
            self._active.pop(user_id, None)
            self._due.add(user_id)
        self._wake.set()

    def connect_listenbrainz(self, user_id: str, token: Any, server: Any = "", *, admin: bool) -> None:
        token = _clean_token(token)
        address = ""
        if str(server or "").strip():
            address = normalize_server(server) or ""
            if not address:
                raise ScrobbleError("server_invalid")
            if address == LISTENBRAINZ_URL:
                address = ""
        if address and not admin:
            # The engine would send requests to an address of the caller's
            # choosing, from inside the network it runs in.
            raise ScrobbleError("custom_server_forbidden", 403)
        reply = ListenBrainzClient(token, address).validate()
        if not reply.ok:
            raise _connect_error(reply)
        ScrobbleStore(user_id).connect(
            LISTENBRAINZ, secret=token, username=reply.data.get("username", ""), server=address
        )
        self._connected(user_id)

    def connect_maloja(self, user_id: str, server: Any, token: Any, *, admin: bool) -> None:
        if not admin:
            raise ScrobbleError("custom_server_forbidden", 403)
        token = _clean_token(token)
        address = normalize_server(server)
        if not address:
            raise ScrobbleError("server_invalid")
        reply = ListenBrainzClient(token, address, maloja=True).validate()
        if not reply.ok:
            raise _connect_error(reply)
        ScrobbleStore(user_id).connect(MALOJA, secret=token, username=reply.data.get("username", ""), server=address)
        self._connected(user_id)

    def lastfm_authorize(self, user_id: str) -> str:
        """Start connecting Last.fm. Returns the page where the listener allows it."""
        app = lastfm_app()
        if app is None:
            raise ScrobbleError("lastfm_unavailable", 409)
        client = LastFmClient(app.api_key, app.api_secret)
        reply = client.request_token()
        if not reply.ok:
            raise _connect_error(reply)
        token = str(reply.data["token"])
        with self._lock:
            self._lastfm_tokens[user_id] = token
        return client.authorize_url(token)

    def lastfm_complete(self, user_id: str) -> None:
        """Finish connecting Last.fm once the listener has allowed it in their browser."""
        app = lastfm_app()
        with self._lock:
            token = self._lastfm_tokens.get(user_id)
        if app is None or not token:
            raise ScrobbleError("lastfm_not_started", 409)
        reply = LastFmClient(app.api_key, app.api_secret).open_session(token)
        if not reply.ok:
            code = reply.data.get("code")
            if code == 14:
                raise ScrobbleError("lastfm_not_authorized", 409)
            if code in (4, 15):
                with self._lock:
                    self._lastfm_tokens.pop(user_id, None)
                raise ScrobbleError("lastfm_expired", 409)
            raise _connect_error(reply)
        with self._lock:
            self._lastfm_tokens.pop(user_id, None)
        ScrobbleStore(user_id).connect(LASTFM, secret=reply.data["session_key"], username=reply.data["username"])
        self._connected(user_id)

    def set_enabled(self, user_id: str, service: str, enabled: bool) -> None:
        ScrobbleStore(user_id).update(service, enabled=1 if enabled else 0)
        with self._lock:
            self._active.pop(user_id, None)
            if enabled:
                self._due.add(user_id)
            elif not self.is_active(user_id):
                self._observer.forget_user(user_id)
        self._wake.set()

    def disconnect(self, user_id: str, service: str) -> None:
        ScrobbleStore(user_id).disconnect(service)
        with self._lock:
            self._active.pop(user_id, None)
            if service == LASTFM:
                self._lastfm_tokens.pop(user_id, None)
            if not self.is_active(user_id):
                self._observer.forget_user(user_id)

    def retry_now(self, user_id: str, service: str) -> None:
        """Send what is waiting without sitting out the rest of a back-off."""
        ScrobbleStore(user_id).update(service, retry_at=0)
        with self._lock:
            self._due.add(user_id)
        self._wake.set()

    def set_lastfm_app(self, api_key: Any, api_secret: Any) -> None:
        current = lastfm_app()
        if current is not None and current.from_environment:
            raise ScrobbleError("lastfm_app_from_environment", 409)
        key, secret = _clean_token(api_key), _clean_token(api_secret)
        reply = LastFmClient(key, secret).request_token()
        if not reply.ok:
            if reply.outcome is Outcome.REJECTED or reply.detail == "api_key_rejected":
                raise ScrobbleError("api_key_rejected")
            raise ScrobbleError("unreachable", 502)
        body = json.dumps({"api_key": key, "api_secret_enc": encrypt_secret(secret)})
        atomic_file.replace_contents(_lastfm_app_path(), atomic_file.text_pieces([body]))

    def clear_lastfm_app(self) -> None:
        current = lastfm_app()
        if current is not None and current.from_environment:
            raise ScrobbleError("lastfm_app_from_environment", 409)
        _lastfm_app_path().unlink(missing_ok=True)

    # -- delivery ----------------------------------------------------------

    def start(self) -> bool:
        if self._thread is not None and self._thread.is_alive():
            return False
        self._stop.clear()
        with self._lock:
            # Whatever a previous run left queued.
            self._due.update(users_with_store())
        self._thread = threading.Thread(target=self._run, name="scrobble-delivery", daemon=True)
        self._thread.start()
        return True

    def stop(self, timeout: float = 3.0) -> None:
        self._stop.set()
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout)

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.clear()
            try:
                delay = self.deliver_due()
            except Exception:
                logger.exception("Scrobble: delivery pass failed")
                delay = RETRY_BASE_SECONDS
            self._wake.wait(timeout=delay)

    def deliver_due(self, now: Optional[float] = None) -> float:
        """One delivery pass. Returns the seconds until something is due again."""
        now = time.time() if now is None else now
        with self._lock:
            playing, self._now_playing = self._now_playing, {}
            users, self._due = self._due, set()
        for user_id, listen in playing.items():
            self._send_now_playing(user_id, listen)
        soonest = IDLE_SECONDS
        for user_id in sorted(users):
            if self._stop.is_set():
                with self._lock:
                    self._due.add(user_id)
                continue
            wait = self._deliver_user(user_id, now)
            if wait is not None:
                soonest = min(soonest, wait)
                with self._lock:
                    self._due.add(user_id)
        return soonest

    @staticmethod
    def _client(service: str, row: dict[str, Any]) -> tuple[Any, str]:
        """The client for a connection, or ``(None, reason)`` when it cannot be built."""
        secret = decrypt_secret(row["secret_enc"])
        if secret is None:
            return None, "token_unreadable"
        if service == LASTFM:
            app = lastfm_app()
            if app is None:
                return None, "lastfm_unavailable"
            return LastFmClient(app.api_key, app.api_secret, secret), ""
        return ListenBrainzClient(secret, row["server"], maloja=service == MALOJA), ""

    def _send_now_playing(self, user_id: str, listen: Listen) -> None:
        store = ScrobbleStore(user_id)
        for service, row in store.connections().items():
            if not row["enabled"] or row["needs_reconnect"]:
                continue
            client, _ = self._client(service, row)
            if client is None:
                continue
            reply = client.now_playing(listen)
            if reply.outcome is Outcome.UNAUTHORIZED:
                store.update(service, needs_reconnect=1, last_error=reply.detail)

    def _deliver_user(self, user_id: str, now: float) -> Optional[float]:
        """Send what one account has waiting. ``None`` when nothing is left on a timer."""
        store = ScrobbleStore(user_id)
        soonest: Optional[float] = None
        for service, row in store.connections().items():
            if not row["enabled"] or row["needs_reconnect"] or not row["pending"]:
                continue
            wait: Optional[float]
            if row["retry_at"] > now:
                wait = row["retry_at"] - now
            else:
                client, problem = self._client(service, row)
                if client is None and problem == "token_unreadable":
                    store.update(service, needs_reconnect=1, last_error=problem)
                    continue
                if client is None:
                    wait = RETRY_MAX_SECONDS
                    store.update(service, retry_at=int(now + wait), last_error=problem)
                else:
                    wait = self._drain(store, service, row, client, now)
            if wait is not None:
                soonest = wait if soonest is None else min(soonest, wait)
        return soonest

    def _drain(self, store: ScrobbleStore, service: str, row: dict[str, Any], client: Any, now: float) -> Optional[float]:
        size = client.batch_size
        while not self._stop.is_set():
            batch = store.batch(service, size)
            if not batch:
                return None
            ids = [item_id for item_id, _ in batch]
            reply: Reply = client.submit([listen for _, listen in batch])
            if reply.ok:
                store.remove(ids)
                store.update(service, failures=0, retry_at=0, last_error="", last_sent_at=int(now))
            elif reply.outcome is Outcome.UNAUTHORIZED:
                store.update(service, needs_reconnect=1, last_error=reply.detail)
                return None
            elif reply.outcome is Outcome.REJECTED:
                if len(batch) > 1:
                    # One play in the batch is unacceptable. Send them singly so
                    # only that one is lost.
                    size = 1
                    continue
                logger.warning("Scrobble: %s refused a play for good (%s); dropped", service, reply.detail)
                store.remove(ids)
                store.update(service, last_error=reply.detail)
            else:
                failures = int(row["failures"]) + 1
                delay = reply.retry_after or min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** (failures - 1))
                store.update(service, failures=failures, retry_at=int(now + delay), last_error=reply.detail)
                return delay
        return 0.0


_service: Optional[ScrobbleService] = None
_service_lock = threading.Lock()


def get_scrobble_service() -> ScrobbleService:
    global _service
    with _service_lock:
        if _service is None:
            _service = ScrobbleService()
        return _service


def stop_scrobble_service_if_started() -> None:
    """Stop the delivery thread and forget every session (shutdown, and between tests)."""
    global _service
    with _service_lock:
        service, _service = _service, None
    if service is not None:
        service.stop()
