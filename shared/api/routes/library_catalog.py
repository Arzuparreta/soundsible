"""Browsing the normalized catalog: albums, artists, genres and years.

`GET /api/library` answers "what is in this library" with the flat manifest, and
that is the right shape for a track list. It is the wrong shape for a *structure*:
deciding which release a track belongs to means knowing that a compilation is
filed under Various Artists, that two records may share a title, and that only
`Track.artists` can name several performers. `shared/library_catalog.py` is the
single place those rules live, `library.db` stores the result, and this blueprint
hands it to the player — the same rows, in the same order, that a Subsonic client
already browses through `/rest`.

Entities travel with a list of track ids rather than whole tracks. The player
already holds every track it can play, keyed by id, with its favourite mark,
loudness reading and download state attached; sending a second copy here would
be a second answer to a question that already has one.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from flask import Blueprint, jsonify, request

logger = logging.getLogger(__name__)

library_catalog_bp = Blueprint("library_catalog", __name__, url_prefix="")

#: The default grid: every album, alphabetically. Named here so the route and
#: the player agree on what "no sort asked for" means.
DEFAULT_ALBUM_SORT = "alphabeticalByName"


class _CatalogUnavailable(RuntimeError):
    """The account has no readable SQLite index right now."""


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
        raise _CatalogUnavailable("Library index unavailable")
    return lib.db


def _int_param(name: str) -> Optional[int]:
    """A query integer, or None when absent or unparseable.

    Unparseable is deliberately not an error: a filter nobody can honour is
    better dropped than turned into a 400 that empties the user's screen.
    """
    raw = (request.args.get(name) or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _album(row: dict[str, Any]) -> dict[str, Any]:
    """One catalog album row as the player reads it.

    A projection rather than a pass-through: `_albums_query` also carries the
    aggregates Subsonic needs (`average_rating`, `play_count`), and shipping the
    raw row would make every one of them a promise to the client.
    """
    return {
        "id": str(row["id"]),
        "title": row.get("title") or row.get("album") or "",
        "album_artist": row.get("album_artist") or "",
        "album_artist_id": row.get("album_artist_id"),
        "year": row.get("year"),
        "genre": row.get("genre"),
        "is_compilation": bool(row.get("is_compilation")),
        "track_count": int(row.get("track_count") or 0),
        "duration": int(row.get("duration") or 0),
        "cover_track_id": row.get("cover_track_id"),
    }


def _artist(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row.get("name") or "",
        "track_count": int(row.get("track_count") or 0),
        "album_count": int(row.get("album_count") or 0),
        "cover_track_id": row.get("cover_track_id"),
    }


@library_catalog_bp.errorhandler(_CatalogUnavailable)
def _catalog_unavailable(error: _CatalogUnavailable):
    # 503 rather than 500: the library is being built or reloaded, and asking
    # again in a moment is the correct thing for a client to do.
    return jsonify({"error": str(error)}), 503


@library_catalog_bp.route("/api/library/albums", methods=["GET"])
def list_albums():
    """The album grid, ordered and filtered the way the player asked.

    `sort` is validated against the same table `getAlbumList2` uses, so the two
    surfaces either order albums identically or not at all — there is no third
    ordering that exists only here.
    """
    from shared.database import DatabaseManager

    sort = (request.args.get("sort") or DEFAULT_ALBUM_SORT).strip()
    if sort not in DatabaseManager.ALBUM_ORDERINGS:
        return jsonify({"error": f"unknown sort: {sort}"}), 400

    genre = (request.args.get("genre") or "").strip() or None
    from_year, to_year = _int_param("from_year"), _int_param("to_year")
    # A bare `year=` is the common case from the player, and the underlying
    # ordering wants a range. One year is the range that starts and ends there.
    year = _int_param("year")
    if year is not None and from_year is None and to_year is None:
        from_year = to_year = year

    # A genre or a year is a filter on the grid, not a change of sort order —
    # but the SQL that can filter on them lives under those two list types.
    if genre and sort != "byGenre":
        sort = "byGenre"
    elif (from_year is not None or to_year is not None) and sort != "byYear":
        sort = "byYear"
    if sort == "byYear":
        # An open-ended range still has to be a range downstream.
        from_year = from_year if from_year is not None else 0
        to_year = to_year if to_year is not None else 9999

    limit = _int_param("limit")
    offset = _int_param("offset") or 0
    rows = _db().get_albums_page(
        sort,
        size=limit,
        offset=offset,
        genre=genre,
        from_year=from_year,
        to_year=to_year,
    )
    return jsonify({"albums": [_album(row) for row in rows], "sort": sort})


@library_catalog_bp.route("/api/library/albums/<album_id>", methods=["GET"])
def get_album(album_id: str):
    db = _db()
    row = db.get_album(album_id)
    if not row:
        return jsonify({"error": "Album not found"}), 404
    tracks = db.get_tracks_by_album_id(album_id)
    return jsonify({"album": _album(row), "track_ids": [track.id for track in tracks]})


@library_catalog_bp.route("/api/library/artists", methods=["GET"])
def list_artists():
    """Every artist with something to their name.

    The catalog also holds album artists who perform on nothing — "Various
    Artists" being the one every library has. They are real rows, and a grid of
    faces is not where they belong.
    """
    rows = [row for row in _db().get_artists() if int(row.get("track_count") or 0) > 0]
    return jsonify({"artists": [_artist(row) for row in rows]})


@library_catalog_bp.route("/api/library/artists/<artist_id>", methods=["GET"])
def get_artist(artist_id: str):
    db = _db()
    row = db.get_artist(artist_id)
    if not row:
        return jsonify({"error": "Artist not found"}), 404
    tracks = db.get_tracks_by_artist_id(artist_id)
    albums = db.get_albums_by_artist_id(artist_id)
    return jsonify({
        "artist": _artist(row),
        "albums": [_album(album) for album in albums],
        "track_ids": [track.id for track in tracks],
    })


@library_catalog_bp.route("/api/library/genres", methods=["GET"])
def list_genres():
    return jsonify({
        "genres": [
            {
                "name": row.get("name") or "",
                "song_count": int(row.get("song_count") or 0),
                "album_count": int(row.get("album_count") or 0),
            }
            for row in _db().get_genres()
        ]
    })


@library_catalog_bp.route("/api/library/years", methods=["GET"])
def list_years():
    return jsonify({
        "years": [
            {
                "year": int(row["year"]),
                "album_count": int(row.get("album_count") or 0),
                "track_count": int(row.get("track_count") or 0),
            }
            for row in _db().get_years()
        ]
    })
