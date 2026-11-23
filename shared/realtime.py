"""The Socket.IO server and the per-account rooms events go to.

The server is created here without an application; `shared.api` binds it to
the Flask app. Anything that tells clients about a change (downloads, the
library, loudness) imports it from here instead of from the Flask module.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

from flask_socketio import SocketIO

logger = logging.getLogger(__name__)

socketio = SocketIO()

USER_ROOM_PREFIX = "user:"
WATCH_ROOM_PREFIX = "watch:"


def server_now_ms() -> int:
    """Current server wall clock in epoch milliseconds."""
    return int(round(time.time() * 1000))


def user_room(user_id: str) -> str:
    """Socket.IO room carrying one person's library and downloader events."""
    return f"{USER_ROOM_PREFIX}{user_id}"


def watch_room(scope: str, device_id: str) -> str:
    """Socket.IO room carrying live playback publications for one device."""
    return f"{WATCH_ROOM_PREFIX}{scope}:{device_id}"


def emit_device_updated(scope: str, device: dict[str, Any], *, now_ms: Optional[int] = None) -> None:
    """Broadcast a device row change to its account's sockets."""
    if not scope or not device:
        return
    socketio.emit(
        "device_updated",
        {"device": device, "server_now_ms": server_now_ms() if now_ms is None else now_ms},
        room=user_room(scope),
    )


def emit_device_state(scope: str, device_id: str, payload: dict[str, Any]) -> None:
    """Push an accepted playback publication to sockets watching that device."""
    if not scope or not device_id or not payload:
        return
    socketio.emit("device_state", payload, room=watch_room(scope, device_id))


def emit_to_user(event: str, payload: Any = None, *, user_id: Optional[str] = None) -> None:
    """Emit a personal event to one account's sockets.

    Library and downloader updates describe somebody's private library, so they
    are never broadcast. With no account resolvable the event is dropped rather
    than sent to everyone — a lost refresh beats a leak.
    """
    from shared.user_context import current_user_id

    uid = user_id or current_user_id()
    if not uid:
        logger.debug("API: dropping %s emit with no user bound", event)
        return
    room = user_room(uid)
    if payload is None:
        socketio.emit(event, room=room)
    else:
        socketio.emit(event, payload, room=room)
