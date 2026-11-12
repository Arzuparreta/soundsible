"""Turning published playback state into plays.

Every Soundsible client — the web player, the Android app, the iOS app —
already tells the engine what it is playing: ``PUT /api/playback/state``, on
each transport change and every fifteen seconds while music plays. This reads
those publications and decides, in one place, when a song started and when it
has been listened to enough to count. No client implements scrobbling, so no
client can disagree with another about what a play is.

Listening time is wall-clock time between two publications of which the first
said "playing". What bounds it depends on whether the client stayed awake:

* **A client that is awake publishes at least every fifteen seconds.** Between
  two such publications its position is fresh, so the time credited is no more
  than the position advanced: a stalled stream is not listening.
* **A client that went quiet may still have been playing.** A phone with its
  screen off keeps the audio going and can stop running the page's timers; the
  next thing heard from it is the track ending or the following song, and the
  position it reports then may be as old as its last tick. That silence is
  credited only if it fits in what was left of the track, plus the grace period
  after which the device registry itself calls a device gone. A longer silence
  is a client that died, and nothing is credited for it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from shared.playback_state import ACTIVE_DEVICE_TTL_SEC, STATE_TTL_SEC

from .listen import Listen, required_seconds

#: Two publication intervals. A gap up to this long is a client that is awake.
AWAKE_GAP_SECONDS = 30.0
#: How long after a track should have ended a silent device is still believed.
GONE_AFTER_SECONDS = float(ACTIVE_DEVICE_TTL_SEC)


@dataclass
class _Session:
    track_key: str
    #: ``None`` for something that is never reported (a podcast, an upload with
    #: no performer). Kept so the track is not resolved again on every ping.
    listen: Optional[Listen]
    started_at: float
    last_seen: float
    position: float
    playing: bool
    listened: float = 0.0
    counted: bool = False

    @property
    def duration(self) -> float:
        return float(self.listen.duration) if self.listen else 0.0

    def expires_at(self) -> float:
        # A paused song is still the same listen when it is picked up again,
        # for as long as its playback state is itself offered for resuming.
        if not self.playing:
            return self.last_seen + STATE_TTL_SEC
        return self.last_seen + max(0.0, self.duration - self.position) + GONE_AFTER_SECONDS


class ListeningObserver:
    """Per-device listening sessions for every account.

    ``on_now_playing`` and ``on_play`` are called with ``(user_id, listen)``.
    Not thread-safe: the owner serializes calls.
    """

    def __init__(
        self,
        on_now_playing: Callable[[str, Listen], None],
        on_play: Callable[[str, Listen], None],
    ) -> None:
        self._on_now_playing = on_now_playing
        self._on_play = on_play
        self._sessions: dict[tuple[str, str], _Session] = {}

    def observe(
        self,
        user_id: str,
        device_id: str,
        track_key: str,
        position: float,
        playing: bool,
        now: float,
        resolve: Callable[[], Optional[Listen]],
    ) -> None:
        """One publication from one device. ``track_key`` is empty when it holds no track."""
        self._expire(now)
        key = (user_id, device_id)
        session = self._sessions.get(key)

        if session is not None:
            self._credit(user_id, session, position if track_key == session.track_key else None, playing, now)
            restarted = (
                track_key == session.track_key
                and session.counted
                and playing
                and position < session.position
                and position <= AWAKE_GAP_SECONDS
            )
            if track_key != session.track_key or restarted:
                # A different song, or the same one begun again after it had
                # already counted: either way the listen it was is over.
                del self._sessions[key]
                session = None

        if not track_key:
            return
        if session is None:
            if not playing:
                return
            session = self._adopt(user_id, device_id, track_key, position, now)
            if session is None:
                session = _Session(track_key, resolve(), started_at=now, last_seen=now, position=position, playing=False)
            self._sessions[key] = session

        resumed = playing and not session.playing
        session.last_seen, session.position, session.playing = now, position, playing
        if resumed and session.listen is not None:
            self._on_now_playing(user_id, session.listen)

    def forget_user(self, user_id: str) -> None:
        for key in [key for key in self._sessions if key[0] == user_id]:
            del self._sessions[key]

    # -- internals ---------------------------------------------------------

    def _credit(self, user_id: str, session: _Session, position: Optional[float], playing: bool, now: float) -> None:
        """Count the interval since the last publication. ``position`` is ``None`` if the track changed."""
        if not session.playing:
            return
        elapsed = max(0.0, now - session.last_seen)
        duration = session.duration
        remaining = max(0.0, duration - session.position) if duration > 0 else None
        advanced = None if position is None else position - session.position
        if elapsed <= AWAKE_GAP_SECONDS:
            # A seek moves the position without anything being heard, in either
            # direction; only a forward step no longer than the clock vouches.
            credit = advanced if advanced is not None and 0 <= advanced <= elapsed else elapsed
            if advanced is None and remaining is not None:
                credit = min(credit, remaining)
        elif remaining is None or elapsed > remaining + GONE_AFTER_SECONDS:
            credit = 0.0
        elif advanced is not None and playing:
            # Heard from again in the middle of the same song, and playing: its
            # clock is running, so the position is the evidence.
            credit = min(max(advanced, 0.0), elapsed, remaining)
        else:
            credit = min(elapsed, remaining)
        session.listened += credit
        self._count_if_due(user_id, session)

    def _count_if_due(self, user_id: str, session: _Session) -> None:
        if session.counted or session.listen is None:
            return
        needed = required_seconds(session.duration)
        if needed is None or session.listened < needed:
            return
        session.counted = True
        self._on_play(user_id, session.listen.at(session.started_at))

    def _adopt(self, user_id: str, device_id: str, track_key: str, position: float, now: float) -> Optional[_Session]:
        """Carry a listen over from the account's other device that just had it.

        Handing playback to another device continues one listen; it does not
        start a second. Without this a long track moved halfway would count on
        both devices.
        """
        for key, other in self._sessions.items():
            if key[0] != user_id or key[1] == device_id or other.track_key != track_key:
                continue
            if now - other.last_seen > GONE_AFTER_SECONDS or abs(position - other.position) > AWAKE_GAP_SECONDS:
                continue
            del self._sessions[key]
            other.playing = False
            return other
        return None

    def _expire(self, now: float) -> None:
        for key in [key for key, session in self._sessions.items() if now > session.expires_at()]:
            del self._sessions[key]
