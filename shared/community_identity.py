"""Stable, local-only identity used by Soundsible Community.

The private key belongs to one local Soundsible account and never leaves the
station. Public community requests are signed here so the browser cannot leak
the key and the community service never needs a Soundsible password or cookie.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from shared.user_context import user_config_dir

IDENTITY_FILENAME = "community_identity.json"


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def canonical_body(body: Any) -> bytes:
    return json.dumps(
        body if body is not None else {},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def signature_message(method: str, path: str, timestamp: str, nonce: str, body: bytes) -> bytes:
    digest = hashlib.sha256(body).hexdigest()
    return f"{timestamp}\n{nonce}\n{method.upper()}\n{path}\n{digest}".encode("utf-8")


def _identity_path(user_id: str) -> Path:
    return user_config_dir(user_id) / IDENTITY_FILENAME


def _write_private(path: Path, payload: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, encoded.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def load_or_create_identity(user_id: str) -> dict[str, str]:
    path = _identity_path(user_id)
    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
        private_raw = base64.urlsafe_b64decode(raw["private_key"] + "==")
        key = Ed25519PrivateKey.from_private_bytes(private_raw)
    else:
        key = Ed25519PrivateKey.generate()
        private_raw = key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        _write_private(path, {"version": "1", "private_key": _b64url(private_raw)})

    public_raw = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    community_id = _b64url(hashlib.sha256(public_raw).digest()[:18])
    return {
        "community_id": community_id,
        "public_key": _b64url(public_raw),
        "private_key": _b64url(private_raw),
    }


def signed_request(
    user_id: str,
    method: str,
    path: str,
    body: Any,
    *,
    now: int | None = None,
    nonce: str | None = None,
) -> tuple[bytes, dict[str, str]]:
    identity = load_or_create_identity(user_id)
    encoded = canonical_body(body)
    timestamp = str(int(time.time() if now is None else now))
    request_nonce = nonce or secrets.token_urlsafe(18)
    key_raw = base64.urlsafe_b64decode(identity["private_key"] + "==")
    signature = Ed25519PrivateKey.from_private_bytes(key_raw).sign(
        signature_message(method, path, timestamp, request_nonce, encoded)
    )
    headers = {
        "Content-Type": "application/json",
        "X-Soundsible-Community-Id": identity["community_id"],
        "X-Soundsible-Public-Key": identity["public_key"],
        "X-Soundsible-Signature": _b64url(signature),
        "X-Soundsible-Timestamp": timestamp,
        "X-Soundsible-Nonce": request_nonce,
    }
    return encoded, headers
