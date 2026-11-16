"""The Socket.IO server and the per-account rooms events go to.

The server is created here without an application; `shared.api` binds it to
the Flask app. Anything that tells clients about a change (downloads, the
library, loudness) imports it from here instead of from the Flask module.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from flask_socketio import SocketIO

logger = logging.getLogger(__name__)

socketio = SocketIO()

USER_ROOM_PREFIX = "user:"


def user_room(user_id: str) -> str:
    """Socket.IO room carrying one person's library and downloader events."""
    return f"{USER_ROOM_PREFIX}{user_id}"


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
