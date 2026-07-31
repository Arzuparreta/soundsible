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


# ── Matching helpers ─────────────────────────────────────────────────────────
# Deliberately only the forms that were byte-identical in several places. The
# other `_norm`/`_clean` helpers around the codebase look similar but are not:
# `resolution_confidence._norm` also strips punctuation and filler words, and
# `discovery_intelligence._norm` deliberately leaves internal whitespace alone.
# Folding those together here would change what matches what.


def collapse_text(value: object, limit: int | None = None) -> str:
    """Trim, collapse runs of whitespace, and optionally truncate."""
    text = " ".join(str(value or "").strip().split())
    return text[:limit] if limit is not None else text


def normalize_text(value: object) -> str:
    """`collapse_text` folded for case-insensitive comparison."""
    return collapse_text(value).casefold()


def identity_key(title: object, artist: object) -> str:
    """The `artist\\x00title` key used to match catalog rows against the library.

    The separator is a NUL so it cannot occur inside either field, which keeps
    ("a b", "c") and ("a", "b c") distinct.
    """
    return f"{normalize_text(artist)}\x00{normalize_text(title)}"
