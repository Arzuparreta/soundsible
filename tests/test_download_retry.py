"""A flaky network costs a retry, never a CI run — and never a weaker check."""

from io import BytesIO
from pathlib import Path
import sys
import hashlib
from urllib.error import HTTPError, URLError

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


def test_official_asset_fallback_keeps_headers_and_checksum_validation(monkeypatch):
    body = b"pinned archive bytes"
    urls = ["https://github.com/owner/repo/releases/download/tag/archive", "https://api.github.com/repos/owner/repo/releases/assets/123"]
    calls = []
    def answer(request, **_kwargs):
        calls.append(request)
        if len(calls) == 1:
            raise HTTPError(request.full_url, 504, "Gateway Time-out", None, None)
        return BytesIO(body)
    monkeypatch.setattr(download_retry, "urlopen", answer)
    assert download_retry.fetch(urls, max_bytes=1024, sha256=hashlib.sha256(body).hexdigest(),
                                headers={"Accept": "application/octet-stream"}, attempts=2) == body
    assert [request.full_url for request in calls] == urls
    assert all(request.get_header("Accept") == "application/octet-stream" for request in calls)


def test_asset_api_json_or_wrong_bytes_never_bypass_checksum(monkeypatch):
    monkeypatch.setattr(download_retry, "urlopen", lambda _request, **_kwargs: BytesIO(b'{"asset": "metadata"}'))
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        download_retry.fetch(["https://api.github.com/repos/owner/repo/releases/assets/123"], max_bytes=1024,
                             sha256=hashlib.sha256(b"pinned archive bytes").hexdigest(), attempts=2,
                             headers={"Accept": "application/octet-stream"})
