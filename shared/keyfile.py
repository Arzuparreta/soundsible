"""Fernet keys that live as a file in the config directory.

Some secrets have to be read back by the server: the Subsonic handshake needs
the password itself, and a scrobbling service needs the token it was given.
Those are stored encrypted, with the key in a file beside — not inside — the
database that holds the ciphertext, so a copy of one without the other hands
nobody a credential.

The key is a file rather than something derived from ``/etc/machine-id``
because a container gets a new machine id on every rebuild: every credential
would go quietly unreadable with nothing to point at. The config directory is
already the volume an install is expected to keep.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from cryptography.fernet import Fernet

_cache: dict[str, bytes] = {}
_lock = threading.Lock()


def fernet_key(path: Path) -> bytes:
    """The key stored at ``path``, created on first use with 0600 on the file."""
    cache_key = str(path)
    with _lock:
        cached = _cache.get(cache_key)
        if cached:
            return cached

        if path.exists():
            existing = path.read_bytes().strip()
            if existing:
                _cache[cache_key] = existing
                return existing

        key = Fernet.generate_key()
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            # O_EXCL rather than a plain write: two workers can reach this at
            # the same moment, and the loser must adopt the winner's key rather
            # than overwrite it and invalidate credentials already handed out.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            key = path.read_bytes().strip()
        else:
            with os.fdopen(fd, "wb") as handle:
                handle.write(key)
        _cache[cache_key] = key
        return key


def reset_key_cache() -> None:
    """Forget every cached key (tests, and a reconfigured runtime)."""
    with _lock:
        _cache.clear()
