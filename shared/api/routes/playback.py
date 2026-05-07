"""
Streaming, cover, preview, and playback queue/state routes.
"""

import logging
import os
import threading
import time

import requests
from flask import Blueprint, request, jsonify, send_file, Response, stream_with_context

from shared.constants import DEFAULT_CACHE_DIR
from shared.path_resolver import resolve_local_track_path
from shared.url_utils import validate_youtube_video_id

logger = logging.getLogger(__name__)

playback_bp = Blueprint("playback", __name__, url_prefix="")

PREVIEW_STREAM_LIMIT = 30
PREVIEW_STREAM_WINDOW_SEC = 60
_preview_stream_timestamps = {}
_preview_stream_lock = threading.Lock()

# Note: Small in-memory cache for preview stream URLs to avoid repeated expensive
# resolution calls for the same video_id. This is intentionally short-lived and
# process-local; ODST itself also has deeper caching at the downloader layer.
PREVIEW_STREAM_CACHE_TTL_SEC = 300  # 5 minutes
_preview_stream_cache = {}
_preview_stream_cache_lock = threading.Lock()


def _preview_stream_rate_limit(ip: str) -> bool:
    now = time.time()
    with _preview_stream_lock:
        timestamps = _preview_stream_timestamps.get(ip, [])
        timestamps = [t for t in timestamps if now - t < PREVIEW_STREAM_WINDOW_SEC]
        if len(timestamps) >= PREVIEW_STREAM_LIMIT:
            return False
        timestamps.append(now)
        _preview_stream_timestamps[ip] = timestamps
    return True


def _get_preview_stream_url_cached(api, video_id: str) -> str:
    """
    Resolve a preview stream URL with a small TTL cache to avoid repeated
    calls into the downloader for the same video_id under bursty access.
    """
    now = time.time()
    with _preview_stream_cache_lock:
        entry = _preview_stream_cache.get(video_id)
        if entry and entry["expires_at"] > now and entry.get("url"):
            return entry["url"]

    dl = api["get_downloader"](open_browser=False)
    url = dl.downloader.get_stream_url(video_id)
    if not url:
        return ""

    expires_at = now + PREVIEW_STREAM_CACHE_TTL_SEC
    with _preview_stream_cache_lock:
        _preview_stream_cache[video_id] = {"url": url, "expires_at": expires_at}

    return url


def _get_api():
    from shared.api import (
        get_core,
        get_track_by_id,
        socketio,
        get_downloader,
        is_trusted_network,
        is_safe_path,
        WEB_UI_PATH,
        get_playback_state,
        put_playback_state,
        get_scope_from_request,
    )
    from shared.playback_state import register_device, get_registered_device, list_registered_devices
    return {
        "get_core": get_core,
        "get_track_by_id": get_track_by_id,
        "socketio": socketio,
        "get_downloader": get_downloader,
        "is_trusted_network": is_trusted_network,
        "is_safe_path": is_safe_path,
        "WEB_UI_PATH": WEB_UI_PATH,
        "get_playback_state": get_playback_state,
        "put_playback_state": put_playback_state,
        "get_scope_from_request": get_scope_from_request,
        "register_device": register_device,
        "get_registered_device": get_registered_device,
        "list_registered_devices": list_registered_devices,
    }


def _playback_room(scope: str, device_id: str) -> str:
    return f"playback:{scope}:{device_id}"


def _emit_playback_stop(api, scope: str, device_id: str) -> None:
    api["socketio"].emit("playback_stop_requested", {}, room=_playback_room(scope, device_id))


def _emit_playback_start(api, scope: str, device_id: str, state: dict, track: dict | None = None) -> None:
    payload = {"state": state}
    if track:
        payload["track"] = track
    api["socketio"].emit("playback_start_requested", payload, room=_playback_room(scope, device_id))


@playback_bp.route("/api/devices/register", methods=["POST"])
def register_playback_device():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    device = api["register_device"](
        scope,
        device_id=data.get("device_id"),
        device_name=data.get("device_name"),
        device_type=data.get("device_type"),
    )
    return jsonify({
        "status": "registered",
        "device": device,
        "room": _playback_room(scope, device["device_id"]),
    })


@playback_bp.route("/api/devices", methods=["GET"])
def list_playback_devices():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    return jsonify({"devices": api["list_registered_devices"](scope)})


@playback_bp.route("/api/static/stream/<track_id>", methods=["GET"])
def stream_local_track(track_id):
    api = _get_api()
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    path = resolve_local_track_path(track)
    if not path:
        return jsonify({"error": "No path registered"}), 404
    path = os.path.normpath(os.path.abspath(os.path.expanduser(path)))
    if not os.path.exists(path):
        return jsonify({"error": f"File not found: {path}"}), 404
    is_trusted = api["is_trusted_network"](request.remote_addr)
    if not api["is_safe_path"](path, is_trusted=is_trusted):
        return jsonify({"error": "Unauthorized path access"}), 403
    ext = os.path.splitext(path)[1].lower().replace(".", "")
    mimetypes = {"mp3": "audio/mpeg", "m4a": "audio/mp4", "flac": "audio/flac", "ogg": "audio/ogg", "wav": "audio/wav"}
    try:
        response = send_file(path, mimetype=mimetypes.get(ext, "audio/mpeg"), conditional=True)
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Range")
        response.headers.add("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        return response
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@playback_bp.route("/api/preview/stream/<video_id>", methods=["GET"])
def preview_stream_proxy(video_id):
    api = _get_api()
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    if not _preview_stream_rate_limit(request.remote_addr or "unknown"):
        return jsonify({"error": "Too many requests"}), 429
    try:
        stream_url = _get_preview_stream_url_cached(api, video_id)
        if not stream_url:
            return jsonify({"error": "Preview unavailable"}), 502
        range_header = request.headers.get("Range")
        req_headers = {"Range": range_header} if range_header else {}
        # Use a conservative connect/read timeout to avoid tying up worker
        # threads on very slow upstreams.
        resp = requests.get(
            stream_url,
            stream=True,
            headers=req_headers,
            timeout=(5, 90),
        )
        resp.raise_for_status()
        content_length = resp.headers.get("Content-Length")
        content_range = resp.headers.get("Content-Range")
        response_headers = {"Content-Type": "audio/mpeg"}
        if content_range:
            response_headers["Content-Range"] = content_range
        if content_length:
            response_headers["Content-Length"] = content_length

        def iter_chunks():
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk

        return Response(
            stream_with_context(iter_chunks()),
            status=resp.status_code,
            headers=response_headers,
            mimetype="audio/mpeg",
            direct_passthrough=True,
        )
    except Exception as e:
        logger.warning("API: [Preview stream] Error for %s: %s", video_id, e)
        return jsonify({"error": "Preview unavailable"}), 502


@playback_bp.route("/api/preview/stream-url/<video_id>", methods=["GET"])
def get_preview_stream_url(video_id):
    api = _get_api()
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    if not _preview_stream_rate_limit(request.remote_addr or "unknown"):
        return jsonify({"error": "Too many requests"}), 429
    try:
        url = _get_preview_stream_url_cached(api, video_id)
        if not url:
            return jsonify({"error": "Stream URL unavailable"}), 404
        return jsonify({"url": url})
    except Exception as e:
        return jsonify({"error": "Preview unavailable"}), 502


@playback_bp.route("/api/preview/cover/<video_id>", methods=["GET"])
def preview_cover_redirect(video_id):
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    from flask import redirect
    return redirect(f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg", code=302)


@playback_bp.route("/api/static/cover/<track_id>", methods=["GET"])
def get_track_cover(track_id):
    api = _get_api()
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    path = lib.get_cover_url(track)
    local_track_path = resolve_local_track_path(track) if not path else None
    if not path:
        try:
            from setup_tool.audio import AudioProcessor
            covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
            os.makedirs(covers_dir, exist_ok=True)
            cover_path = os.path.join(covers_dir, f"{track.id}.jpg")
            if not os.path.exists(cover_path):
                cover_data = None
                if local_track_path and not str(local_track_path).startswith("http"):
                    cover_data = AudioProcessor.extract_cover_art(local_track_path)
                if cover_data:
                    with open(cover_path, "wb") as f:
                        f.write(cover_data)
            if os.path.exists(cover_path):
                path = cover_path
        except Exception as e:
            logger.warning("[Cover] Failed for %s: %s", track_id, e)
    if path and os.path.exists(path):
        is_trusted = api["is_trusted_network"](request.remote_addr)
        if not api["is_safe_path"](path, is_trusted=is_trusted):
            return jsonify({"error": "Unauthorized path"}), 403
        return send_file(path, mimetype="image/jpeg")
    placeholder = os.path.join(api["WEB_UI_PATH"], "assets/icons/icon-192.png")
    if os.path.exists(placeholder):
        return send_file(placeholder, mimetype="image/png")
    return jsonify({"error": "Cover not ready"}), 404


@playback_bp.route("/api/playback/queue", methods=["GET"])
def get_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    items = [item.to_dict() for item in queue.get_all()]
    return jsonify({"items": items, "tracks": items, "repeat_mode": queue.get_repeat_mode()})


@playback_bp.route("/api/playback/shuffle", methods=["POST"])
def shuffle_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    queue.shuffle()
    return jsonify({"status": "success"})


@playback_bp.route("/api/playback/repeat", methods=["POST"])
def set_playback_repeat():
    api = _get_api()
    _, _, queue = api["get_core"]()
    data = request.json
    mode = data.get("mode", "off")
    queue.set_repeat_mode(mode)
    return jsonify({"status": "success", "mode": mode})


@playback_bp.route("/api/playback/queue", methods=["POST"])
def add_to_playback_queue():
    api = _get_api()
    lib, _, queue = api["get_core"]()
    data = request.json or {}
    if "track_id" in data:
        track = api["get_track_by_id"](lib, data["track_id"])
        if track:
            queue.add_library_track(track)
            return jsonify({"status": "success", "size": queue.size()})
        return jsonify({"error": "Track not found"}), 404
    if "preview" in data:
        preview = data["preview"]
        # Podcast preview: enclosure_url present and no video_id
        enclosure_url = preview.get("enclosure_url")
        video_id = preview.get("video_id") or preview.get("id")
        if enclosure_url and not video_id:
            title = preview.get("title") or "Unknown"
            artist = preview.get("artist") or ""
            duration = int(preview.get("duration") or preview.get("duration_sec") or 0)
            thumbnail = preview.get("thumbnail") or None
            album = preview.get("album") or None
            episode_id = preview.get("episode_id") or f"pcast_{preview.get('podcast_feed_id') or 'unknown'}_{preview.get('podcast_episode_guid') or 'unknown'}"
            queue.add_podcast_preview(
                episode_id=str(episode_id),
                title=title,
                artist=artist,
                duration=max(0, duration),
                thumbnail=thumbnail,
                enclosure_url=str(enclosure_url),
                podcast_feed_id=preview.get("podcast_feed_id") or None,
                podcast_episode_guid=preview.get("podcast_episode_guid") or None,
                podcast_rss_url=preview.get("podcast_rss_url") or None,
                album=album,
            )
            return jsonify({"status": "success", "size": queue.size()})
        if not video_id or not validate_youtube_video_id(str(video_id)):
            return jsonify({"error": "Invalid or missing video_id"}), 400
        title = preview.get("title") or "Unknown"
        artist = preview.get("artist") or ""
        duration = int(preview.get("duration") or preview.get("duration_sec") or 0)
        thumbnail = preview.get("thumbnail") or None
        library_track_id = preview.get("library_track_id") or None
        album = preview.get("album") or None
        queue.add_preview(
            video_id=str(video_id),
            title=title,
            artist=artist,
            duration=max(0, duration),
            thumbnail=thumbnail,
            library_track_id=library_track_id,
            album=album,
        )
        return jsonify({"status": "success", "size": queue.size()})
    return jsonify({"error": "Missing track_id or preview"}), 400


@playback_bp.route("/api/playback/queue/<int:index>", methods=["DELETE"])
def remove_from_playback_queue(index):
    api = _get_api()
    _, _, queue = api["get_core"]()
    if queue.remove(index):
        return jsonify({"status": "success"})
    return jsonify({"error": "Index out of range"}), 400


@playback_bp.route("/api/playback/queue/track/<track_id>", methods=["DELETE"])
def remove_track_id_from_playback_queue(track_id):
    api = _get_api()
    _, _, queue = api["get_core"]()
    removed_count = queue.remove_by_id(track_id)
    if removed_count:
        return jsonify({"status": "success", "removed_count": removed_count})
    return jsonify({"error": "Track not in queue"}), 404


@playback_bp.route("/api/playback/queue/move", methods=["POST"])
def move_in_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    data = request.json
    from_index = data.get("from_index")
    to_index = data.get("to_index")
    if from_index is not None and to_index is not None and queue.move(from_index, to_index):
        return jsonify({"status": "success"})
    return jsonify({"error": "Invalid indices"}), 400


@playback_bp.route("/api/playback/queue", methods=["DELETE"])
def clear_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    queue.clear()
    return jsonify({"status": "success"})


@playback_bp.route("/api/playback/next", methods=["GET"])
def get_next_from_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    item = queue.get_next()
    if item:
        return jsonify(item.to_dict())
    return jsonify(None)


@playback_bp.route("/api/playback/play", methods=["POST"])
def play_track():
    api = _get_api()
    lib, engine, _ = api["get_core"]()
    data = request.json
    track_id = data.get("track_id")
    track = api["get_track_by_id"](lib, track_id)
    if track and engine:
        url = lib.get_track_url(track)
        engine.play(url, track)
        resolved = resolve_local_track_path(track)
        source = "local" if (resolved and url == resolved) else "remote"
        return jsonify({"status": "playing", "track": track.title, "source": source})
    return jsonify({"error": "Track not found or engine not ready"}), 404


@playback_bp.route("/api/playback/toggle", methods=["POST"])
def toggle_playback():
    api = _get_api()
    _, engine, _ = api["get_core"]()
    if engine:
        engine.pause()
        return jsonify({"status": "toggled", "is_playing": engine.is_playing})
    return jsonify({"error": "Engine not ready"}), 500


@playback_bp.route("/api/playback/state", methods=["GET"])
def playback_get_state():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    exclude_device = request.args.get("exclude_device") or None
    state = api["get_playback_state"](scope, exclude_device_id=exclude_device)
    if not state:
        return "", 204
    return jsonify(state)


@playback_bp.route("/api/playback/state", methods=["PUT"])
def playback_put_state():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    api["put_playback_state"](scope, data)
    return jsonify({"status": "ok"})


@playback_bp.route("/api/playback/handoff", methods=["POST"])
def playback_handoff():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    from_device_id = (data.get("from_device_id") or "").strip()
    to_device_id = (data.get("to_device_id") or "").strip()
    if not from_device_id or not to_device_id:
        return jsonify({"error": "from_device_id and to_device_id required"}), 400
    if from_device_id == to_device_id:
        return jsonify({"error": "from_device_id and to_device_id must differ"}), 400

    state = api["get_playback_state"](scope, device_id=from_device_id)
    if not state or not state.get("track_id"):
        return jsonify({"error": "No active playback state for source device"}), 404

    target_device = api["get_registered_device"](scope, to_device_id)
    if not target_device:
        return jsonify({"error": "Target device not found", "device_id": to_device_id}), 404
    target_state = {
        **state,
        "device_id": to_device_id,
        "device_name": target_device.get("device_name") or state.get("device_name"),
        "is_playing": True,
    }
    api["put_playback_state"](scope, target_state)
    _emit_playback_stop(api, scope, from_device_id)

    track_payload = None
    try:
        lib, _, _ = api["get_core"]()
        track = api["get_track_by_id"](lib, target_state.get("track_id"))
        if track:
            track_payload = track.to_dict()
    except Exception as e:
        logger.debug("API: handoff track payload lookup failed: %s", e)
    if not track_payload and isinstance(target_state.get("track"), dict):
        track_payload = target_state["track"]

    _emit_playback_start(api, scope, to_device_id, target_state, track=track_payload)
    response = {
        "status": "sent",
        "from_device_id": from_device_id,
        "to_device_id": to_device_id,
        "state": target_state,
    }
    if not target_device.get("active_sid"):
        response["warning"] = "Device appears offline (no active socket)"
    return jsonify(response)


@playback_bp.route("/api/playback/notify-stop", methods=["POST"])
def playback_notify_stop():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    device_id = data.get("device_id")
    if not device_id:
        return jsonify({"error": "device_id required"}), 400
    _emit_playback_stop(api, scope, device_id)
    return jsonify({"status": "sent"})


@playback_bp.route("/api/playback/remote-command", methods=["POST"])
def playback_remote_command():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    device_id = (data.get("device_id") or "").strip()
    command = (data.get("command") or "").strip().lower()

    if not device_id or command not in {"pause", "play", "next", "seek"}:
        return jsonify({"error": "device_id and command (pause, play, next, seek) required"}), 400

    target = api["get_registered_device"](scope, device_id)
    if not target:
        return jsonify({"error": "Target device not found", "device_id": device_id}), 404

    room = _playback_room(scope, device_id)

    if command == "pause":
        _emit_playback_stop(api, scope, device_id)
        api["put_playback_state"](scope, {
            "is_playing": False,
            "device_id": device_id,
            "device_name": target.get("device_name"),
        })
    elif command == "play":
        track_id = (data.get("track_id") or "").strip()
        state = api["get_playback_state"](scope, device_id=device_id) or api["get_playback_state"](scope)
        if track_id:
            lib, engine, queue = api["get_core"]()
            track = api["get_track_by_id"](lib, track_id)
            if track:
                queue.consume_head_if_id(track_id)
                target_state = {
                    "track_id": track_id,
                    "track": track.to_dict(),
                    "position_sec": float(data.get("position_sec") or 0),
                    "is_playing": True,
                    "device_id": device_id,
                    "device_name": target.get("device_name"),
                }
            elif state and state.get("track_id") == track_id:
                target_state = {
                    **state,
                    "device_id": device_id,
                    "device_name": target.get("device_name") or state.get("device_name"),
                    "is_playing": True,
                }
            else:
                return jsonify({"error": "Track not found for target device"}), 404
        elif not state or not state.get("track_id"):
            return jsonify({"error": "No playback state available for target device"}), 404
        else:
            target_state = {
                **state,
                "device_id": device_id,
                "device_name": target.get("device_name") or state.get("device_name"),
                "is_playing": True,
            }
        api["put_playback_state"](scope, target_state)
        track_payload = target_state.get("track") if isinstance(target_state.get("track"), dict) else None
        _emit_playback_start(api, scope, device_id, target_state, track=track_payload)
    elif command == "next":
        api["socketio"].emit("playback_next_requested", {}, room=room)
    else:
        raw = data.get("position_sec")
        if raw is None:
            return jsonify({"error": "position_sec required for seek"}), 400
        try:
            position_sec = float(raw)
        except (TypeError, ValueError):
            return jsonify({"error": "position_sec must be a number"}), 400
        if position_sec < 0:
            return jsonify({"error": "position_sec must be >= 0"}), 400
        state = api["get_playback_state"](scope, device_id=device_id) or api["get_playback_state"](scope)
        if not state or not state.get("track_id"):
            return jsonify({"error": "No playback state available for target device"}), 404
        target_state = {
            **state,
            "device_id": device_id,
            "device_name": target.get("device_name") or state.get("device_name"),
            "position_sec": position_sec,
        }
        api["put_playback_state"](scope, target_state)
        api["socketio"].emit("playback_seek_requested", {"position_sec": position_sec}, room=room)

    warning = None
    if not target.get("active_sid"):
        warning = "Device appears offline (no active socket)"
    response = {
        "status": "sent",
        "command": command,
        "device_id": device_id,
    }
    if command == "seek":
        response["position_sec"] = position_sec
    if warning:
        response["warning"] = warning
    return jsonify(response)
