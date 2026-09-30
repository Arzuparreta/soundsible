"""
Plain-text helpers for user-visible strings (e.g. API errors from CLI tools).
"""

import re
import unicodedata

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


_TOKEN = re.compile(r"\w+", re.UNICODE)


_RELEASE_JUNK = re.compile(
    r"\s*[\(\[][^\)\]]*\b("
    r"official|video|audio|lyrics?|hd|4k|8k|remaster(?:ed)?|mv|visuali[sz]er|"
    r"full album|topic|explicit|clean|hq|music video"
    r")\b[^\)\]]*[\)\]]",
    re.IGNORECASE,
)


def fold_text(value: object) -> str:
    """`normalize_text` with diacritics folded away. For matching, never display.

    Deliberately separate from `normalize_text`, which many exact comparisons
    rely on: folding accents there would change what matches what in each of
    them at once.

    Case is folded *before* decomposition so `Straße` still reaches `strasse`,
    and only combining marks are dropped rather than forcing ASCII — an
    ascii-encode would flatten every Cyrillic or CJK title to an empty string
    and make them all match each other.
    """
    text = normalize_text(value)
    return "".join(ch for ch in unicodedata.normalize("NFD", text) if not unicodedata.combining(ch))


def match_tokens(value: object) -> tuple[str, ...]:
    """Word tokens of the folded text: ``In Rainbows!`` -> ``('in', 'rainbows')``."""
    return tuple(_TOKEN.findall(fold_text(value)))


def strip_release_junk(value: object) -> str:
    """Drop bracketed format/release annotations from a title.

    `Creep (Official Video) [HD Remaster]` is the same recording as `Creep`, but
    it is four times as long — and any relevance score that weighs how much of a
    title the query accounts for would punish it for boilerplate the uploader
    added. Only format words are matched, so `(Live)`, `(Remix)` and `(Acoustic)`
    survive: those distinguish genuinely different recordings.
    """
    return collapse_text(_RELEASE_JUNK.sub("", collapse_text(value)))


def identity_key(title: object, artist: object) -> str:
    """The `artist\\x00title` key used to match catalog rows against the library.

    It only answers "is this catalog song already held?", so it is folded: tags
    drop diacritics the catalog keeps, and a library's "Blue Oyster Cult" song
    is Deezer's "Blue Öyster Cult" one.

    The separator is a NUL so it cannot occur inside either field, which keeps
    ("a b", "c") and ("a", "b c") distinct.
    """
    return f"{fold_text(artist)}\x00{fold_text(title)}"
