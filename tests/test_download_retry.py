"""A flaky network costs a retry, never a CI run — and never a weaker check."""

from io import BytesIO
from pathlib import Path
import sys
from urllib.error import URLError

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import download_retry  # noqa: E402


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    waits = []
    monkeypatch.setattr(download_retry, "sleep", waits.append)
    return waits


def test_a_rejected_response_is_retried_until_one_passes(monkeypatch, no_waiting):
    bodies = iter([URLError("reset"), b"<html>error page</html>", b'{"ok": true}'])

    def answer(_url, **_kwargs):
        body = next(bodies)
        if isinstance(body, Exception):
            raise body
        return BytesIO(body)

    def json_only(_response, body):
        if not body.startswith(b"{"):
            raise download_retry.Rejected("not JSON")

    monkeypatch.setattr(download_retry, "urlopen", answer)
    assert download_retry.fetch(["https://example.invalid/a"], max_bytes=1024, validate=json_only) == b'{"ok": true}'
    assert len(no_waiting) == 2 and no_waiting[0] < no_waiting[1]


def test_an_oversized_body_is_never_accepted(monkeypatch):
    monkeypatch.setattr(download_retry, "urlopen", lambda _url, **_kwargs: BytesIO(b"x" * 11))
    with pytest.raises(RuntimeError, match="larger than 10 bytes"):
        download_retry.fetch(["https://example.invalid/a"], max_bytes=10, attempts=2)
