"""The cheap creator lookup that replaced a full extraction per row.

Eight rows used to cost ~5.2 s of `extract_info`; the same eight resolve in
~120 ms of oembed. It has to stay best-effort — a search that returns rows
without a creator is still a usable search, but one that raises is not.
"""

import sys
from unittest.mock import MagicMock

import pytest

for _module in ("yt_dlp", "mutagen", "mutagen.id3", "mutagen.mp3", "mutagen.flac"):
    if _module in sys.modules:
        continue
    try:
        __import__(_module)
    except Exception:
        sys.modules[_module] = MagicMock()

from odst_tool import youtube_downloader as yd  # noqa: E402

VID = "bSnlKl_PoQU"


class _Resp:
    def __init__(self, payload, ok=True):
        self._payload = payload
        self.ok = ok

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def _no_relay(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_YT_PROXY", raising=False)


def _patch_session(monkeypatch, fake_get):
    monkeypatch.setattr(yd, "_youtube_meta_session", lambda: MagicMock(get=fake_get))


def test_returns_the_channel(monkeypatch):
    seen = {}

    def fake_get(url, **kwargs):
        seen["url"] = url
        seen["params"] = kwargs.get("params")
        return _Resp({"author_name": "Queen - Topic"})

    _patch_session(monkeypatch, fake_get)

    assert yd._oembed_creator(VID) == "Queen - Topic"
    assert seen["url"] == yd._OEMBED_URL
    assert seen["params"]["url"] == f"https://www.youtube.com/watch?v={VID}"


def test_goes_through_the_relay_when_one_is_configured(monkeypatch):
    """It is a YouTube request like any other."""
    monkeypatch.setenv("SOUNDSIBLE_YT_PROXY", "http://relay.invalid:8888")
    seen = {}

    def fake_get(url, **kwargs):
        seen["proxies"] = kwargs.get("proxies")
        return _Resp({"author_name": "Queen"})

    _patch_session(monkeypatch, fake_get)
    yd._oembed_creator(VID)

    assert seen["proxies"] == {
        "http": "http://relay.invalid:8888",
        "https": "http://relay.invalid:8888",
    }


def test_a_bad_id_asks_nothing(monkeypatch):
    called = []
    _patch_session(monkeypatch, lambda url, **kw: called.append(1) or _Resp({}))

    assert yd._oembed_creator("not-an-id") is None
    assert called == []


@pytest.mark.parametrize(
    "response",
    [
        _Resp({}, ok=True),
        _Resp({"author_name": "   "}, ok=True),
        _Resp({"author_name": "Queen"}, ok=False),
    ],
    ids=["no author", "blank author", "http error"],
)
def test_an_unusable_answer_is_just_no_creator(monkeypatch, response):
    _patch_session(monkeypatch, lambda url, **kw: response)

    assert yd._oembed_creator(VID) is None


def test_a_network_failure_does_not_escape(monkeypatch):
    def boom(url, **kwargs):
        raise RuntimeError("relay down")

    _patch_session(monkeypatch, boom)

    assert yd._oembed_creator(VID) is None


def test_the_session_is_pooled_and_reused():
    first, second = yd._youtube_meta_session(), yd._youtube_meta_session()

    assert first is second
    adapter = first.get_adapter("https://www.youtube.com/")
    assert adapter._pool_maxsize >= 8, "a row of lookups runs in parallel"
