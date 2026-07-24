"""
Per-user request context and user-scoped app directories.

One engine process serves several people. Instance-level state — storage
backend, music folder, shared caches, the physical track pool — keeps living
under the runtime directories from :mod:`shared.runtime`. Everything that
belongs to a person (library manifest, favourites, queue, playback state,
listening history, preferences) lives under ``<base>/users/<user_id>/``.

The active user is bound per request by the ``before_request`` hook in
:mod:`shared.api`, and explicitly by background work through
:func:`user_context`. Asking for a user directory with nobody bound raises
:class:`NoUserBound` on purpose: a forgotten bind has to fail loudly instead of
quietly writing one person's data into the instance directory — or worse, into
somebody else's.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from contextvars import ContextVar, Token
from pathlib import Path
from typing import Iterator, Optional

from shared.runtime import get_config_dir, get_data_dir

USERS_DIRNAME = "users"

# User ids are generated as UUID4 hex, but they end up as path segments, so the
# validator stays strict rather than trusting the generator.
_USER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

_current_user_id: ContextVar[Optional[str]] = ContextVar("soundsible_user_id", default=None)


class NoUserBound(RuntimeError):
    """Raised when user-scoped state is requested outside a bound user context."""


class InvalidUserId(ValueError):
    """Raised when a user id would not be safe to use as a path segment."""


def validate_user_id(user_id: str) -> str:
    """Return ``user_id`` if it is safe as a directory name, else raise."""
    candidate = str(user_id or "").strip()
    if not _USER_ID_RE.match(candidate):
        raise InvalidUserId(f"Unsafe user id: {user_id!r}")
    return candidate


def current_user_id() -> Optional[str]:
    """Return the user bound to this request/task, or ``None``."""
    return _current_user_id.get()


def require_user_id() -> str:
    """Return the bound user id, raising :class:`NoUserBound` when there is none."""
    user_id = _current_user_id.get()
    if not user_id:
        raise NoUserBound(
            "No user is bound to this context. Wrap background work in "
            "user_context(user_id); requests are bound by shared.api.before_request."
        )
    return user_id


def bind_user(user_id: Optional[str]) -> Token:
    """Bind ``user_id`` for the current context. Returns a token for :func:`unbind_user`."""
    if user_id is None:
        return _current_user_id.set(None)
    return _current_user_id.set(validate_user_id(user_id))


def unbind_user(token: Token) -> None:
    """Restore whatever user was bound before the matching :func:`bind_user`."""
    _current_user_id.reset(token)


@contextmanager
def user_context(user_id: Optional[str]) -> Iterator[Optional[str]]:
    """Bind ``user_id`` for the duration of the block (background tasks, tests)."""
    token = bind_user(user_id)
    try:
        yield user_id
    finally:
        unbind_user(token)


# ---------------------------------------------------------------------------
# Directories
# ---------------------------------------------------------------------------


def users_config_root() -> Path:
    """Instance-level parent of every user's config directory."""
    return get_config_dir() / USERS_DIRNAME


def users_data_root() -> Path:
    """Instance-level parent of every user's data directory."""
    return get_data_dir() / USERS_DIRNAME


def user_config_dir(user_id: Optional[str] = None, *, create: bool = True) -> Path:
    """Config directory for ``user_id`` (default: the bound user)."""
    uid = validate_user_id(user_id) if user_id else require_user_id()
    path = users_config_root() / uid
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def user_data_dir(user_id: Optional[str] = None, *, create: bool = True) -> Path:
    """Data directory for ``user_id`` (default: the bound user)."""
    uid = validate_user_id(user_id) if user_id else require_user_id()
    path = users_data_root() / uid
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def user_id_from_path(path: Path) -> Optional[str]:
    """Recover the user id from a path under ``users_config_root()``, if it is one.

    Used by the library file watcher, which sees absolute paths and has to map
    them back to whoever owns the manifest that changed.
    """
    try:
        relative = Path(path).resolve().relative_to(users_config_root().resolve())
    except (ValueError, OSError):
        return None
    if not relative.parts:
        return None
    try:
        return validate_user_id(relative.parts[0])
    except InvalidUserId:
        return None
