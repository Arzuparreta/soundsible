"""The credential a Subsonic client authenticates with.

Subsonic's handshake is ``t = md5(password + salt)``: the server verifies it by
computing the same digest, which means it has to hold the password in a form it
can read back. A pbkdf2 hash — what every account password in this instance is
— cannot answer that question, and no amount of care changes it.

So this is a **separate credential**, not the account password:

* minted per account, revocable on its own, and never reused anywhere else;
* stored encrypted with a key that lives in the config directory, so a copy of
  ``instance.db`` alone does not hand anyone a playable library;
* shown to its owner exactly once, at the moment it is generated.

The key file deliberately is not ``CredentialManager.generate_machine_key()``.
That derives from ``/etc/machine-id``, which is regenerated when a container is
rebuilt — every credential would go quietly unreadable and every client would
report "wrong password" with nothing to point at. The config directory is
already the volume an install is expected to keep.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import threading
from pathlib import Path
from typing import Any, Optional

from cryptography.fernet import Fernet, InvalidToken

from shared.subsonic.envelope import (
    ERR_BAD_API_KEY,
    ERR_BAD_CREDENTIALS,
    ERR_CONFLICTING_AUTH,
    ERR_MISSING_PARAMETER,
    SubsonicError,
)

logger = logging.getLogger(__name__)

KEY_FILENAME = "subsonic.key"

# Sixteen characters over an alphabet with no look-alikes (no 0/O, 1/l/I), in
# groups of four: eighty bits of entropy that somebody can still read off a
# screen and type into a phone.
_SECRET_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_SECRET_GROUPS = 4
_SECRET_GROUP_LEN = 4

_key_cache: dict[str, bytes] = {}
_key_lock = threading.Lock()


def _key_path() -> Path:
    from shared.runtime import get_config_dir

    return Path(get_config_dir()) / KEY_FILENAME


def _load_key() -> bytes:
    """The instance's Fernet key, created on first use with 0600 on the file."""
    path = _key_path()
    cache_key = str(path)
    with _key_lock:
        cached = _key_cache.get(cache_key)
        if cached:
            return cached

        if path.exists():
            existing = path.read_bytes().strip()
            if existing:
                _key_cache[cache_key] = existing
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
        _key_cache[cache_key] = key
        return key


def reset_key_cache() -> None:
    """Forget the cached key (tests, and a reconfigured runtime)."""
    with _key_lock:
        _key_cache.clear()


def generate_secret() -> str:
    groups = (
        "".join(secrets.choice(_SECRET_ALPHABET) for _ in range(_SECRET_GROUP_LEN))
        for _ in range(_SECRET_GROUPS)
    )
    return "-".join(groups)


def _encrypt(secret: str) -> str:
    return Fernet(_load_key()).encrypt(secret.encode("utf-8")).decode("ascii")


def _decrypt(secret_enc: str) -> Optional[str]:
    try:
        return Fernet(_load_key()).decrypt(secret_enc.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        # The key file was replaced or lost. Nothing here can recover the
        # credential; the owner regenerates one from Settings.
        logger.warning("Subsonic: stored credential could not be decrypted with the current key")
        return None


def _db():
    from shared.database import instance_db

    return instance_db()


def create_credential(user_id: str) -> str:
    """Mint a credential for this account, replacing any earlier one.

    Returns the plaintext — the only time it exists outside the client.
    """
    secret = generate_secret()
    _db().set_subsonic_credential(user_id, _encrypt(secret))
    return secret


def revoke_credential(user_id: str) -> bool:
    return _db().delete_subsonic_credential(user_id)


def credential_status(user_id: str) -> Optional[dict[str, Any]]:
    """What Settings may show: when it was made and last used, never the secret."""
    record = _db().get_subsonic_credential(user_id)
    if not record:
        return None
    return {
        "created_at": record.get("created_at"),
        "last_used_at": record.get("last_used_at"),
        "last_client": record.get("last_client"),
    }


def _stored_secret(user_id: str) -> Optional[str]:
    record = _db().get_subsonic_credential(user_id)
    if not record:
        return None
    return _decrypt(str(record.get("secret_enc") or ""))


def _decode_password(password: str) -> Optional[str]:
    """``p`` is either the secret or ``enc:`` followed by its hex bytes."""
    if not password.startswith("enc:"):
        return password
    try:
        return bytes.fromhex(password[4:]).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def authenticate(
    username: str,
    *,
    password: Optional[str] = None,
    token: Optional[str] = None,
    salt: Optional[str] = None,
    api_key: Optional[str] = None,
    client: Optional[str] = None,
) -> dict[str, Any]:
    """Resolve one request's credentials to an account, or raise.

    Every failure answers "wrong username or password". Which half was wrong,
    and whether the account exists at all, is not something an unauthenticated
    caller gets to learn.
    """
    from shared.users import get_user_by_username

    supplied = [name for name, value in (("p", password), ("t", token), ("apiKey", api_key)) if value]
    if not supplied:
        raise SubsonicError(ERR_MISSING_PARAMETER, "Required parameter 'p' is missing")
    if len(supplied) > 1:
        raise SubsonicError(ERR_CONFLICTING_AUTH)
    if token and not salt:
        raise SubsonicError(ERR_MISSING_PARAMETER, "Required parameter 's' is missing")

    if not username:
        raise SubsonicError(ERR_MISSING_PARAMETER, "Required parameter 'u' is missing")

    user = get_user_by_username(username)
    secret = _stored_secret(user["id"]) if user and not user.get("disabled") else None
    if not secret:
        # Still run a comparison so a username with no credential does not
        # answer measurably faster than one that has a wrong password.
        hmac.compare_digest(generate_secret(), password or token or api_key or "")
        raise SubsonicError(ERR_BAD_API_KEY if api_key else ERR_BAD_CREDENTIALS)

    if api_key:
        ok = hmac.compare_digest(api_key, secret)
        if not ok:
            raise SubsonicError(ERR_BAD_API_KEY)
    elif token:
        expected = hashlib.md5(f"{secret}{salt}".encode("utf-8")).hexdigest()
        ok = hmac.compare_digest(token.strip().lower(), expected)
        if not ok:
            raise SubsonicError(ERR_BAD_CREDENTIALS)
    else:
        decoded = _decode_password(password or "")
        ok = decoded is not None and hmac.compare_digest(decoded, secret)
        if not ok:
            raise SubsonicError(ERR_BAD_CREDENTIALS)

    _db().touch_subsonic_credential(user["id"], client)
    return user
