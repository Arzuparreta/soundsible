import base64
import json
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from shared.community_identity import canonical_body, load_or_create_identity, signature_message, signed_request
from tests.conftest import TEST_USER_ID


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def test_community_identity_is_stable_and_private(isolated_runtime):
    first = load_or_create_identity(TEST_USER_ID)
    second = load_or_create_identity(TEST_USER_ID)

    assert first == second
    path = isolated_runtime.config_dir / "users" / TEST_USER_ID / "community_identity.json"
    assert path.exists()
    assert path.stat().st_mode & 0o777 == 0o600


def test_signed_request_covers_method_path_and_canonical_body():
    body = {"title": "Late set", "profile": {"display_name": "Arsu"}}
    encoded, headers = signed_request(
        TEST_USER_ID,
        "POST",
        "/v1/sessions",
        body,
        now=int(time.time()),
        nonce="fixed-nonce",
    )

    assert json.loads(encoded) == body
    public = Ed25519PublicKey.from_public_bytes(_decode(headers["X-Soundsible-Public-Key"]))
    public.verify(
        _decode(headers["X-Soundsible-Signature"]),
        signature_message(
            "POST",
            "/v1/sessions",
            headers["X-Soundsible-Timestamp"],
            "fixed-nonce",
            canonical_body(body),
        ),
    )
