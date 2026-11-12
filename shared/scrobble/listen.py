"""What a play is, and when one counts.

One rule decides for every service, so a song cannot be a play on ListenBrainz
and not on Last.fm. It is the rule both of them publish: the track is longer
than thirty seconds, and it was listened to for half its length or four
minutes, whichever comes first.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Optional

#: A track this short is never a play (Last.fm's scrobbling rules).
MIN_TRACK_SECONDS = 30.0
#: Listening this long is a play however long the track is.
MAX_REQUIRED_SECONDS = 240.0

#: What the engine writes where a file's tags name nobody.
_PLACEHOLDER_ARTISTS = {"", "unknown", "unknown artist"}
_PLACEHOLDER_TITLES = {"", "unknown"}


def required_seconds(duration: float) -> Optional[float]:
    """Listening a track of ``duration`` seconds needs to count; ``None`` if it never can.

    A track whose length nobody reported is held to the four-minute bound: half
    of an unknown length is not a number.
    """
    if duration > 0:
        if duration <= MIN_TRACK_SECONDS:
            return None
        return min(duration / 2.0, MAX_REQUIRED_SECONDS)
    return MAX_REQUIRED_SECONDS


@dataclass(frozen=True)
class Listen:
    """One song as a scrobbling service is told about it."""

    artist: str
    title: str
    album: str = ""
    album_artist: str = ""
    duration: int = 0
    track_number: int = 0
    recording_mbid: str = ""
    isrc: str = ""
    #: When the song started playing, Unix seconds. Zero until it is a play.
    started_at: int = 0

    def at(self, started_at: float) -> "Listen":
        return Listen(**{**asdict(self), "started_at": int(started_at)})

    def to_json(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Listen":
        known = {key: data[key] for key in cls.__dataclass_fields__ if key in data}
        return cls(**known)


def _text(value: Any, limit: int = 512) -> str:
    return str(value).strip()[:limit] if isinstance(value, (str, int, float)) and not isinstance(value, bool) else ""


def _whole(value: Any) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return int(number) if 0 < number < 10 * 24 * 3600 else 0


def listen_from_track(track: Any) -> Optional[Listen]:
    """The listen a track describes, or ``None`` when it is not music to report.

    Accepts a library ``Track`` or the dict a client publishes with its playback
    state. Three things are never reported:

    * a podcast episode — these services chart music;
    * a track with no performer or no title — a placeholder would enter the
      listener's history as an artist called "Unknown Artist";
    * an upload whose only credit is the channel that posted it
      (``artist_is_channel``) — the uploader is not the performer.
    """
    get = track.get if isinstance(track, dict) else lambda key, default=None: getattr(track, key, default)
    if get("media_kind") == "podcast_episode" or get("podcast_episode_guid"):
        return None
    if get("artist_is_channel") is True:
        return None
    artist, title = _text(get("artist")), _text(get("title"))
    if artist.casefold() in _PLACEHOLDER_ARTISTS or title.casefold() in _PLACEHOLDER_TITLES:
        return None
    album = _text(get("album"))
    album_artist = _text(get("album_artist"))
    from shared.musicbrainz import normalize_recording_mbid

    return Listen(
        artist=artist,
        title=title,
        album="" if album.casefold() == "unknown album" else album,
        album_artist="" if album_artist == artist else album_artist,
        duration=_whole(get("duration")),
        track_number=_whole(get("track_number")),
        recording_mbid=normalize_recording_mbid(get("musicbrainz_id")) or "",
        isrc=_text(get("isrc"), 32),
    )
