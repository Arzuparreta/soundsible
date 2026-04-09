"""
Library, metadata, playlists, favourites, and cover routes.
"""

import json
import logging
import os
import tempfile
from urllib.parse import unquote

from flask import Blueprint, request, jsonify
from shared.hardening import require_admin, rate_limit

from shared.path_resolver import resolve_local_track_path
from odst_tool.audio_utils import download_image

logger = logging.getLogger(__name__)

library_bp = Blueprint("library", __name__, url_prefix="")


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
        favourites_manager,
        is_trusted_network,
    )
    from shared.models import LibraryMetadata
    return {
        "get_core": get_core,
        "get_track_by_id": get_track_by_id,
        "_mark_track_metadata_updated": _mark_track_metadata_updated,
        "_ensure_lib_metadata": _ensure_lib_metadata,
        "socketio": socketio,
        "get_downloader": get_downloader,
        "favourites_manager": favourites_manager,
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
        return jsonify(json.loads(lib.metadata.to_json()))
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
@require_admin(allow_trusted_network=True)
@rate_limit("library_sync", limit=20, window_sec=60)
def sync_library():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    success = lib.sync_library()
    if success:
        api["socketio"].emit("library_updated")
    return jsonify({"status": "success" if success else "failed"})


@library_bp.route("/api/library/tracks/<track_id>", methods=["DELETE"])
@require_admin(allow_trusted_network=True)
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
        api["socketio"].emit("library_updated")
        return jsonify({"status": "success"})
    return jsonify({"error": "Deletion failed"}), 500


@library_bp.route("/api/library/wipe", methods=["POST"])
@require_admin(allow_trusted_network=True)
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
        api["socketio"].emit("library_updated")
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error("API: Library wipe error: %s", e)
        import traceback
        traceback.print_exc()
        return jsonify({"error": "Wipe failed"}), 500


@library_bp.route("/api/library/search", methods=["GET"])
def search_library():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    query = request.args.get("q", "").lower()
    results = lib.search(query)
    return jsonify([t.to_dict() for t in results[:50]])


@library_bp.route("/api/library/purge-missing", methods=["POST"])
@require_admin(allow_trusted_network=True)
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
    api["socketio"].emit("library_updated")
    return jsonify({"status": "success", **summary})


@library_bp.route("/api/library/tracks/<track_id>/metadata", methods=["POST"])
@require_admin(allow_trusted_network=True)
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
    return jsonify({"error": "Failed to update track"}), 500


@library_bp.route("/api/library/tracks/<track_id>/cover", methods=["POST"])
@require_admin(allow_trusted_network=True)
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
@require_admin(allow_trusted_network=True)
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
@require_admin(allow_trusted_network=True)
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
    api = _get_api()
    api["get_core"]()
    return jsonify(api["favourites_manager"].get_all())


@library_bp.route("/api/library/favourites/toggle", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("library_toggle_favourite", limit=120, window_sec=60)
def toggle_favourite():
    api = _get_api()
    api["get_core"]()
    data = request.json
    track_id = data.get("track_id")
    if not track_id:
        return jsonify({"error": "No track_id provided"}), 400
    is_fav = api["favourites_manager"].toggle(track_id)
    return jsonify({"status": "success", "is_favourite": is_fav})


@library_bp.route("/api/library/playlists", methods=["POST"])
@require_admin(allow_trusted_network=True)
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
    api["socketio"].emit("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists", methods=["PATCH"])
@require_admin(allow_trusted_network=True)
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
    api["socketio"].emit("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>/tracks", methods=["POST"])
@require_admin(allow_trusted_network=True)
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
    api["socketio"].emit("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>/tracks/<track_id>", methods=["DELETE"])
@require_admin(allow_trusted_network=True)
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
    api["socketio"].emit("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>", methods=["PATCH"])
@require_admin(allow_trusted_network=True)
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
    api["socketio"].emit("library_updated")
    return _playlist_mutation_response(metadata)


@library_bp.route("/api/library/playlists/<path:name>", methods=["DELETE"])
@require_admin(allow_trusted_network=True)
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
    api["socketio"].emit("library_updated")
    return _playlist_mutation_response(metadata)
