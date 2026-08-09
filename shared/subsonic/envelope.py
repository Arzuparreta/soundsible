"""The Subsonic response envelope: one payload, three wire formats.

Every ``/rest`` endpoint answers with the same document — ``subsonic-response``
carrying either a result or an error — and the client picks how it wants it
spelled with ``f=xml|json|jsonp``. Writing three serializers by hand would mean
three chances to disagree, so views build one plain dict and this module maps
it:

    scalar  -> XML attribute      / JSON value
    dict    -> one child element  / JSON object
    list    -> repeated elements  / JSON array
    _text   -> element text       / JSON "value"

That mapping is the whole reason the payloads read like the protocol
documentation: ``{"artists": {"index": [{"name": "A", "artist": [...]}]}}`` is
already both ``<artists><index name="A"><artist …/></index></artists>`` and the
JSON the same clients accept.

Errors travel with **HTTP 200** on purpose. Subsonic puts the failure inside
the document, and clients that see a 4xx report "server unreachable" instead of
"wrong password", which is the least helpful message available.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional
from xml.etree import ElementTree as ET

from flask import Response, request

from shared.version import resolve_version

#: The protocol level we answer to. Clients gate features on this number.
API_VERSION = "1.16.1"
SERVER_TYPE = "soundsible"
XML_NAMESPACE = "http://subsonic.org/restapi"

#: Reserved payload key for an element's text content (``<lyrics>…</lyrics>``).
TEXT_KEY = "_text"

ERR_GENERIC = 0
ERR_MISSING_PARAMETER = 10
ERR_CLIENT_TOO_OLD = 20
ERR_SERVER_TOO_OLD = 30
ERR_BAD_CREDENTIALS = 40
ERR_TOKEN_AUTH_UNSUPPORTED = 41
ERR_AUTH_MECHANISM_UNSUPPORTED = 42
ERR_CONFLICTING_AUTH = 43
ERR_BAD_API_KEY = 44
ERR_NOT_AUTHORIZED = 50
ERR_NOT_FOUND = 70

_DEFAULT_MESSAGES = {
    ERR_GENERIC: "A generic error",
    ERR_MISSING_PARAMETER: "Required parameter is missing",
    ERR_CLIENT_TOO_OLD: "Incompatible Subsonic REST protocol version. Client must upgrade.",
    ERR_SERVER_TOO_OLD: "Incompatible Subsonic REST protocol version. Server must upgrade.",
    ERR_BAD_CREDENTIALS: "Wrong username or password",
    ERR_TOKEN_AUTH_UNSUPPORTED: "Token authentication not supported for this user",
    ERR_AUTH_MECHANISM_UNSUPPORTED: "Provided authentication mechanism not supported",
    ERR_CONFLICTING_AUTH: "Multiple conflicting authentication mechanisms provided",
    ERR_BAD_API_KEY: "Invalid API key",
    ERR_NOT_AUTHORIZED: "User is not authorized for the given operation",
    ERR_NOT_FOUND: "The requested data was not found",
}

# A JSONP callback is written straight into executable text, so it is matched
# against what a JavaScript identifier path may contain rather than escaped.
_CALLBACK_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$")


class SubsonicError(Exception):
    """A protocol-level failure, carrying the code the client switches on."""

    def __init__(self, code: int, message: Optional[str] = None):
        self.code = int(code)
        self.message = message or _DEFAULT_MESSAGES.get(self.code, "Request failed")
        super().__init__(self.message)


def _scalar(value: Any) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _build_xml(parent: ET.Element, payload: Mapping[str, Any]) -> None:
    for key, value in payload.items():
        if value is None:
            continue
        if key == TEXT_KEY:
            parent.text = _scalar(value)
        elif isinstance(value, Mapping):
            _build_xml(ET.SubElement(parent, key), value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                if isinstance(item, Mapping):
                    _build_xml(ET.SubElement(parent, key), item)
                else:
                    ET.SubElement(parent, key).text = _scalar(item)
        else:
            parent.set(key, _scalar(value))


def _jsonable(value: Any) -> Any:
    """The same tree with ``_text`` renamed to the key Subsonic's JSON uses."""
    if isinstance(value, Mapping):
        return {("value" if key == TEXT_KEY else key): _jsonable(item) for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def envelope(payload: Optional[Mapping[str, Any]] = None, *, error: Optional[SubsonicError] = None) -> dict[str, Any]:
    """The body of one ``subsonic-response``, result or failure."""
    body: dict[str, Any] = {
        "status": "failed" if error else "ok",
        "version": API_VERSION,
        "type": SERVER_TYPE,
        "serverVersion": resolve_version(),
        "openSubsonic": True,
    }
    if error is not None:
        body["error"] = {"code": error.code, "message": error.message}
    elif payload:
        body.update(payload)
    return body


def requested_format() -> str:
    raw = (request.values.get("f") or "xml").strip().lower()
    return raw if raw in ("xml", "json", "jsonp") else "xml"


def respond(payload: Optional[Mapping[str, Any]] = None, *, error: Optional[SubsonicError] = None) -> Response:
    """Serialize one response in the format this request asked for."""
    body = envelope(payload, error=error)
    fmt = requested_format()

    if fmt in ("json", "jsonp"):
        text = json.dumps({"subsonic-response": _jsonable(body)}, ensure_ascii=False)
        if fmt == "jsonp":
            callback = (request.values.get("callback") or "").strip()
            if not _CALLBACK_RE.match(callback):
                # Answering in JSONP is impossible without a name to call, and
                # answering in JSON would be executed as a script by whatever
                # loaded this. XML is the format the protocol falls back to.
                return respond_xml(envelope(error=SubsonicError(ERR_MISSING_PARAMETER, "Required parameter 'callback' is missing")))
            return _response(f"{callback}({text});", "application/javascript")
        return _response(text, "application/json")

    return respond_xml(body)


def respond_xml(body: Mapping[str, Any]) -> Response:
    root = ET.Element("subsonic-response", {"xmlns": XML_NAMESPACE})
    _build_xml(root, body)
    text = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")
    return _response(text, "text/xml")


def _response(text: str, mimetype: str) -> Response:
    response = Response(text, status=200, mimetype=mimetype)
    response.headers["Content-Type"] = f"{mimetype}; charset=utf-8"
    # Nothing here is worth a shared cache, and several endpoints answer
    # differently per account.
    response.headers["Cache-Control"] = "no-store"
    return response


def error_response(code: int, message: Optional[str] = None) -> Response:
    return respond(error=SubsonicError(code, message))
