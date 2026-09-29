"""Stream tokens for podcast episodes that are not downloaded: every one the
engine mints has to be one it accepts back."""

import base64
from unittest.mock import patch

import pytest

import shared.podcast_preview_token as token

URL = "https://dts.podtrac.com/redirect.mp3/cdn.example.com/episode.mp3"


@pytest.fixture(autouse=True)
def _key():
    with patch.object(token, "_signing_key_bytes", return_value=b"k" * 32):
        yield


def _minted_at(now: int) -> str:
    with patch.object(token.time, "time", return_value=now):
        return token.mint_enclosure_stream_token(URL)[0]


def _raw(minted: str) -> bytes:
    return base64.urlsafe_b64decode(minted + "=" * (-len(minted) % 4))


def test_every_minted_token_is_accepted_whatever_bytes_its_signature_holds():
    # The signature is raw bytes after a "." separator. About one signature in
    # nine holds a "." of its own, and the token was cut there and refused, so
    # the episode failed to play for that second.
    start = 1_800_000_000
    minted = [_minted_at(start + n) for n in range(300)]
    assert any(b"." in _raw(m)[-32:] for m in minted)
    with patch.object(token.time, "time", return_value=start):
        assert all(token.decode_enclosure_stream_token(m) == {"enclosure_url": URL} for m in minted)


def test_a_token_with_a_changed_signature_or_url_is_refused():
    minted = _raw(_minted_at(1_800_000_000))
    forged_sig = minted[:-1] + bytes([minted[-1] ^ 1])
    forged_url = minted.replace(b"episode.mp3", b"episode.mp4")
    with patch.object(token.time, "time", return_value=1_800_000_000):
        for raw in (forged_sig, forged_url, minted[:-33], minted[-32:]):
            assert token.decode_enclosure_stream_token(base64.urlsafe_b64encode(raw).decode().rstrip("=")) is None


def test_an_expired_token_is_refused():
    minted = _minted_at(1_800_000_000)
    with patch.object(token.time, "time", return_value=1_800_000_000 + token._TOKEN_TTL_SEC + 1):
        assert token.decode_enclosure_stream_token(minted) is None
