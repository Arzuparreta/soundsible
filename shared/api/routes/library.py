"""
Library, metadata, playlists, favourites, and cover routes.
"""

import json
import logging
import os
import tempfile
from urllib.parse import unquote

from flask import Blueprint, request, jsonify
from shared.hardening import SCOPE_ADMIN_DANGEROUS, SCOPE_LIBRARY_WRITE, rate_limit, require_scope
from shared.user_context import require_user_id

from shared.loudness import annotate_tracks
from shared.path_resolver import resolve_local_track_path
from odst_tool.audio_utils import download_image

logger = logging.getLogger(__name__)

library_bp = Blueprint("library", __name__, url_prefix="")


def _lyrics_payload(record=None, *, cached=False, status=None, source_kind=None):
    from shared.music_identity import synced_lyrics_safe

    if status is None:
        status = (
            "ready"
            if record and (record.get("synced") or record.get("plain") or record.get("instrumental"))
            else "not_found"
        )
    synced = record.get("synced") if record else None
    timing_safe = source_kind is None or synced_lyrics_safe(str(source_kind))
    payload = {
        "status": status,
        "synced": synced if timing_safe else None,
        "plain": record.get("plain") if record else None,
        "instrumental": bool(record and record.get("instrumental")),
        "cached": cached,
        "pending": status == "pending",
    }
    if source_kind is not None:
        payload["timing_safe"] = timing_safe
    return payload


def _playlist_mutation_response(metadata, status: str = "success"):
    """Stable shape for web client: playlists plus library settings (e.g. playlist_covers)."""
    return jsonify({"status": status, "playlists": metadata.playlists, "settings": metadata.settings})


def _get_api():
    """Lazy import from shared.api to avoid circular imports; returns a dict of core helpers and singletons."""
    from shared.api import (
        get_core,
        get_track_by_id,
        _mark_track_metadata_updated,
        _ensure_lib_metadata,
        socketio,
        get_downloader,
        get_favourites_manager,
        favourite_library_ids,
        emit_to_user,
        is_trusted_network,
    )
    from shared.models import LibraryMetadata
    return {
        "get_core": get_core,
        "get_track_by_id": get_track_by_id,
        "_mark_track_metadata_updated": _mark_track_metadata_updated,
        "_ensure_lib_metadata": _ensure_lib_metadata,
        "socketio": socketio,
        "emit_to_user": emit_to_user,
        "get_downloader": get_downloader,
        "favourites_manager": get_favourites_manager(),
        "favourite_library_ids": favourite_library_ids,
        "is_trusted_network": is_trusted_network,
        "LibraryMetadata": LibraryMetadata,
    }


@library_bp.route("/api/library", methods=["GET"])
def get_library():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    if lib.metadata:
        payload = json.loads(lib.metadata.to_json())
        # Loudness rides the library the player already fetches, so levelling
        # costs no extra request and is available before the first track loads.
        annotate_tracks(payload.get("tracks") or [])
        return jsonify(payload)
    return jsonify({"error": "Library not loaded"}), 404


@library_bp.route("/api/library/youtube-ids", methods=["GET"])
def get_library_youtube_ids():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    if not lib.metadata:
        return jsonify({"youtube_ids": [], "youtube_to_track_id": {}})
    youtube_ids = []
    youtube_to_track_id = {}
    for t in lib.metadata.tracks:
        yt_id = getattr(t, "youtube_id", None)
        if yt_id and isinstance(yt_id, str) and len(yt_id) == 11:
            youtube_ids.append(yt_id)
            youtube_to_track_id[yt_id] = t.id
    return jsonify({"youtube_ids": youtube_ids, "youtube_to_track_id": youtube_to_track_id})


@library_bp.route("/api/library/sync", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_sync", limit=20, window_sec=60)
def sync_library():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    success = lib.sync_library()
    if success:
        api["emit_to_user"]("library_updated")
    return jsonify({"status": "success" if success else "failed"})


@library_bp.route("/api/library/scan", methods=["GET"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_scan_status", limit=120, window_sec=60)
def library_scan_status():
    from shared.api.library_scan import library_scan_service

    return jsonify(library_scan_service.status(require_user_id()))


@library_bp.route("/api/library/scan", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_scan_start", limit=20, window_sec=60)
def start_library_scan():
    from shared.api.library_scan import library_scan_service

    api = _get_api()
    library, _, _ = api["get_core"]()
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "request body must be an object", "code": "invalid_scan_path"}), 400
    requested_path = data.get("path")
    if requested_path is not None and not isinstance(requested_path, str):
        return jsonify({"error": "path must be a string", "code": "invalid_scan_path"}), 400
    try:
        roots = library_scan_service.resolve_roots(library, requested_path)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid_scan_path"}), 400
    return jsonify(library_scan_service.start(require_user_id(), roots)), 202


@library_bp.route("/api/library/tracks/<track_id>", methods=["DELETE"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_delete_track", limit=30, window_sec=60)
def delete_track_from_library(track_id):
    api = _get_api()
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    logger.info("API: Deleting track %s (%s)...", track.title, track_id)
    success = lib.delete_track(track)
    if success:
        # Note: Also remove from the ODST downloader's library (OUTPUT_DIR/library.json).
        # sync_library() reads that file on startup; if we don't update it here the track
        # reappears on every restart because that file is never touched by _save_metadata().
        try:
            dl = api["get_downloader"](open_browser=False)
            if dl and dl.library and dl.library.remove_track(track_id):
                dl.save_library()
                logger.info("API: Track %s also removed from ODST library.", track_id)
        except Exception as e:
            logger.warning("API: Could not remove track from ODST library (non-fatal): %s", e)
        api["emit_to_user"]("library_updated")
        return jsonify({"status": "success"})
    return jsonify({"error": "Deletion failed"}), 500


@library_bp.route("/api/library/wipe", methods=["POST"])
@require_scope(SCOPE_ADMIN_DANGEROUS, allow_trusted_network=True)
@rate_limit("library_wipe", limit=3, window_sec=300)
def wipe_library():
    api = _get_api()
    data = request.get_json(silent=True) or {}
    if data.get("confirm") not in ("CONFIRM", "confirm"):
        return jsonify({"error": "Body must include confirm: 'CONFIRM' or 'confirm'"}), 400
    try:
        lib, _, _ = api["get_core"]()
        success = lib.nuke_library()
        if not success:
            return jsonify({"error": "Wipe failed"}), 500
        try:
            dl = api["get_downloader"](open_browser=False)
            dl.library = api["LibraryMetadata"](version=1, tracks=[], playlists={}, settings={})
            dl.save_library()
            logger.info("API: ODST library wiped at %s", dl.output_dir)
        except Exception as e:
            logger.warning("API: ODST library wipe (non-fatal): %s", e)
        api["emit_to_user"]("library_updated")
        return jsonify({"status": "success"})
    except Exception as e:
        logger.exception("API: Library wipe error: %s", e)
        return jsonify({"error": "Wipe failed"}), 500


@library_bp.route("/api/library/search", methods=["GET"])
def search_library():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    query = request.args.get("q", "").lower()
    results = lib.search(query)
    tracks = [t.to_dict() for t in results[:50]]
    annotate_tracks(tracks)
    return jsonify(tracks)


@library_bp.route("/api/library/purge-missing", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_purge_missing", limit=10, window_sec=300)
def purge_missing_library_tracks():
    """
    Remove library entries for tracks whose audio files no longer exist locally
    (and, if a cloud provider is configured, have no corresponding remote object).
    Restricted to trusted networks (Home/Tailscale).
    """
    api = _get_api()
    lib, _, _ = api["get_core"]()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    if not lib.metadata:
        return jsonify({"error": "Library not loaded"}), 404

    summary = lib.purge_missing_tracks()
    api["emit_to_user"]("library_updated")
    return jsonify({"status": "success", **summary})


@library_bp.route("/api/library/tracks/<track_id>/lyrics", methods=["GET"])
@rate_limit("library_lyrics", limit=60, window_sec=60)
def get_track_lyrics(track_id):
    """Lyrics for a library track: served from the local cache when present,
    otherwise fetched from LRCLIB and cached (including not-found results)."""
    from shared.database import instance_db
    from shared.lyrics import poll_lyrics

    api = _get_api()
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404

    db = instance_db()
    refresh = request.args.get("refresh") in ("1", "true")
    if not refresh:
        cached = db.get_lyrics(track_id)
        if cached:
            return jsonify(_lyrics_payload(cached, cached=True))

    lookup_status, record = poll_lyrics(track.artist, track.title, track.album, track.duration)
    if lookup_status != "complete":
        return jsonify(_lyrics_payload(status="pending")), 202
    if record is None:
        # Provider unreachable: don't cache, let a later request retry.
        return jsonify(_lyrics_payload(status="unavailable"))
    db.set_lyrics(
        track_id,
        synced=record["synced"],
        plain=record["plain"],
        instrumental=record["instrumental"],
        source=record["source"],
    )
    return jsonify(_lyrics_payload(record))


@library_bp.route("/api/lyrics", methods=["GET"])
@rate_limit("lyrics_lookup", limit=60, window_sec=60)
def get_lyrics_by_metadata():
    """Lyrics lookup by metadata, for tracks not in the library (previews).
    Saved previews may opt into a persistent cache keyed by their normalized
    metadata; cold provider work runs through the bounded coordinator."""
    from shared.database import instance_db
    from shared.lyrics import metadata_cache_key, poll_lyrics

    artist = (request.args.get("artist") or "").strip()
    title = (request.args.get("title") or "").strip()
    album = (request.args.get("album") or "").strip() or None
    source_kind = (request.args.get("source_kind") or "").strip() or None
    try:
        duration = int(request.args.get("duration") or 0) or None
    except ValueError:
        duration = None
    if not artist or not title:
        return jsonify({"error": "artist and title are required"}), 400

    persist = request.args.get("persist") in ("1", "true")
    refresh = request.args.get("refresh") in ("1", "true")
    db = instance_db()
    cache_key = metadata_cache_key(artist, title, album, duration)
    if persist and not refresh:
        cached = db.get_lyrics(cache_key)
        if cached:
            return jsonify(_lyrics_payload(cached, cached=True, source_kind=source_kind))

    lookup_status, record = poll_lyrics(artist, title, album, duration)
    if lookup_status != "complete":
        return jsonify(_lyrics_payload(status="pending")), 202
    if record is None:
        return jsonify(_lyrics_payload(status="unavailable"))
    if persist:
        db.set_lyrics(
            cache_key,
            synced=record["synced"],
            plain=record["plain"],
            instrumental=record["instrumental"],
            source=record["source"],
        )
    return jsonify(_lyrics_payload(record, source_kind=source_kind))


@library_bp.route("/api/library/tracks/<track_id>/metadata", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_update_metadata", limit=60, window_sec=60)
def update_track_metadata(track_id):
    api = _get_api()
    lib, _, _ = api["get_core"]()
    data = request.json
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    cover_url = data.get("cover_url")
    cover_path = None
    if cover_url:
        logger.info("API: Downloading cover from %s...", cover_url)
        img_data = download_image(cover_url)
        if img_data:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                tmp.write(img_data)
                cover_path = tmp.name
    clear_cover = data.get("clear_cover", False)
    new_meta = {
        "title": data.get("title", track.title),
        "artist": data.get("artist", track.artist),
        "album": data.get("album", track.album),
        "album_artist": data.get("album_artist", track.album_artist),
    }
    success = lib.update_track(track, new_meta, cover_path if not clear_cover else None)
    if cover_path and os.path.exists(cover_path):
        os.remove(cover_path)
    if success:
        cover_source = "none" if clear_cover else ("youtube" if cover_url and ("youtube.com" in cover_url or "youtu.be" in cover_url) else "manual" if cover_url else None)
        api["_mark_track_metadata_updated"](lib, track_id, cover_source=cover_source)
        return jsonify({"status": "success"})
    # Note: Metadata-only fallback for manual text edits when file-level reprocessing fails.
    # This keeps user edits usable in the library UI even if the source audio file is
    # temporarily unavailable from cache/provider.
    if not cover_url and not clear_cover:
        track.title = str(new_meta.get("title", track.title) or "")
        track.artist = str(new_meta.get("artist", track.artist) or "")
        track.album = str(new_meta.get("album", track.album) or "")
        track.album_artist = str(new_meta.get("album_artist", track.album_artist) or "") if new_meta.get("album_artist", None) is not None else track.album_artist
        api["_mark_track_metadata_updated"](lib, track_id, cover_source=None)
        logger.warning("Metadata file rewrite failed for %s; applied metadata-only fallback.", track_id)
        return jsonify({"status": "success", "fallback": "metadata_only"})
    return jsonify({"error": "Failed to update track"}), 500


@library_bp.route("/api/library/tracks/<track_id>/cover", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_upload_cover", limit=30, window_sec=60)
def upload_track_cover(track_id):
    api = _get_api()
    if "file" not in request.files:
        return jsonify({"error": "No file part"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No selected file"}), 400
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1]) as tmp:
        file.save(tmp.name)
        cover_path = tmp.name
    success = lib.update_track(track, {}, cover_path)
    if os.path.exists(cover_path):
        os.remove(cover_path)
    if success:
        api["_mark_track_metadata_updated"](lib, track_id, cover_source="manual")
        return jsonify({"status": "success"})
    return jsonify({"error": "Failed to update cover"}), 500


@library_bp.route("/api/library/tracks/<track_id>/cover/from-track", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_copy_cover", limit=30, window_sec=60)
def copy_track_cover(track_id):
    api = _get_api()
    lib, _, _ = api["get_core"]()
    data = request.json or {}
    source_track_id = data.get("source_track_id")
    if not source_track_id:
        return jsonify({"error": "source_track_id required"}), 400
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    source_track = api["get_track_by_id"](lib, source_track_id)
    if not source_track:
        return jsonify({"error": "Source track not found"}), 404
    source_local_path = resolve_local_track_path(source_track)
    if not source_local_path:
        return jsonify({"error": "Source track file not found"}), 404
    try:
        from setup_tool.audio import AudioProcessor
        cover_data = AudioProcessor.extract_cover_art(source_local_path)
        if not cover_data:
            return jsonify({"error": "No cover art found in source track"}), 404
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
            tmp.write(cover_data)
            cover_path = tmp.name
        success = lib.update_track(track, {}, cover_path)
        if os.path.exists(cover_path):
            os.remove(cover_path)
        if success:
            api["_mark_track_metadata_updated"](lib, track_id, cover_source="manual")
            return jsonify({"status": "success"})
        return jsonify({"error": "Failed to update cover"}), 500
    except Exception as e:
        return jsonify({"error": f"Failed to copy cover: {str(e)}"}), 500


@library_bp.route("/api/library/tracks/<track_id>/cover/none", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_clear_cover", limit=30, window_sec=60)
def clear_track_cover(track_id):
    api = _get_api()
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    try:
        from PIL import Image
        placeholder = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
            placeholder.save(tmp.name, "PNG")
            placeholder_path = tmp.name
        success = lib.update_track(track, {}, placeholder_path)
        if os.path.exists(placeholder_path):
            os.remove(placeholder_path)
        if success:
            api["_mark_track_metadata_updated"](lib, track_id, cover_source="none")
            return jsonify({"status": "success"})
        return jsonify({"error": "Failed to clear cover"}), 500
    except ImportError:
        api["_mark_track_metadata_updated"](lib, track_id, cover_source="none")
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": f"Failed to clear cover: {str(e)}"}), 500


@library_bp.route("/api/library/favourites", methods=["GET"])
def get_favourites():
    """Favourite **library** track ids. Stable contract for agents and the car UI.

    Resolved against the library rather than read straight off the stored `lib:`
    keys, so a song favourited as a preview and downloaded later shows up here
    the moment it lands.
    """
    api = _get_api()
    api["get_core"]()
    return jsonify(api["favourite_library_ids"]())


@library_bp.route("/api/library/favourites/entries", methods=["GET"])
def get_favourite_entries():
    """The favourites list — identity keys plus the snapshot needed to render
    and stream a song that is not downloaded. Newest first."""
    api = _get_api()
    api["get_core"]()
    return jsonify(
        {"version": 2, "favourites": api["favourites_manager"].get_favourite_entries()}
    )


@library_bp.route("/api/library/saved", methods=["GET"])
def get_saved_entries():
    """Every song in this account's library that is not (or not only) a file:
    identity keys, snapshot, and whether it is marked a favourite. Newest first.

    The player unions this with the scanned library to draw one collection —
    a saved song streams until a download gives it a file, and nothing about
    the entry changes when that happens.
    """
    api = _get_api()
    api["get_core"]()
    return jsonify({"version": 3, "saved": api["favourites_manager"].get_entries()})


@library_bp.route("/api/library/saved/toggle", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_toggle_saved", limit=120, window_sec=60)
def toggle_saved():
    """Add or remove a song from the library by identity (`entry`), no file involved."""
    api = _get_api()
    api["get_core"]()
    data = request.json or {}
    entry = data.get("entry") or data.get("saved")
    if not isinstance(entry, dict):
        return jsonify({"error": "entry must be an object"}), 400

    try:
        is_saved = api["favourites_manager"].toggle_saved(entry)
    except ValueError:
        return jsonify({"error": "entry needs at least one identity key"}), 400
    if is_saved:
        _schedule_favourite_resolve(entry)

    api["emit_to_user"]("favourites_updated")
    return jsonify({"status": "success", "is_saved": is_saved})


@library_bp.route("/api/library/favourites/toggle", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_toggle_favourite", limit=120, window_sec=60)
def toggle_favourite():
    """Toggle the favourite mark, by identity (`favourite`) or library id (`track_id`).

    Marking a song the library does not hold saves it in the same act — you
    cannot single out a song you do not have. Unmarking leaves it saved.
    """
    api = _get_api()
    api["get_core"]()
    data = request.json or {}
    favourite = data.get("favourite")
    manager = api["favourites_manager"]

    if isinstance(favourite, dict):
        try:
            is_fav = manager.set_favourite(favourite)
        except ValueError:
            return jsonify({"error": "favourite needs at least one identity key"}), 400
        if is_fav:
            _schedule_favourite_resolve(favourite)
    else:
        track_id = data.get("track_id")
        if not track_id:
            return jsonify({"error": "No track_id provided"}), 400
        is_fav = manager.toggle(track_id)

    # Other devices on this account would otherwise not see the change until a
    # full library sync — every other mutating route here already emits.
    api["emit_to_user"]("favourites_updated")
    return jsonify({"status": "success", "is_favourite": is_fav, "is_fav": is_fav})


def _schedule_favourite_resolve(favourite: dict) -> None:
    """
    Give a favourite a playable identity in the background.

    A Deezer/MusicBrainz row saved without ever being played carries no `yt:`
    key, so nothing can stream it. Resolving it here — off the request, through
    the same permanently-cached resolver the catalog uses — means the heart stays
    instant while the song quietly becomes playable a moment later.
    """
    keys = [k for k in (favourite.get("keys") or []) if isinstance(k, str)]
    if not keys or any(k.startswith("yt:") for k in keys):
        return
    artist = (favourite.get("artist") or "").strip()
    title = (favourite.get("title") or "").strip()
    if not artist or not title:
        return

    from shared.user_context import current_user_id

    user_id = current_user_id()
    duration = favourite.get("duration")
    duration_s = int(duration) if isinstance(duration, (int, float)) and duration > 0 else None

    def _resolve():
        from shared.api import emit_to_user, get_favourites_manager
        from shared.api.routes.catalog import _resolve_candidates
        from shared.user_context import user_context

        try:
            best, _ = _resolve_candidates(artist, title, duration_s)
            video_id = (best or {}).get("id")
            if not video_id:
                return
            with user_context(user_id):
                manager = get_favourites_manager(user_id)
                if manager.update_keys(keys, [f"yt:{video_id}"]):
                    emit_to_user("favourites_updated", user_id=user_id)
        except Exception as exc:  # pragma: no cover — best-effort enrichment
            logger.debug("Favourite resolve failed for %s — %s: %s", artist, title, exc)

    try:
        from shared.api.orchestrator import orchestrator

        orchestrator.submit_background(f"fav_resolve_{keys[0]}", _resolve)
    except Exception as exc:  # pragma: no cover — never block the toggle
        logger.debug("Could not queue favourite resolve: %s", exc)


@library_bp.route("/api/library/playlists", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_create", limit=60, window_sec=60)
def create_playlist():
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    if name in metadata.playlists:
        return jsonify({"error": "Playlist already exists"}), 409
    metadata.create_playlist(name)
    lib._save_metadata()
    api["emit_to_user"]("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists", methods=["PATCH"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_reorder", limit=60, window_sec=60)
def reorder_playlists():
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.json or {}
    order = data.get("order")
    if not isinstance(order, list):
        return jsonify({"error": "order must be a list of playlist names"}), 400
    metadata.reorder_playlists(order)
    lib._save_metadata()
    api["emit_to_user"]("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>/tracks", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_add_track", limit=120, window_sec=60)
def add_track_to_playlist(name):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    data = request.json or {}
    track_id = data.get("track_id")
    if not track_id:
        return jsonify({"error": "track_id is required"}), 400
    if not metadata.add_to_playlist(name, track_id):
        return jsonify({"error": "Add to playlist failed"}), 500
    lib._save_metadata()
    api["emit_to_user"]("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>/tracks/<track_id>", methods=["DELETE"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_remove_track", limit=120, window_sec=60)
def remove_track_from_playlist(name, track_id):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    if not metadata.remove_from_playlist(name, track_id):
        return jsonify({"error": "Remove from playlist failed"}), 500
    lib._save_metadata()
    api["emit_to_user"]("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>", methods=["PATCH"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_update", limit=80, window_sec=60)
def update_playlist(name):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    data = request.json or {}
    if "name" in data:
        new_name = (data.get("name") or "").strip()
        if not new_name:
            return jsonify({"error": "name cannot be empty"}), 400
        if not metadata.rename_playlist(name, new_name):
            return jsonify({"error": "Rename failed (new name may already exist)"}), 409
        name = new_name
    if "track_ids" in data:
        track_ids = data.get("track_ids")
        if not isinstance(track_ids, list):
            return jsonify({"error": "track_ids must be a list"}), 400
        metadata.set_playlist_tracks(name, list(track_ids))
    if "cover_track_id" in data:
        raw_cover = data.get("cover_track_id")
        if raw_cover is not None and not isinstance(raw_cover, str):
            return jsonify({"error": "cover_track_id must be a string or null"}), 400
        cover_tid = (raw_cover or "").strip() or None
        if not metadata.set_playlist_cover_track_id(name, cover_tid):
            return jsonify({"error": "Invalid cover_track_id (not in playlist)"}), 400
    lib._save_metadata()
    api["emit_to_user"]("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>", methods=["DELETE"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_delete", limit=60, window_sec=60)
def delete_playlist(name):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if not metadata.delete_playlist(name):
        return jsonify({"error": "Playlist not found"}), 404
    lib._save_metadata()
    api["emit_to_user"]("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/repair", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_repair", limit=6, window_sec=300)
def repair_library_files():
    """Drop video streams and cap artwork on the files this library holds.

    `dry_run` defaults to true: the pass rewrites files and re-keys track ids,
    and both of those are worth reading a report about first. Progress goes to
    the downloader log, which is where the other maintenance passes report.
    """
    from shared.api import run_library_repair_task

    data = request.json or {}
    dry_run = data.get("dry_run", True)
    try:
        limit = max(0, int(data.get("limit") or 0))
    except (TypeError, ValueError):
        limit = 0
    run_library_repair_task(bool(dry_run), limit)
    return jsonify({"status": "started", "dry_run": bool(dry_run), "limit": limit})
