"""One shape for API errors, and one place unhandled ones are turned into it.

Error responses used to be hand-built per route, so the same failure answered
`{"error": ...}` in one place, `{"status": "failed", "reason": ...}` in another,
and `{"error": ..., "results": []}` in a third — and anything the route did not
anticipate escaped as Flask's HTML 500 page, which a JSON client cannot read.
Several handlers also reported crashes with `traceback.print_exc()`, which
bypasses logging entirely and never reaches the log file the desktop app ships.

`api_error` builds the body; `register_error_handlers` catches what is left.
Existing bodies are not rewritten wholesale — the client reads specific keys in
places — so this is the floor, not a migration.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

logger = logging.getLogger(__name__)


def api_error(message: str, status: int = 400, *, code: Optional[str] = None, **extra: Any):
    """A JSON error response: `({"error": message, "code": code, ...}, status)`.

    `code` is the machine-readable half — the client switches on it, while
    `message` is only ever shown to a person.
    """
    body: dict[str, Any] = {"error": message}
    if code:
        body["code"] = code
    body.update(extra)
    return jsonify(body), status


def register_error_handlers(app: Flask) -> None:
    """Make every unhandled failure a JSON response, and log it once."""

    @app.errorhandler(HTTPException)
    def _http_exception(exc: HTTPException):
        # 404s and 405s are routine; anything else is worth a line.
        if exc.code and exc.code >= 500:
            logger.warning("API: %s on %s: %s", exc.code, request.path, exc.description)
        return api_error(exc.description or exc.name, exc.code or 500, code=exc.name.lower().replace(" ", "_"))

    @app.errorhandler(Exception)
    def _unhandled(exc: Exception):
        # `logger.exception` rather than `traceback.print_exc()`: the desktop
        # build writes logs to a file, and print goes nowhere the user can find.
        logger.exception("API: unhandled error on %s %s", request.method, request.path)
        return api_error("Internal server error", 500, code="internal_error")
