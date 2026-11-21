"""Lightweight bridge for notifying the discovery feed of new user signals.

``shared.api`` binds the Flask application at import time, so modules outside
``shared/api/`` (library intake, migration workers) cannot import
``shared.api.routes.discovery_feed`` without breaking the layering boundary.
Like :mod:`shared.realtime`, this module has no web-framework dependencies:
callers notify through here, and ``discovery_feed`` registers its handler when
loaded.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

logger = logging.getLogger(__name__)

_HANDLER_LOCK = threading.Lock()
_HANDLER: Optional[Callable[..., bool]] = None


def register_discovery_signal_handler(handler: Optional[Callable[..., bool]]) -> None:
    """Register (or clear) the handler invoked when a discovery signal lands."""
    global _HANDLER
    with _HANDLER_LOCK:
        _HANDLER = handler


def notify_discovery_signal(user_id: Optional[str] = None, *, always_refresh: bool = False) -> bool:
    """Notify the registered discovery feed handler, returning whether a refresh ran."""
    with _HANDLER_LOCK:
        handler = _HANDLER
    if handler is None:
        return False
    try:
        return bool(handler(user_id, always_refresh=always_refresh))
    except Exception:
        logger.debug("Discovery signal handler failed", exc_info=True)
        return False
