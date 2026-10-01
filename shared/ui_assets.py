"""Serve build-time compressed UI assets with representation-specific validators."""

import mimetypes
from pathlib import Path

from flask import abort, request, send_from_directory
from werkzeug.utils import safe_join

_TEXT_SUFFIXES = {".js", ".css", ".svg", ".html", ".json", ".webmanifest"}


def serve_ui_asset(root: str, filename: str):
    original = safe_join(root, filename)
    if original is None or not Path(original).is_file():
        abort(404)
    if Path(filename).suffix.lower() not in _TEXT_SUFFIXES:
        return send_from_directory(root, filename)

    accepted = request.accept_encodings
    explicit = {name.lower() for name, _quality in accepted}
    identity_allowed = accepted["identity"] > 0 if "identity" in explicit else not (
        "*" in explicit and accepted["*"] == 0
    )
    selected = None
    if not request.headers.get("Range"):
        available = [encoding for encoding, suffix in (("br", ".br"), ("gzip", ".gz"))
                     if Path(original + suffix).is_file()]
        selected = accepted.best_match(available)
        if "identity" in explicit and accepted["identity"] > accepted[selected or "identity"]:
            selected = None
    if selected is None and not identity_allowed:
        abort(406)

    served = filename + ({"br": ".br", "gzip": ".gz"}[selected] if selected else "")
    response = send_from_directory(root, served, mimetype=mimetypes.guess_type(filename)[0])
    response.vary.add("Accept-Encoding")
    if selected:
        response.headers["Content-Encoding"] = selected
    return response
