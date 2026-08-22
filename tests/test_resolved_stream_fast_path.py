"""The cheap resolution path, and what happens when it stops working.

Resolving a stream used to make yt-dlp fetch the video's watch page — about
1 MB — purely to pick a session identifier out of it, and then ask three player
clients for formats when only one of them yields any. Asking `android_vr`
directly with a reused identifier measured 2658 ms and 1590 KB down to 1774 ms
and 451 KB on a relayed station.

That path leans on two things YouTube can withdraw at any time, so the contract
under test is as much about the fallback as about the shortcut:
- with an identifier, the first attempt is the cheap one,
- without one, nothing changes from before,
- a rejected identifier is dropped, not reused, and the old path still answers.
"""

import sys
from unittest.mock import MagicMock

import pytest

# Same contract as test_youtube_downloader_search: prefer the real dependency
# when it is installed, stub only what is missing, and never stub over a module
# another test already imported for real.
for _module in ("yt_dlp", "mutagen", "mutagen.id3", "mutagen.mp3", "mutagen.flac"):
    if _module in sys.modules:
        continue
    try:
        __import__(_module)
    except Exception:
        sys.modules[_module] = MagicMock()

from odst_tool import youtube_downloader as yd  # noqa: E402

VID = "dQw4w9WgXcQ"
STREAM_URL = "https://cdn.invalid/audio.m4a?expire=99999999999"


class _RecordingYDL:
    """Records the options of every yt-dlp instantiation; answers in order."""

    instances: list[dict] = []
    responses: list[object] = []

    def __init__(self, opts):
        self.opts = opts
        type(self).instances.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass

    def extract_info(self, url, download=False):
        index = len(type(self).instances) - 1
        responses = type(self).responses
        answer = responses[index] if index < len(responses) else {"url": STREAM_URL, "vcodec": "none"}
        if isinstance(answer, Exception):
            raise answer
        return answer


@pytest.fixture
def downloader(monkeypatch, tmp_path):
    _RecordingYDL.instances = []
    _RecordingYDL.responses = []
    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _RecordingYDL)
    monkeypatch.delenv("SOUNDSIBLE_YT_PROXY", raising=False)
    yd._reset_visitor_data_cache()
    dl = yd.YouTubeDownloader(output_dir=tmp_path)
    yield dl
    yd._reset_visitor_data_cache()


def _clients(opts):
    return (opts.get("extractor_args", {}).get("youtube", {}) or {}).get("player_client")


def _skips(opts):
    return (opts.get("extractor_args", {}).get("youtube", {}) or {}).get("player_skip")


def test_first_attempt_is_the_cheap_one(downloader, monkeypatch):
    monkeypatch.setattr(yd, "_youtube_visitor_data", lambda: "CgtWaXNpdG9yRGF0YQ")

    resolved = downloader.get_resolved_stream(VID)

    assert resolved is not None
    assert resolved.url == STREAM_URL
    assert len(_RecordingYDL.instances) == 1, "the cheap attempt must answer on its own"
    first = _RecordingYDL.instances[0]
    assert _clients(first) == ["android_vr"]
    assert _skips(first) == ["webpage", "configs"]
    assert first["extractor_args"]["youtube"]["visitor_data"] == ["CgtWaXNpdG9yRGF0YQ"]


def test_without_an_identifier_the_old_path_runs(downloader, monkeypatch):
    monkeypatch.setattr(yd, "_youtube_visitor_data", lambda: None)

    resolved = downloader.get_resolved_stream(VID)

    assert resolved is not None
    assert len(_RecordingYDL.instances) == 1
    assert _clients(_RecordingYDL.instances[0]) == ["default", "android", "ios"]
    assert _skips(_RecordingYDL.instances[0]) is None


def test_a_rejected_identifier_falls_back_and_is_dropped(downloader, monkeypatch):
    """YouTube can invalidate an identifier at any moment. When it does, the
    listener must still get audio, and the next resolution must not reuse it."""
    monkeypatch.setattr(yd, "_youtube_visitor_data", lambda: "CgtTdGFsZQ")
    _RecordingYDL.responses = [
        Exception("Sign in to confirm you're not a bot"),
        {"url": STREAM_URL},
    ]

    resolved = downloader.get_resolved_stream(VID)

    assert resolved is not None, "the fallback path must still answer"
    assert resolved.url == STREAM_URL
    assert len(_RecordingYDL.instances) == 2
    assert _clients(_RecordingYDL.instances[0]) == ["android_vr"]
    assert _clients(_RecordingYDL.instances[1]) == ["default", "android", "ios"]
    assert yd._visitor_data_cache["value"] is None, "a rejected identifier must not be kept"


def test_skip_fast_path_goes_straight_to_the_fallback(downloader, monkeypatch):
    """The CDN, not extraction, is what rejects a PO-token-gated `android_vr`
    URL — the caller retrying after that rejection has to say so explicitly,
    because a fresh visitor identifier would otherwise look just as usable as
    the one that was rejected and send the retry right back into the wall."""
    monkeypatch.setattr(yd, "_youtube_visitor_data", lambda: "CgtWaXNpdG9yRGF0YQ")

    resolved = downloader.get_resolved_stream(VID, skip_fast_path=True)

    assert resolved is not None, "the fallback path must still answer"
    assert resolved.url == STREAM_URL
    assert len(_RecordingYDL.instances) == 1, "no attempt spent on the client that was just rejected"
    assert _clients(_RecordingYDL.instances[0]) == ["default", "android", "ios"]


def test_muxed_fast_path_is_rejected_before_it_can_poison_prefetch(downloader, monkeypatch):
    """A degraded visitor session can expose only itag 18. Extraction succeeds,
    but those URLs were the exact five durable entries rejected in the incident;
    the fast path must fall through to an audio-only client result instead."""
    monkeypatch.setattr(yd, "_youtube_visitor_data", lambda: "CgtEZWdyYWRlZA")
    _RecordingYDL.responses = [
        {"url": "https://cdn.invalid/itag18?expire=99999999999", "format_id": "18", "vcodec": "avc1.42001E"},
        {"url": STREAM_URL, "format_id": "140", "vcodec": "none"},
    ]

    resolved = downloader.get_resolved_stream(VID)

    assert resolved is not None and resolved.url == STREAM_URL
    assert len(_RecordingYDL.instances) == 2
    assert _clients(_RecordingYDL.instances[0]) == ["android_vr"]
    assert _clients(_RecordingYDL.instances[1]) == ["default", "android", "ios"]


def test_relay_egress_is_carried_by_the_cheap_path(downloader, monkeypatch):
    """The CDN signs the resolving address into the URL, so the egress that
    resolved has to travel with the result."""
    monkeypatch.setenv("SOUNDSIBLE_YT_PROXY", "http://relay.invalid:8888")
    monkeypatch.setattr(yd, "_youtube_visitor_data", lambda: "CgtWaXNpdG9y")

    resolved = downloader.get_resolved_stream(VID)

    assert resolved is not None
    assert resolved.egress == "relay"
    assert resolved.requests_proxies() == {
        "http": "http://relay.invalid:8888",
        "https": "http://relay.invalid:8888",
    }
    assert _RecordingYDL.instances[0]["proxy"] == "http://relay.invalid:8888"


def test_identifier_is_fetched_once_and_reused(monkeypatch):
    """It is not per-video; refetching it per resolution would give back the
    round trip the shortcut just saved."""
    yd._reset_visitor_data_cache()
    calls = []

    class _Resp:
        text = '[["CgtjYWNoZWRWYWx1ZUZvclRlc3RpbmdMb25nRW5vdWdo"]]'

        def raise_for_status(self):
            pass

    def fake_get(url, **kwargs):
        calls.append(url)
        return _Resp()

    monkeypatch.delenv("SOUNDSIBLE_YT_PROXY", raising=False)
    monkeypatch.setattr(yd.requests, "get", fake_get)

    first = yd._youtube_visitor_data()
    second = yd._youtube_visitor_data()

    assert first == second == "CgtjYWNoZWRWYWx1ZUZvclRlc3RpbmdMb25nRW5vdWdo"
    assert len(calls) == 1
    yd._reset_visitor_data_cache()


def test_identifier_lookup_goes_through_the_relay(monkeypatch):
    """It is a YouTube request like any other: from a station that needs the
    relay to talk to YouTube, this one needs it too."""
    yd._reset_visitor_data_cache()
    seen = {}

    class _Resp:
        text = '[["CgtWaWFSZWxheVZhbHVlTG9uZ0Vub3VnaEZvclBhcnNl"]]'

        def raise_for_status(self):
            pass

    def fake_get(url, **kwargs):
        seen["proxies"] = kwargs.get("proxies")
        return _Resp()

    monkeypatch.setenv("SOUNDSIBLE_YT_PROXY", "http://relay.invalid:8888")
    monkeypatch.setattr(yd.requests, "get", fake_get)

    yd._youtube_visitor_data()

    assert seen["proxies"] == {
        "http": "http://relay.invalid:8888",
        "https": "http://relay.invalid:8888",
    }
    yd._reset_visitor_data_cache()


def test_a_failed_identifier_lookup_is_not_fatal(monkeypatch):
    yd._reset_visitor_data_cache()
    monkeypatch.delenv("SOUNDSIBLE_YT_PROXY", raising=False)

    def boom(url, **kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(yd.requests, "get", boom)

    assert yd._youtube_visitor_data() is None
