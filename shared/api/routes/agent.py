"""
Agent API routes for authenticated remote control.
"""

import hashlib
import logging
import math
import secrets
import uuid
from functools import wraps
from typing import Optional

from flask import Blueprint, g, jsonify, request

from shared.database import DatabaseManager, instance_db
from shared.hardening import (
    LEGACY_AGENT_SCOPES,
    SCOPE_ADMIN_CONFIG,
    SCOPE_DOWNLOAD_ADD,
    SCOPE_LIBRARY_READ,
    SCOPE_PLAYBACK_CONTROL,
    get_request_auth_context,
    require_scope,
)
from shared.remote.dispatcher import send_command

logger = logging.getLogger(__name__)

agent_bp = Blueprint("agent", __name__, url_prefix="")

_COMMAND_MAP = {
    "pause": "transport.pause",
    "play": "transport.play",
    "next": "transport.next",
    "previous": "transport.previous",
}


def _get_api():
    from shared.user_cores import get_library, get_track_by_id
    from shared.download_pump import get_downloader
    from shared.realtime import socketio
    from shared.playback_state import list_registered_devices, resolve_registered_device

    return {
        "get_library": get_library,
        "get_downloader": get_downloader,
        "get_track_by_id": get_track_by_id,
        "socketio": socketio,
        "list_registered_devices": list_registered_devices,
        "resolve_registered_device": resolve_registered_device,
        "send_command": send_command,
    }


def _db() -> DatabaseManager:
    return instance_db()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def require_agent_scope(*required_scopes: str):
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            context = get_request_auth_context(allow_trusted_network=False)
            if not context:
                return jsonify({"error": "Agent token required"}), 401
            granted = set(context.get("scopes") or [])
            if context.get("kind") != "owner" and not set(required_scopes).issubset(granted):
                return jsonify({"error": "Insufficient token scope", "required_scopes": list(required_scopes)}), 403
            g.agent_token = context.get("record") or {}
            return fn(*args, **kwargs)

        return wrapped

    return decorator


def _scope() -> str:
    from shared.api import get_scope_from_request

    return get_scope_from_request()


def _pick_target_device(api, scope: str, requested_device_id: Optional[str]) -> Optional[dict]:
    if requested_device_id:
        return api["resolve_registered_device"](scope, requested_device_id)
    devices = api["list_registered_devices"](scope)
    for device in devices:
        if device.get("device_type") != "agent" and device.get("online"):
            return device
    for device in devices:
        if device.get("device_type") != "agent":
            return device
    for device in devices:
        if device.get("online"):
            return device
    return devices[0] if devices else None


def _parse_seek_position_sec(data: dict) -> tuple[Optional[float], Optional[str]]:
    raw = data.get("position_sec")
    if raw is None:
        raw = data.get("position")
    if raw is None and data.get("position_ms") is not None:
        ms = data.get("position_ms")
        if isinstance(ms, bool):
            return None, "position_ms must be a number"
        try:
            raw = float(ms) / 1000
        except (TypeError, ValueError):
            return None, "position_ms must be a number"
    if raw is None:
        return None, "seek requires position_sec"
    if isinstance(raw, bool):
        return None, "position_sec must be a number"
    try:
        position_sec = float(raw)
    except (TypeError, ValueError):
        return None, "position_sec must be a number"
    if not math.isfinite(position_sec) or position_sec < 0:
        return None, "position_sec must be greater than or equal to 0"
    return position_sec, None


def _track_payload(track) -> dict:
    return track.to_dict()


def _preview_payload(result: dict, query: str) -> Optional[dict]:
    video_id = result.get("id") or result.get("video_id")
    if not video_id:
        return None
    payload = {
        "id": str(video_id),
        "youtube_id": str(video_id),
        "source": "preview",
        "title": str(result.get("title") or query),
        "artist": str(result.get("artist") or result.get("channel") or result.get("uploader") or ""),
        "duration": int(result.get("duration") or result.get("duration_sec") or 0),
    }
    thumb = result.get("thumbnail")
    if isinstance(thumb, str) and thumb:
        payload["cover"] = thumb
    return payload


@agent_bp.route("/api/agent/token", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
def create_agent_token():
    data = request.json or {}
    token = secrets.token_urlsafe(32)
    token_id = str(uuid.uuid4())
    requested_scopes = data.get("scopes") if isinstance(data.get("scopes"), list) else None
    scopes = [scope for scope in (requested_scopes or sorted(LEGACY_AGENT_SCOPES)) if scope in {SCOPE_LIBRARY_READ, SCOPE_PLAYBACK_CONTROL, SCOPE_DOWNLOAD_ADD}]
    if not scopes:
        return jsonify({"error": "At least one supported scope is required"}), 400
    from shared.user_context import current_user_id

    record = _db().create_auth_token(
        token_id,
        _hash_token(token),
        kind="agent",
        scopes=scopes,
        name=data.get("name") or data.get("agent_name"),
        device_type=data.get("device_type") or "agent",
        expires_at=data.get("expires_at"),
        # The agent acts as whoever minted it. Without this the token would
        # carry no identity and be rejected on use.
        user_id=current_user_id(),
    )
    return jsonify({
        "token": token,
        "token_id": record["id"],
        "name": record.get("name"),
        "kind": record.get("kind"),
        "scopes": record.get("scopes"),
        "created_at": record.get("created_at"),
    }), 201


@agent_bp.route("/api/agent/verify", methods=["GET"])
@require_agent_scope(SCOPE_LIBRARY_READ)
def verify_agent_token():
    return jsonify({"valid": True, "token": g.agent_token})


@agent_bp.route("/api/agent/play", methods=["POST"])
@require_agent_scope(SCOPE_PLAYBACK_CONTROL)
def agent_play():
    api = _get_api()
    scope = _scope()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"status": "rejected", "reason": "invalid"}), 400
    requested_device_id = data.get("device_id") or data.get("target_device_id")
    target = _pick_target_device(api, scope, requested_device_id)
    if not target:
        return jsonify({"status": "rejected", "reason": "unknown_device"}), 404

    lib = api["get_library"]()
    payload = None
    track_id = (data.get("track_id") or "").strip() if isinstance(data.get("track_id"), str) else ""
    raw_query = data.get("query") if data.get("query") is not None else data.get("q")
    query = raw_query.strip() if isinstance(raw_query, str) else ""

    if track_id:
        track = api["get_track_by_id"](lib, track_id)
        if not track:
            return jsonify({"status": "rejected", "reason": "not_found"}), 404
        payload = _track_payload(track)
    elif query:
        matches = lib.search(query) if lib else []
        if matches:
            payload = _track_payload(matches[0])
        else:
            try:
                dl = api["get_downloader"](open_browser=False)
                # Plain search: the payload built below wants a duration, and
                # YouTube Music's does not carry one — recovering it would cost
                # a full extraction for the single row we asked for.
                results = dl.downloader.search_youtube(
                    query, max_results=1, use_ytmusic=False, enrich_missing=False
                )
            except Exception as e:
                logger.warning("API: Agent search failed: %s", e)
                return jsonify({"error": "Search failed"}), 502
            payload = _preview_payload(results[0], query) if results else None
            if not payload:
                return jsonify({"status": "rejected", "reason": "not_found"}), 404
    else:
        return jsonify({"status": "rejected", "reason": "invalid"}), 400

    status, body = api["send_command"](
        scope, target["device_id"], "play.tracks", {"tracks": [payload], "index": 0}
    )
    return jsonify(body), status


@agent_bp.route("/api/agent/command", methods=["POST"])
@require_agent_scope(SCOPE_PLAYBACK_CONTROL)
def agent_command():
    api = _get_api()
    scope = _scope()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"status": "rejected", "reason": "invalid"}), 400
    command = (data.get("command") or "").strip().lower() if isinstance(data.get("command"), str) else ""
    if command not in {"pause", "play", "next", "previous", "seek"}:
        return jsonify({"status": "rejected", "reason": "invalid"}), 400

    if command == "seek":
        position_sec, error = _parse_seek_position_sec(data)
        if error:
            return jsonify({"status": "rejected", "reason": "invalid"}), 400
        cmd_name = "transport.seek"
        cmd_args = {"position_sec": position_sec}
    else:
        cmd_name = _COMMAND_MAP[command]
        cmd_args = {}

    requested_device_id = data.get("device_id") or data.get("target_device_id")
    target = _pick_target_device(api, scope, requested_device_id)
    if not target:
        return jsonify({"status": "rejected", "reason": "unknown_device"}), 404

    status, body = api["send_command"](scope, target["device_id"], cmd_name, cmd_args)
    return jsonify(body), status


@agent_bp.route('/api/agent/debug/socketio', methods=['GET'])
@require_agent_scope(SCOPE_LIBRARY_READ)
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
    from shared.playback_state import list_registered_devices_debug
    from shared.api import get_scope_from_request

    scope = get_scope_from_request()
    return list_registered_devices_debug(scope)
