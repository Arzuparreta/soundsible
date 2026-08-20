"""The OpenSubsonic surface: ``/rest``.

Soundsible had exactly one client — its own player. This blueprint is what
makes Symfonium, Feishin, Amperfy, DSub, Tempo and play:Sub work against the
same library, which is also how the project gets offline mobile playback and a
car experience without writing any of them.

Everything served here is read out of the normalized catalog in ``library.db``:
``artists``, ``albums``, ``track_artists`` and ``track_user_state``. Stars are
the favourites the player already keeps, ratings and play counts are the
per-track state the catalog owns, and the bytes come off the same path
``/api/static/stream`` uses.

**This surface authenticates itself.** ``/rest`` is not under ``/api``, so the
engine's request hook leaves it anonymous and every view below runs through
:func:`_authenticate` first. There is no trusted-network shortcut: behind a
funnel the phrase means nothing, and a music API reachable from the internet
without a password is not a feature.
"""

from __future__ import annotations

import logging
import mimetypes as _mimetypes
import os
import time
from functools import wraps
from typing import Any, Callable, Optional

from flask import Blueprint, Response, request, send_file, stream_with_context

from shared.hardening import rate_limit_allows
from shared.path_resolver import is_scanned_track_path, resolve_local_track_path
from shared.security import is_safe_path
from shared.subsonic import serialize, transcode
from shared.subsonic.credentials import authenticate as authenticate_credential
from shared.subsonic.envelope import (
    API_VERSION,
    ERR_BAD_CREDENTIALS,
    ERR_GENERIC,
    ERR_MISSING_PARAMETER,
    ERR_NOT_FOUND,
    TEXT_KEY,
    SubsonicError,
    respond,
)
from shared.user_context import user_context

logger = logging.getLogger(__name__)

subsonic_bp = Blueprint("subsonic", __name__, url_prefix="/rest")

#: One folder, because Soundsible has one library per account.
MUSIC_FOLDER_ID = 0
MUSIC_FOLDER_NAME = "Music"

#: What this server implements beyond plain Subsonic, as the extension list.
OPENSUBSONIC_EXTENSIONS = [
    {"name": "apiKeyAuthentication", "versions": [1]},
    {"name": "formPost", "versions": [1]},
    {"name": "songLyrics", "versions": [1]},
    {"name": "transcodeOffset", "versions": [1]},
]

#: Wrong credentials one address may present before it is told to wait.
FAILED_AUTH_LIMIT = 30
FAILED_AUTH_WINDOW_SEC = 300

_AUDIO_MIMETYPES = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
}


# ---------------------------------------------------------------------------
# Request plumbing
# ---------------------------------------------------------------------------


def _param(name: str, default: Optional[str] = None) -> Optional[str]:
    """One parameter, from the query string or a form post."""
    value = request.values.get(name)
    return value if value is not None else default


def _int_param(name: str, default: Optional[int] = None) -> Optional[int]:
    raw = _param(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        raise SubsonicError(ERR_GENERIC, f"Parameter '{name}' must be a number")


def _bool_param(name: str, default: bool = False) -> bool:
    raw = _param(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in ("true", "1", "yes")


def _required(name: str) -> str:
    value = _param(name)
    if value is None or str(value).strip() == "":
        raise SubsonicError(ERR_MISSING_PARAMETER, f"Required parameter '{name}' is missing")
    return str(value).strip()


def _authenticate() -> dict[str, Any]:
    """Resolve the caller, or raise the protocol's own failure.

    Only *failures* are rated. A client browsing a library makes dozens of
    calls a minute and every one of them carries credentials, so counting
    successes would lock out the people using it correctly and leave anyone
    guessing a password with the same budget they had before.
    """
    try:
        return _resolve_credentials()
    except SubsonicError:
        if not rate_limit_allows("subsonic_auth_failed", limit=FAILED_AUTH_LIMIT, window_sec=FAILED_AUTH_WINDOW_SEC):
            raise SubsonicError(ERR_BAD_CREDENTIALS, "Too many failed attempts; try again shortly") from None
        raise


def _resolve_credentials() -> dict[str, Any]:
    return authenticate_credential(
        (_param("u") or "").strip(),
        password=_param("p"),
        token=_param("t"),
        salt=_param("s"),
        api_key=_param("apiKey"),
        client=(_param("c") or "").strip() or None,
    )


def _endpoint(name: str, methods: tuple[str, ...] = ("GET", "POST")) -> Callable:
    """Register one Subsonic method, at both spellings clients use.

    Old clients append ``.view`` to every call and newer ones do not; the
    protocol treats them as the same method, so both point at one view.
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def view(*args: Any, **kwargs: Any):
            try:
                user = _authenticate()
            except SubsonicError as error:
                return respond(error=error)
            try:
                with user_context(user["id"]):
                    result = func(*args, **kwargs)
            except SubsonicError as error:
                return respond(error=error)
            except Exception:
                logger.exception("Subsonic: %s failed", name)
                return respond(error=SubsonicError(ERR_GENERIC, "Internal server error"))
            if isinstance(result, Response):
                return result
            return respond(result or {})

        subsonic_bp.add_url_rule(f"/{name}", endpoint=name, view_func=view, methods=list(methods))
        # Same view, second URL. Flask endpoints may not contain a dot, so the
        # `.view` spelling gets a name of its own rather than mirroring the URL.
        subsonic_bp.add_url_rule(f"/{name}.view", endpoint=f"{name}_view", view_func=view, methods=list(methods))
        return view

    return decorator


# ---------------------------------------------------------------------------
# Library access
# ---------------------------------------------------------------------------


def _library():
    """The bound account's library, refreshed if the manifest moved under us."""
    from shared.api import get_core

    lib, _, _ = get_core()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    return lib


def _db():
    lib = _library()
    if lib.db is None:
        raise SubsonicError(ERR_GENERIC, "Library index unavailable")
    return lib.db


def _favourites():
    from shared.api import get_favourites_manager

    return get_favourites_manager()


def _starred_track_ids() -> dict[str, str]:
    """Starred library track id -> when it was starred.

    Favourites are identity-keyed (a song saved as a preview keeps its mark
    once downloaded), so this resolves them against the library the same way
    ``/api/library/favourites`` does rather than reading the stored keys.
    """
    from player.favourites_manager import LIB_PREFIX

    lib = _library()
    tracks = getattr(lib.metadata, "tracks", None) or []
    owned = {track.id for track in tracks}
    by_youtube = {}
    for track in tracks:
        if getattr(track, "youtube_id", None):
            by_youtube.setdefault(track.youtube_id, track.id)

    starred: dict[str, str] = {}
    for entry in _favourites().get_favourite_entries():
        for key in entry.get("keys") or []:
            track_id = None
            if key.startswith(LIB_PREFIX) and key[len(LIB_PREFIX):] in owned:
                track_id = key[len(LIB_PREFIX):]
            elif key.startswith("yt:") and key[3:] in by_youtube:
                track_id = by_youtube[key[3:]]
            if track_id and track_id not in starred:
                starred[track_id] = serialize.iso(entry.get("added_at")) or serialize.iso(time.time())
                break
    return starred


def _measurements() -> dict[str, tuple[float, float]]:
    """Loudness readings for ReplayGain, or nothing if they cannot be read."""
    try:
        from shared.loudness import LoudnessStore

        return LoudnessStore().measured()
    except Exception:
        logger.debug("Subsonic: loudness measurements unavailable", exc_info=True)
        return {}


def _songs(tracks: list, *, starred: Optional[dict[str, str]] = None) -> list[dict[str, Any]]:
    """Serialize a list of tracks, resolving their per-track state in one query."""
    if not tracks:
        return []
    if starred is None:
        starred = _starred_track_ids()
    states = _db().get_track_user_states([track.id for track in tracks])
    measured = _measurements()
    return [
        serialize.song(
            track,
            state=states.get(track.id),
            starred_at=starred.get(track.id),
            measurement=measured.get(serialize.loudness_identity(track)),
        )
        for track in tracks
    ]


def _track_or_404(raw_id: str):
    from shared.api import get_track_by_id

    kind, identifier = serialize.parse_id(raw_id)
    if kind not in (None, "track"):
        raise SubsonicError(ERR_NOT_FOUND)
    track = get_track_by_id(_library(), identifier)
    if not track:
        raise SubsonicError(ERR_NOT_FOUND)
    return track


def _fully_starred_albums(starred: dict[str, str]) -> set[str]:
    """Albums every one of whose songs is starred.

    Counted in a single query rather than per album: a page of fifty albums
    would otherwise be fifty round trips to answer one boolean each.
    """
    if not starred:
        return set()
    held = _db().count_tracks_per_album(list(starred))
    return {
        str(row["id"])
        for row in _db().get_albums_by_ids(list(held))
        if held.get(str(row["id"])) == int(row["track_count"])
    }


def _albums(rows: list[dict[str, Any]], starred_albums: set[str], stamp: Optional[str]) -> list[dict[str, Any]]:
    return [
        serialize.album(row, starred_at=stamp if str(row["id"]) in starred_albums else None)
        for row in rows
    ]


def _starred_stamp(starred: dict[str, str]) -> Optional[str]:
    """One timestamp for a starred album: the oldest star it is made of."""
    stamps = [value for value in starred.values() if value]
    return min(stamps) if stamps else None


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------


@_endpoint("ping")
def ping():
    return {}


@_endpoint("getLicense")
def get_license():
    # Self-hosted and unlicensed by design; clients only check that it is valid.
    return {"license": {"valid": True}}


@_endpoint("getOpenSubsonicExtensions")
def get_open_subsonic_extensions():
    return {"openSubsonicExtensions": OPENSUBSONIC_EXTENSIONS}


@_endpoint("getUser")
def get_user():
    from shared.user_context import require_user_id
    from shared.users import get_user as load_user

    requested = (_param("username") or "").strip()
    me = load_user(require_user_id()) or {}
    if requested and requested.lower() != str(me.get("username", "")).lower():
        # One account may not enumerate another's settings.
        raise SubsonicError(ERR_NOT_FOUND)
    return {
        "user": {
            "username": me.get("username"),
            "email": None,
            "scrobblingEnabled": True,
            "adminRole": bool(me.get("role") == "admin"),
            "settingsRole": False,
            "downloadRole": True,
            "uploadRole": False,
            "playlistRole": True,
            "coverArtRole": True,
            "commentRole": False,
            "podcastRole": False,
            "streamRole": True,
            "jukeboxRole": False,
            "shareRole": False,
            "videoConversionRole": False,
            "folder": [MUSIC_FOLDER_ID],
        }
    }


@_endpoint("getScanStatus")
def get_scan_status():
    from shared.api.library_scan import library_scan_service
    from shared.user_context import require_user_id

    status = library_scan_service.status(require_user_id())
    active = status["state"] in {"queued", "scanning"}
    count = status["processed"] if active else len(getattr(_library().metadata, "tracks", []) or [])
    return {"scanStatus": {"scanning": active, "count": count}}


@_endpoint("startScan")
def start_scan():
    from shared.api.library_scan import library_scan_service
    from shared.user_context import require_user_id

    lib = _library()
    try:
        roots = library_scan_service.resolve_roots(lib)
    except ValueError as exc:
        raise SubsonicError(ERR_GENERIC, str(exc)) from exc
    status = library_scan_service.start(require_user_id(), roots)
    return {
        "scanStatus": {
            "scanning": status["state"] in {"queued", "scanning"},
            "count": status["processed"],
        }
    }


# ---------------------------------------------------------------------------
# Browsing
# ---------------------------------------------------------------------------


@_endpoint("getMusicFolders")
def get_music_folders():
    return {"musicFolders": {"musicFolder": [{"id": MUSIC_FOLDER_ID, "name": MUSIC_FOLDER_NAME}]}}


@_endpoint("getIndexes")
def get_indexes():
    payload = _artist_index()
    payload["lastModified"] = int(time.time() * 1000)
    return {"indexes": payload}


@_endpoint("getArtists")
def get_artists():
    return {"artists": _artist_index()}


def _artist_index() -> dict[str, Any]:
    rows = _db().get_artists()
    return {
        "ignoredArticles": serialize.IGNORED_ARTICLES,
        "index": serialize.indexed_artists(rows),
    }


@_endpoint("getArtist")
def get_artist():
    kind, identifier = serialize.parse_id(_required("id"))
    if kind not in (None, "artist"):
        raise SubsonicError(ERR_NOT_FOUND)
    db = _db()
    row = db.get_artist(identifier)
    if not row:
        raise SubsonicError(ERR_NOT_FOUND)
    starred = _starred_track_ids()
    albums = db.get_albums_by_artist_id(identifier)
    payload = serialize.artist(row)
    payload["album"] = _albums(albums, _fully_starred_albums(starred), _starred_stamp(starred))
    payload["albumCount"] = len(albums)
    return {"artist": payload}


@_endpoint("getArtistInfo2")
def get_artist_info2():
    # No biography provider is wired in yet. The element still has to exist:
    # clients that ask and get an error stop asking for anything else.
    return {"artistInfo2": {}}


@_endpoint("getAlbum")
def get_album():
    kind, identifier = serialize.parse_id(_required("id"))
    if kind not in (None, "album"):
        raise SubsonicError(ERR_NOT_FOUND)
    db = _db()
    row = db.get_album(identifier)
    if not row:
        raise SubsonicError(ERR_NOT_FOUND)
    starred = _starred_track_ids()
    tracks = db.get_tracks_by_album_id(identifier)
    payload = _albums([row], _fully_starred_albums(starred), _starred_stamp(starred))[0]
    payload["song"] = _songs(tracks, starred=starred)
    return {"album": payload}


@_endpoint("getAlbumInfo2")
def get_album_info2():
    return {"albumInfo": {}}


@_endpoint("getSong")
def get_song():
    track = _track_or_404(_required("id"))
    return {"song": _songs([track])[0]}


@_endpoint("getAlbumList2")
def get_album_list2():
    return {"albumList2": {"album": _album_list()}}


@_endpoint("getAlbumList")
def get_album_list():
    # The pre-ID3 spelling. Same rows, and clients that ask for it treat the
    # entries as directories rather than albums.
    albums = _album_list()
    for entry in albums:
        entry["isDir"] = True
        entry["parent"] = entry.get("artistId")
    return {"albumList": {"album": albums}}


def _album_list() -> list[dict[str, Any]]:
    list_type = (_param("type") or "alphabeticalByName").strip()
    size = max(1, min(500, _int_param("size", 10) or 10))
    offset = max(0, _int_param("offset", 0) or 0)
    db = _db()
    starred = _starred_track_ids()

    if list_type == "starred":
        album_ids = {
            catalog_id
            for catalog_id in (
                serialize.album_identity_for(track)
                for track in db.get_tracks_by_ids(list(starred))
            )
            if catalog_id
        }
        rows = db.get_albums_by_ids(sorted(album_ids))[offset:offset + size]
    else:
        rows = db.get_albums_page(
            list_type,
            size=size,
            offset=offset,
            genre=_param("genre"),
            from_year=_int_param("fromYear"),
            to_year=_int_param("toYear"),
        )
    return _albums(rows, _fully_starred_albums(starred), _starred_stamp(starred))


@_endpoint("getGenres")
def get_genres():
    return {
        "genres": {
            "genre": [
                {
                    TEXT_KEY: row["name"],
                    "songCount": int(row.get("song_count") or 0),
                    "albumCount": int(row.get("album_count") or 0),
                }
                for row in _db().get_genres()
            ]
        }
    }


@_endpoint("getSongsByGenre")
def get_songs_by_genre():
    tracks = _db().get_tracks_by_genre(
        _required("genre"),
        count=max(1, min(500, _int_param("count", 10) or 10)),
        offset=max(0, _int_param("offset", 0) or 0),
    )
    return {"songsByGenre": {"song": _songs(tracks)}}


@_endpoint("getRandomSongs")
def get_random_songs():
    tracks = _db().get_random_tracks(
        size=max(1, min(500, _int_param("size", 10) or 10)),
        genre=_param("genre"),
        from_year=_int_param("fromYear"),
        to_year=_int_param("toYear"),
    )
    return {"randomSongs": {"song": _songs(tracks)}}


@_endpoint("getStarred2")
def get_starred2():
    return {"starred2": _starred_payload()}


@_endpoint("getStarred")
def get_starred():
    return {"starred": _starred_payload()}


def _starred_payload() -> dict[str, Any]:
    starred = _starred_track_ids()
    tracks = _db().get_tracks_by_ids(list(starred))
    return {"song": _songs(tracks, starred=starred)}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@_endpoint("search3")
def search3():
    return {"searchResult3": _search_payload()}


@_endpoint("search2")
def search2():
    return {"searchResult2": _search_payload()}


def _search_payload() -> dict[str, Any]:
    query = (_param("query") or "").strip()
    # An empty query is how several clients ask for "everything"; the protocol
    # allows it and the LIKE below matches every row.
    db = _db()
    starred = _starred_track_ids()

    artists = db.search_artists(
        query,
        count=max(0, _int_param("artistCount", 20) or 0),
        offset=max(0, _int_param("artistOffset", 0) or 0),
    )
    albums = db.search_albums(
        query,
        count=max(0, _int_param("albumCount", 20) or 0),
        offset=max(0, _int_param("albumOffset", 0) or 0),
    )
    tracks = db.search_music_tracks(
        query,
        count=max(0, _int_param("songCount", 20) or 0),
        offset=max(0, _int_param("songOffset", 0) or 0),
    )
    return {
        "artist": [serialize.artist(row) for row in artists],
        "album": _albums(albums, _fully_starred_albums(starred), _starred_stamp(starred)),
        "song": _songs(tracks, starred=starred),
    }


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------


def _playable_path(track) -> str:
    path = resolve_local_track_path(track)
    if not path:
        raise SubsonicError(ERR_NOT_FOUND, "Track has no local file")
    path = os.path.normpath(os.path.abspath(os.path.expanduser(path)))
    if not os.path.exists(path):
        raise SubsonicError(ERR_NOT_FOUND, "Track file is missing")
    from shared.api import is_trusted_network

    if not is_safe_path(path, is_trusted=is_trusted_network(request.remote_addr)):
        raise SubsonicError(ERR_NOT_FOUND)
    return path


def _send_original(track, path: str) -> Response:
    suffix = os.path.splitext(path)[1].lower().lstrip(".")
    mimetype = _AUDIO_MIMETYPES.get(suffix) or _mimetypes.guess_type(path)[0] or "audio/mpeg"
    response = send_file(path, mimetype=mimetype, conditional=True)
    response.headers["Cache-Control"] = (
        "private, no-cache"
        if is_scanned_track_path(track, path)
        else "private, max-age=86400"
    )
    return response


@_endpoint("stream")
def stream():
    track = _track_or_404(_required("id"))
    path = _playable_path(track)
    requested_format = _param("format")
    max_bitrate = _int_param("maxBitRate") or 0
    time_offset = max(0, _int_param("timeOffset", 0) or 0)

    if not transcode.should_transcode(
        source_format=track.format,
        source_bitrate=track.bitrate,
        requested_format=requested_format,
        max_bitrate=max_bitrate,
    ):
        return _send_original(track, path)

    target = transcode.normalize_format(requested_format) or transcode.DEFAULT_FORMAT
    bitrate = max_bitrate or track.bitrate or 192
    started = transcode.stream_transcoded(
        path, target_format=target, bitrate_kbps=bitrate, time_offset=time_offset
    )
    if started is None:
        return _send_original(track, path)

    chunks, mimetype = started
    response = Response(stream_with_context(chunks), mimetype=mimetype)
    # A transcode has no length and no byte ranges. Subsonic seeks it by asking
    # again with `timeOffset`, so saying so plainly is the correct answer rather
    # than a limitation to paper over.
    response.headers["Accept-Ranges"] = "none"
    response.headers["Cache-Control"] = "no-store"
    if _bool_param("estimateContentLength"):
        estimate = transcode.estimated_length(track.duration, bitrate, time_offset)
        if estimate:
            response.headers["Content-Length"] = str(estimate)
    return response


@_endpoint("download")
def download():
    track = _track_or_404(_required("id"))
    path = _playable_path(track)
    response = send_file(path, mimetype="application/octet-stream", conditional=True, as_attachment=True)
    response.headers["Cache-Control"] = (
        "private, no-cache"
        if is_scanned_track_path(track, path)
        else "private, max-age=86400"
    )
    return response


@_endpoint("getCoverArt")
def get_cover_art():
    kind, identifier = serialize.parse_id(_required("id"))
    db = _db()

    if kind == "album":
        tracks = db.get_tracks_by_album_id(identifier)
        track = tracks[0] if tracks else None
    elif kind == "artist":
        tracks = db.get_tracks_by_artist_id(identifier)
        track = tracks[0] if tracks else None
    else:
        from shared.api import get_track_by_id

        track = get_track_by_id(_library(), identifier)

    if track is None:
        raise SubsonicError(ERR_NOT_FOUND)

    path = _cover_path(track)
    if not path:
        raise SubsonicError(ERR_NOT_FOUND, "No cover art for this item")
    response = send_file(path, mimetype="image/jpeg", conditional=True)
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


def _cover_path(track) -> Optional[str]:
    """A cover on disk for this track, extracting an embedded one if needed."""
    from player.cover_manager import CoverFetchManager

    path = _library().get_cover_url(track)
    if path and os.path.exists(path):
        return path
    return CoverFetchManager.get_instance().extract_now(track, resolve_local_track_path(track))


@_endpoint("getLyrics")
def get_lyrics():
    from shared.lyrics import poll_lyrics

    artist = (_param("artist") or "").strip()
    title = (_param("title") or "").strip()
    if not artist or not title:
        return {"lyrics": {}}
    status, record = poll_lyrics(artist, title, None, None)
    text = (record or {}).get("plain") if status == "complete" else None
    if not text:
        return {"lyrics": {}}
    return {"lyrics": {"artist": artist, "title": title, TEXT_KEY: text}}


@_endpoint("getLyricsBySongId")
def get_lyrics_by_song_id():
    from shared.database import instance_db

    track = _track_or_404(_required("id"))
    cached = instance_db().get_lyrics(track.id)
    if not cached:
        return {"lyricsList": {}}

    lines = _synced_lines(cached.get("synced"))
    if lines:
        structured = {"synced": True, "line": lines}
    elif cached.get("plain"):
        structured = {
            "synced": False,
            "line": [{TEXT_KEY: line} for line in str(cached["plain"]).splitlines() if line.strip()],
        }
    else:
        return {"lyricsList": {}}

    structured.update({"displayArtist": track.artist, "displayTitle": track.title})
    return {"lyricsList": {"structuredLyrics": [structured]}}


def _synced_lines(synced: Any) -> list[dict[str, Any]]:
    """LRC text as the timed lines OpenSubsonic asks for, milliseconds and all."""
    if not synced or not isinstance(synced, str):
        return []
    from shared.lyrics import parse_lrc

    lines = []
    for offset_ms, text in parse_lrc(synced):
        if text.strip():
            lines.append({"start": int(offset_ms), TEXT_KEY: text})
    return lines


# ---------------------------------------------------------------------------
# Annotation
# ---------------------------------------------------------------------------


def _annotated_track_ids() -> list[str]:
    """The tracks one star/unstar call names, however the client spelled it."""
    db = _db()
    ids: list[str] = []
    for key in ("id", "albumId", "artistId"):
        for raw in request.values.getlist(key):
            kind, identifier = serialize.parse_id(raw)
            if kind == "album" or key == "albumId":
                ids.extend(track.id for track in db.get_tracks_by_album_id(identifier))
            elif kind == "artist" or key == "artistId":
                ids.extend(track.id for track in db.get_tracks_by_artist_id(identifier))
            else:
                ids.append(identifier)
    return list(dict.fromkeys(ids))


def _set_starred(starred: bool):
    """A star is the same mark the player calls a favourite — not a second list."""
    from shared.api import emit_to_user

    track_ids = _annotated_track_ids()
    if not track_ids:
        raise SubsonicError(ERR_MISSING_PARAMETER, "Required parameter 'id' is missing")

    favourites = _favourites()
    for track_id in track_ids:
        if starred:
            favourites.add(track_id)
        else:
            favourites.remove(track_id)
    emit_to_user("favourites_updated")
    return {}


@_endpoint("star")
def star():
    return _set_starred(True)


@_endpoint("unstar")
def unstar():
    return _set_starred(False)


@_endpoint("setRating")
def set_rating():
    track = _track_or_404(_required("id"))
    rating = _int_param("rating")
    if rating is None or not 0 <= rating <= 5:
        raise SubsonicError(ERR_GENERIC, "Parameter 'rating' must be between 0 and 5")
    # Subsonic clears a rating with 0; the store spells "no rating" as NULL.
    _db().set_track_rating(track.id, rating or None)
    return {}


@_endpoint("scrobble")
def scrobble():
    if _bool_param("submission", True) is False:
        # A "now playing" notification, not a play. Nothing here listens for
        # one yet, and counting it would inflate every play count by one.
        return {}
    played_at = _int_param("time")
    when = int(played_at / 1000) if played_at and played_at > 10_000_000_000 else (played_at or int(time.time()))
    db = _db()
    for raw in request.values.getlist("id") or []:
        _, identifier = serialize.parse_id(raw)
        db.record_track_play(identifier, when)
    return {}


# ---------------------------------------------------------------------------
# Playlists
# ---------------------------------------------------------------------------


def _playlist_payload(name: str, track_ids: list[str], *, with_songs: bool = False) -> dict[str, Any]:
    from shared.user_context import require_user_id
    from shared.users import get_user as load_user

    tracks = _db().get_tracks_by_ids(track_ids)
    owner = load_user(require_user_id()) or {}
    payload: dict[str, Any] = {
        "id": name,
        "name": name,
        "owner": owner.get("username"),
        "public": False,
        "songCount": len(tracks),
        "duration": sum(int(track.duration or 0) for track in tracks),
    }
    if with_songs:
        payload["entry"] = _songs(tracks)
    return payload


@_endpoint("getPlaylists")
def get_playlists():
    metadata = _library().metadata
    playlists = getattr(metadata, "playlists", None) or {}
    return {
        "playlists": {
            "playlist": [_playlist_payload(name, list(ids)) for name, ids in playlists.items()]
        }
    }


@_endpoint("getPlaylist")
def get_playlist():
    name = _required("id")
    playlists = getattr(_library().metadata, "playlists", None) or {}
    if name not in playlists:
        raise SubsonicError(ERR_NOT_FOUND)
    return {"playlist": _playlist_payload(name, list(playlists[name]), with_songs=True)}


def _save_playlists(lib):
    from shared.api import emit_to_user

    lib._save_metadata()
    emit_to_user("library_updated")


@_endpoint("createPlaylist")
def create_playlist():
    lib = _library()
    metadata = lib.metadata
    if metadata is None:
        raise SubsonicError(ERR_GENERIC, "Library not loaded")

    existing = (_param("playlistId") or "").strip()
    name = (_param("name") or "").strip() or existing
    if not name:
        raise SubsonicError(ERR_MISSING_PARAMETER, "Required parameter 'name' is missing")

    track_ids = [serialize.parse_id(raw)[1] for raw in request.values.getlist("songId")]
    if existing and existing in metadata.playlists:
        metadata.set_playlist_tracks(existing, track_ids)
        if name != existing:
            metadata.rename_playlist(existing, name)
    else:
        metadata.create_playlist(name, track_ids)
    _save_playlists(lib)
    return {"playlist": _playlist_payload(name, track_ids, with_songs=True)}


@_endpoint("updatePlaylist")
def update_playlist():
    lib = _library()
    metadata = lib.metadata
    name = _required("playlistId")
    if metadata is None or name not in metadata.playlists:
        raise SubsonicError(ERR_NOT_FOUND)

    for raw in request.values.getlist("songIdToAdd"):
        metadata.add_to_playlist(name, serialize.parse_id(raw)[1])
    # Indices are into the list as it was received, so they are applied from the
    # end: removing index 2 first would shift every later index by one.
    for index in sorted((int(value) for value in request.values.getlist("songIndexToRemove")), reverse=True):
        ids = metadata.playlists.get(name) or []
        if 0 <= index < len(ids):
            metadata.remove_from_playlist(name, ids[index])

    new_name = (_param("name") or "").strip()
    if new_name and new_name != name:
        metadata.rename_playlist(name, new_name)
        name = new_name
    _save_playlists(lib)
    return {}


@_endpoint("deletePlaylist")
def delete_playlist():
    lib = _library()
    metadata = lib.metadata
    name = _required("id")
    if metadata is None or not metadata.delete_playlist(name):
        raise SubsonicError(ERR_NOT_FOUND)
    _save_playlists(lib)
    return {}


# ---------------------------------------------------------------------------


@subsonic_bp.route("/<path:method>", methods=["GET", "POST"])
def unknown_method(method: str):
    """Anything else, in the protocol's own words rather than an HTML 404.

    A client that gets Flask's 404 page reports the server as unreachable; one
    that gets this reports the single call it could not make and carries on.
    """
    return respond(error=SubsonicError(ERR_GENERIC, f"Unknown method '{method}'"))


__all__ = ["subsonic_bp", "API_VERSION"]
