"""Scrobbling to ListenBrainz, Last.fm and Maloja.

Off until an account connects a service in Settings. From then on every song
that account listens to — in any Soundsible client, or in an OpenSubsonic app —
is reported to the services it connected, and to nobody else.

The pieces: :mod:`listen` says what a play is, :mod:`observer` finds plays in
the playback state clients already publish, :mod:`store` keeps one account's
connections and unsent plays, :mod:`clients` speaks to the services, and
:mod:`service` ties them together and owns the delivery thread.
"""

from .listen import Listen, listen_from_track
from .service import (
    LASTFM,
    LISTENBRAINZ,
    MALOJA,
    SERVICES,
    ScrobbleError,
    get_scrobble_service,
    stop_scrobble_service_if_started,
)

__all__ = [
    "LASTFM",
    "LISTENBRAINZ",
    "MALOJA",
    "SERVICES",
    "Listen",
    "ScrobbleError",
    "get_scrobble_service",
    "listen_from_track",
    "stop_scrobble_service_if_started",
]
