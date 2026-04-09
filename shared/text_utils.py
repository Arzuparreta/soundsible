"""
Plain-text helpers for user-visible strings (e.g. API errors from CLI tools).
"""

import re

# Standard ANSI CSI sequences (ECMA-48).
_ANSI_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
# yt-dlp / stderr sometimes surfaces bracket color codes without ESC (e.g. "[0;31m").
_BRACKET_SGR = re.compile(r"\[[0-9;]*m")


def strip_ansi(text: str) -> str:
    """Remove ANSI escape / SGR-like sequences from a string."""
    if not text:
        return text
    s = _ANSI_CSI.sub("", text)
    s = _BRACKET_SGR.sub("", s)
    return s


def sanitize_cli_message(text: str) -> str:
    """Strip terminal junk from subprocess/yt-dlp messages for JSON / web UI."""
    return strip_ansi(text or "").strip()
