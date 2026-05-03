"""Short-lived signed tokens for podcast enclosure preview streaming."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from shared.constants import DEFAULT_CONFIG_DIR

_TOKEN_TTL_SEC = 900
_TOKEN_VER = "v1"


def _signing_key_bytes() -> bytes:
    d = Path(DEFAULT_CONFIG_DIR).expanduser()
    d.mkdir(parents=True, exist_ok=True)
    p = d / ".podcast_preview_hmac"
    if p.exists():
        try:
            raw = p.read_bytes()
            if len(raw) >= 16:
                return raw
        except OSError:
            pass
    k = secrets.token_bytes(32)
    try:
        p.write_bytes(k)
    except OSError:
        pass
    return k


def mint_enclosure_stream_token(enclosure_url: str) -> Tuple[str, int]:
    """Return (token_b64url, expires_at_unix)."""
    expires = int(time.time()) + _TOKEN_TTL_SEC
    payload = {"v": _TOKEN_VER, "u": enclosure_url, "exp": expires}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_signing_key_bytes(), body, hashlib.sha256).digest()
    bundle = base64.urlsafe_b64encode(body + b"." + sig).decode("ascii").rstrip("=")
    return bundle, expires


def decode_enclosure_stream_token(token: str) -> Optional[Dict[str, Any]]:
    if not token or not isinstance(token, str):
        return None
    pad = "=" * (-len(token) % 4)
    try:
        raw = base64.urlsafe_b64decode(token + pad)
    except Exception:
        return None
    if b"." not in raw:
        return None
    body_b, sig_b = raw.rsplit(b".", 1)
    exp_sig = hmac.new(_signing_key_bytes(), body_b, hashlib.sha256).digest()
    if not hmac.compare_digest(exp_sig, sig_b):
        return None
    try:
        payload = json.loads(body_b.decode("utf-8"))
    except Exception:
        return None
    if payload.get("v") != _TOKEN_VER:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    url = payload.get("u")
    if not isinstance(url, str) or not url.strip():
        return None
    return {"enclosure_url": url.strip()}
