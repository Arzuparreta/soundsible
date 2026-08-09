"""Soundsible's OpenSubsonic surface.

``shared/api/routes/subsonic.py`` holds the ``/rest`` views; everything they
need to decide, encode or authenticate lives here so it can be tested without
a request.
"""

from .envelope import (  # noqa: F401
    API_VERSION,
    ERR_BAD_CREDENTIALS,
    ERR_GENERIC,
    ERR_MISSING_PARAMETER,
    ERR_NOT_AUTHORIZED,
    ERR_NOT_FOUND,
    SubsonicError,
    error_response,
    envelope,
    respond,
)

__all__ = [
    "API_VERSION",
    "ERR_BAD_CREDENTIALS",
    "ERR_GENERIC",
    "ERR_MISSING_PARAMETER",
    "ERR_NOT_AUTHORIZED",
    "ERR_NOT_FOUND",
    "SubsonicError",
    "envelope",
    "error_response",
    "respond",
]
