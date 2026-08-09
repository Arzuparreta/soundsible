"""Library rows in the shapes the Subsonic schema names.

Three elements carry almost everything a client shows: ``Child`` (a song),
``AlbumID3`` and ``ArtistID3``. Everything here builds one of those as a plain
dict for :mod:`shared.subsonic.envelope` to write out.

Two rules hold the whole file together:

* **Ids are prefixed.** ``getCoverArt`` takes one id and has to know whether it
  names a song, an album or an artist; ``ar-``/``al-``/``tr-`` says so without a
  lookup. They are opaque to clients, so the prefix costs nothing.
* **Nothing is invented.** A field the library cannot answer is left out rather
  than filled with a plausible default — a made-up "date added" sorts a
  client's Recently Added list into nonsense, and no field at all does not.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional

from shared.library_catalog import album_identity, artist_id as catalog_artist_id, track_artists
from shared.models import Track

ARTIST_PREFIX = "ar-"
ALBUM_PREFIX = "al-"
TRACK_PREFIX = "tr-"

#: Leading words a client should ignore when it sorts and indexes by name.
IGNORED_ARTICLES = "The El La Los Las Le Les"

#: ReplayGain is defined against −18 LUFS, so a measurement in LUFS becomes a
#: gain by subtraction. The engine already stores these for volume levelling.
REPLAY_GAIN_REFERENCE_LUFS = -18.0

_CONTENT_TYPES = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "oga": "audio/ogg",
    "wav": "audio/wav",
    "wma": "audio/x-ms-wma",
}

_UNSAFE_PATH = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def artist_id(catalog_id: str) -> str:
    return f"{ARTIST_PREFIX}{catalog_id}"


def album_id(catalog_id: str) -> str:
    return f"{ALBUM_PREFIX}{catalog_id}"


def track_id(raw_id: str) -> str:
    return f"{TRACK_PREFIX}{raw_id}"


def parse_id(value: str) -> tuple[Optional[str], str]:
    """``("album", "<uuid>")`` for a prefixed id, ``(None, value)`` otherwise."""
    raw = str(value or "")
    for kind, prefix in (("artist", ARTIST_PREFIX), ("album", ALBUM_PREFIX), ("track", TRACK_PREFIX)):
        if raw.startswith(prefix):
            return kind, raw[len(prefix):]
    return None, raw


def album_identity_for(track: Track) -> Optional[str]:
    """The catalog album id a track belongs to, or ``None`` when it has no album."""
    return album_identity(track)[0]


def content_type(suffix: str) -> str:
    return _CONTENT_TYPES.get((suffix or "").lower(), "application/octet-stream")


def iso(value: Any) -> Optional[str]:
    """A timestamp Subsonic can read, from whatever the store happened to keep."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    text = str(value).strip()
    if not text:
        return None
    # SQLite's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC, and the
    # favourites file stores a naive ISO string from the same clock.
    candidate = text.replace(" ", "T")
    return candidate if candidate.endswith("Z") or "+" in candidate else f"{candidate}Z"


def _sanitize(component: str) -> str:
    cleaned = _UNSAFE_PATH.sub("_", str(component or "")).strip(" .")
    return cleaned or "Unknown"


def synthetic_path(track: Track, album_artist: str) -> str:
    """A library-shaped path for the client to display and file offline copies under.

    Deliberately not the real one: the server's directory layout is not the
    client's business, and handing out absolute paths to a networked API is how
    a music player starts leaking the shape of somebody's disk.
    """
    number = track.track_number
    stem = f"{int(number):02d} - {_sanitize(track.title)}" if number else _sanitize(track.title)
    suffix = (track.format or "mp3").lower()
    return f"{_sanitize(album_artist or track.artist)}/{_sanitize(track.album)}/{stem}.{suffix}"


def replay_gain(measurement: Optional[tuple[float, float]]) -> Optional[dict[str, Any]]:
    if not measurement:
        return None
    lufs, peak_dbtp = measurement
    return {
        "trackGain": round(REPLAY_GAIN_REFERENCE_LUFS - float(lufs), 2),
        "trackPeak": round(10 ** (float(peak_dbtp) / 20), 6),
    }


def loudness_identity(track: Track) -> str:
    """The key the loudness store filed this track's measurement under."""
    return str(track.file_hash or track.id or "")


def song(
    track: Track,
    *,
    state: Optional[Mapping[str, Any]] = None,
    starred_at: Optional[str] = None,
    measurement: Optional[tuple[float, float]] = None,
) -> dict[str, Any]:
    """One ``Child``, the element every listing of songs is made of."""
    performers = track_artists(track)
    catalog_album, album_title, album_artist = album_identity(track, performers)
    state = state or {}
    rating = state.get("rating")
    play_count = int(state.get("play_count") or 0)

    payload: dict[str, Any] = {
        "id": track_id(track.id),
        "parent": album_id(catalog_album) if catalog_album else None,
        "isDir": False,
        "title": track.title,
        "album": album_title or track.album or None,
        "artist": track.artist or None,
        "track": track.track_number,
        "year": track.year,
        "genre": track.genre or None,
        "coverArt": track_id(track.id),
        "size": track.file_size or None,
        "contentType": content_type(track.format),
        "suffix": (track.format or "").lower() or None,
        "duration": int(track.duration or 0),
        "bitRate": track.bitrate or None,
        "path": synthetic_path(track, album_artist),
        "discNumber": track.disc_number,
        "albumId": album_id(catalog_album) if catalog_album else None,
        "artistId": artist_id(catalog_artist_id(performers[0])) if performers else None,
        "type": "music",
        "isVideo": False,
        "playCount": play_count or None,
        "played": iso(state.get("last_played_at")),
        "userRating": rating,
        "starred": starred_at,
        # OpenSubsonic additions.
        "mediaType": "song",
        "musicBrainzId": track.musicbrainz_id or None,
        "displayArtist": track.artist or None,
        "displayAlbumArtist": album_artist or None,
        "sortName": track.title,
        "artists": [
            {"id": artist_id(catalog_artist_id(name)), "name": name} for name in performers
        ] or None,
        "albumArtists": (
            [{"id": artist_id(catalog_artist_id(album_artist)), "name": album_artist}]
            if album_artist
            else None
        ),
        "genres": [{"name": track.genre}] if track.genre else None,
        "replayGain": replay_gain(measurement),
    }
    return {key: value for key, value in payload.items() if value is not None}


def album(row: Mapping[str, Any], *, starred_at: Optional[str] = None) -> dict[str, Any]:
    """One ``AlbumID3`` from a catalog album row."""
    payload: dict[str, Any] = {
        "id": album_id(str(row["id"])),
        "name": row.get("title") or row.get("album"),
        "title": row.get("title") or row.get("album"),
        "artist": row.get("album_artist"),
        "artistId": artist_id(str(row["album_artist_id"])) if row.get("album_artist_id") else None,
        "coverArt": album_id(str(row["id"])),
        "songCount": int(row.get("track_count") or 0),
        "duration": int(row.get("duration") or 0),
        "playCount": int(row.get("play_count") or 0) or None,
        "created": iso(row.get("added_at")),
        "year": row.get("year"),
        "genre": row.get("genre"),
        "starred": starred_at,
        "played": iso(row.get("last_played_at")),
        # OpenSubsonic additions.
        "isCompilation": bool(row.get("is_compilation")),
        "sortName": row.get("title") or row.get("album"),
        "genres": [{"name": row["genre"]}] if row.get("genre") else None,
    }
    return {key: value for key, value in payload.items() if value is not None}


def artist(row: Mapping[str, Any], *, starred_at: Optional[str] = None) -> dict[str, Any]:
    """One ``ArtistID3`` from a catalog artist row."""
    payload: dict[str, Any] = {
        "id": artist_id(str(row["id"])),
        "name": row.get("name"),
        "coverArt": artist_id(str(row["id"])),
        "albumCount": int(row.get("album_count") or 0),
        "starred": starred_at,
        "sortName": row.get("name"),
    }
    return {key: value for key, value in payload.items() if value is not None}


def index_letter(name: str) -> str:
    """The bucket ``getIndexes`` files a name under, articles ignored."""
    text = str(name or "").strip()
    for article in IGNORED_ARTICLES.split():
        prefix = f"{article} "
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix):].strip()
            break
    first = text[:1].upper()
    return first if first.isalpha() else "#"


def indexed_artists(rows: Iterable[Mapping[str, Any]], *, starred: Optional[Mapping[str, str]] = None) -> list[dict[str, Any]]:
    """Artists grouped into the alphabetical index both browse calls return."""
    starred = starred or {}
    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        entry = artist(row, starred_at=starred.get(str(row["id"])))
        buckets.setdefault(index_letter(str(row.get("name") or "")), []).append(entry)
    return [
        {"name": letter, "artist": buckets[letter]}
        for letter in sorted(buckets, key=lambda value: (value == "#", value))
    ]
