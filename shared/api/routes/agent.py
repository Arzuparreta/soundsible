"""
Agent API routes for authenticated remote control.
"""

import hashlib
import logging
import secrets
import uuid
from functools import wraps
from typing import Optional

from flask import Blueprint, g, jsonify, request

from shared.database import DatabaseManager
from shared.hardening import require_admin

logger = logging.getLogger(__name__)

agent_bp = Blueprint("agent", __name__, url_prefix="")


def _get_api():
    from shared.api import (
        get_core,
        get_downloader,
        get_track_by_id,
        get_playback_state,
        put_playback_state,
        socketio,
    )
    from shared.playback_state import list_registered_devices, resolve_registered_device

    return {
        "get_core": get_core,
        "get_downloader": get_downloader,
        "get_track_by_id": get_track_by_id,
        "get_playback_state": get_playback_state,
        "put_playback_state": put_playback_state,
        "socketio": socketio,
        "list_registered_devices": list_registered_devices,
        "resolve_registered_device": resolve_registered_device,
    }


def _db() -> DatabaseManager:
    return DatabaseManager()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _request_agent_token() -> str:
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("X-Soundsible-Agent-Token") or "").strip()


def require_agent_token(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        token = _request_agent_token()
        if not token:
            return jsonify({"error": "Agent token required"}), 401
        db = _db()
        record = db.get_agent_token_by_hash(_hash_token(token))
        if not record:
            return jsonify({"error": "Invalid agent token"}), 403
        db.touch_agent_token(record["id"])
        g.agent_token = {k: v for k, v in record.items() if k != "token_hash"}
        return fn(*args, **kwargs)

    return wrapped


def _scope() -> str:
    from shared.api import get_scope_from_request

    return get_scope_from_request()


def _playback_room(scope: str, device_id: str) -> str:
    return f"playback:{scope}:{device_id}"


def _pick_target_device(api, scope: str, requested_device_id: Optional[str]) -> Optional[dict]:
    if requested_device_id:
        return api["resolve_registered_device"](scope, requested_device_id)
    devices = api["list_registered_devices"](scope)
    for device in devices:
        if device.get("device_type") != "agent" and device.get("active_sid"):
            return device
    for device in devices:
        if device.get("device_type") != "agent":
            return device
    for device in devices:
        if device.get("active_sid"):
            return device
    return devices[0] if devices else None


def _offline_warning(target: Optional[dict]) -> Optional[str]:
    if target and not target.get("active_sid"):
        return "Device appears offline (no active socket)"
    return None


def _with_offline_warning(payload: dict, target: Optional[dict]) -> dict:
    warning = _offline_warning(target)
    if warning:
        payload["warning"] = warning
    return payload


def _emit_start(api, scope: str, device_id: str, state: dict, track: Optional[dict] = None) -> None:
    payload = {"state": state}
    if track:
        payload["track"] = track
    api["socketio"].emit("playback_start_requested", payload, room=_playback_room(scope, device_id))


def _emit_stop(api, scope: str, device_id: str) -> None:
    api["socketio"].emit("playback_stop_requested", {}, room=_playback_room(scope, device_id))


def _track_payload(track) -> dict:
    return track.to_dict()


def _preview_payload(result: dict, query: str) -> Optional[dict]:
    video_id = result.get("id") or result.get("video_id")
    if not video_id:
        return None
    return {
        "id": str(video_id),
        "video_id": str(video_id),
        "source": "preview",
        "title": result.get("title") or query,
        "artist": result.get("artist") or result.get("channel") or result.get("uploader") or "",
        "duration": int(result.get("duration") or result.get("duration_sec") or 0),
        "thumbnail": result.get("thumbnail"),
        "webpage_url": result.get("webpage_url"),
    }


@agent_bp.route("/api/agent/token", methods=["POST"])
@require_admin()
def create_agent_token():
    data = request.json or {}
    token = secrets.token_urlsafe(32)
    token_id = str(uuid.uuid4())
    record = _db().create_agent_token(token_id, _hash_token(token), data.get("name") or data.get("agent_name"))
    return jsonify({
        "token": token,
        "token_id": record["id"],
        "name": record.get("name"),
        "created_at": record.get("created_at"),
    }), 201


@agent_bp.route("/api/agent/verify", methods=["GET"])
@require_agent_token
def verify_agent_token():
    return jsonify({"valid": True, "token": g.agent_token})


@agent_bp.route("/api/agent/play", methods=["POST"])
@require_agent_token
def agent_play():
    api = _get_api()
    scope = _scope()
    data = request.json or {}
    requested_device_id = data.get("device_id") or data.get("target_device_id")
    target = _pick_target_device(api, scope, requested_device_id)
    if requested_device_id and not target:
        return jsonify({"error": "Target device not found", "device_id": requested_device_id}), 404

    lib, engine, _ = api["get_core"]()
    track = None
    payload = None
    track_id = (data.get("track_id") or "").strip()
    query = (data.get("query") or data.get("q") or "").strip()

    if track_id:
        track = api["get_track_by_id"](lib, track_id)
        if not track:
            return jsonify({"error": "Track not found"}), 404
        payload = _track_payload(track)
    elif query:
        matches = lib.search(query) if lib else []
        if matches:
            track = matches[0]
            payload = _track_payload(track)
            track_id = track.id
        else:
            try:
                dl = api["get_downloader"](open_browser=False)
                results = dl.downloader.search_youtube(query, max_results=1, use_ytmusic=True)
            except Exception as e:
                logger.warning("API: Agent search failed: %s", e)
                return jsonify({"error": "Search failed"}), 502
            payload = _preview_payload(results[0], query) if results else None
            if not payload:
                return jsonify({"error": "No playable result found"}), 404
            track_id = payload["id"]
    else:
        return jsonify({"error": "track_id or query required"}), 400

    if target:
        target_state = {
            "track_id": track_id,
            "track": payload,
            "position_sec": float(data.get("position_sec") or 0),
            "is_playing": True,
            "device_id": target["device_id"],
            "device_name": target.get("device_name"),
        }
        api["put_playback_state"](scope, target_state)
        _emit_start(api, scope, target["device_id"], target_state, track=payload)
        return jsonify(_with_offline_warning({
            "status": "sent",
            "device_id": target["device_id"],
            "track": payload,
        }, target))

    if not track or not engine:
        return jsonify({"error": "No target device registered and local engine cannot play this item"}), 409

    url = lib.get_track_url(track)
    engine.play(url, track)
    return jsonify({"status": "playing", "track": payload})


@agent_bp.route("/api/agent/command", methods=["POST"])
@require_agent_token
def agent_command():
    api = _get_api()
    scope = _scope()
    data = request.json or {}
    command = (data.get("command") or "").strip().lower()
    if command not in {"pause", "play", "next"}:
        return jsonify({"error": "command must be pause, play, or next"}), 400

    requested_device_id = data.get("device_id") or data.get("target_device_id")
    target = _pick_target_device(api, scope, requested_device_id)
    if requested_device_id and not target:
        return jsonify({"error": "Target device not found", "device_id": requested_device_id}), 404
    if target:
        device_id = target["device_id"]
        if command == "pause":
            _emit_stop(api, scope, device_id)
        elif command == "play":
            state = api["get_playback_state"](scope, device_id=device_id) or api["get_playback_state"](scope)
            if not state or not state.get("track_id"):
                return jsonify({"error": "No playback state available for target device"}), 404
            target_state = {
                **state,
                "device_id": device_id,
                "device_name": target.get("device_name") or state.get("device_name"),
                "is_playing": True,
            }
            api["put_playback_state"](scope, target_state)
            track_payload = target_state.get("track") if isinstance(target_state.get("track"), dict) else None
            _emit_start(api, scope, device_id, target_state, track=track_payload)
        else:
            api["socketio"].emit("playback_next_requested", {}, room=_playback_room(scope, device_id))
        return jsonify(_with_offline_warning({
            "status": "sent",
            "command": command,
            "device_id": device_id,
        }, target))

    lib, engine, queue = api["get_core"]()
    if not engine:
        return jsonify({"error": "No target device registered and local engine is not ready"}), 409
    if command == "pause":
        engine.pause()
    elif command == "play":
        engine.pause()
    else:
        item = queue.get_next()
        if not item:
            return jsonify({"error": "Queue is empty"}), 404
        track = api["get_track_by_id"](lib, item.id)
        if not track:
            return jsonify({"error": "Next queue item is not a local library track"}), 409
        engine.play(lib.get_track_url(track), track)
    return jsonify({"status": "ok", "command": command})

@agent_bp.route('/api/agent/debug/socketio', methods=['GET'])
@require_agent_token
def debug_socketio():
    """Debug: Show Socket.IO rooms and registered devices."""
    api = _get_api()
    socketio = api.get("socketio")

    result = {
        "registered_devices": _list_registered_devices_detailed(),
        "socketio_info": str(socketio),
    }

    # Try to get server rooms if accessible
    try:
        if hasattr(socketio, 'server'):
            server = socketio.server
            if hasattr(server, 'rooms'):
                result["rooms"] = {str(k): str(v) for k, v in server.rooms.items()}
            if hasattr(server, 'sockets'):
                result["sockets_count"] = len(server.sockets)
    except Exception as e:
        result["error"] = str(e)

    return jsonify(result)

def _list_registered_devices_detailed():
    """Get detailed info about registered devices."""
    from shared.playback_state import list_registered_devices
    from shared.api import get_scope_from_request

    scope = get_scope_from_request()
    devices = list_registered_devices(scope)

    result = []
    for d in devices:
        device_id = d.get("device_id")
        result.append({
            "device_id": device_id,
            "device_name": d.get("device_name"),
            "device_type": d.get("device_type"),
            "last_seen_ts": d.get("last_seen_ts"),
            "active_sid": d.get("active_sid"),
            "socket_connected": bool(d.get("active_sid")),
        })
    return result
