from pathlib import Path
import sys
from unittest.mock import MagicMock

for _module in ("yt_dlp", "mutagen", "mutagen.id3", "mutagen.mp3", "mutagen.flac"):
    if _module not in sys.modules:
        sys.modules[_module] = MagicMock()

from odst_tool import youtube_downloader as yd


class _FakeYoutubeDL:
    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def extract_info(self, search_input, download=False):
        assert "music.youtube.com/search" in search_input
        return {
            "entries": [
                {
                    "id": "bSnlKl_PoQU",
                    "title": "Bohemian Rhapsody",
                    "url": "https://music.youtube.com/watch?v=bSnlKl_PoQU",
                }
            ]
        }


def test_ytmusic_search_enriches_flat_entries_with_artist(monkeypatch, tmp_path):
    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _FakeYoutubeDL)

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))

    def fake_peek_brief(video_id):
        assert video_id == "bSnlKl_PoQU"
        return {
            "id": video_id,
            "title": "Bohemian Rhapsody (Remastered 2011)",
            "artist": "Queen",
            "channel": "Queen",
            "duration": 354,
            "thumbnail": "https://example.test/queen.webp",
        }

    monkeypatch.setattr(downloader, "peek_brief", fake_peek_brief)

    results = downloader.search_youtube("bohemian rhapsody", max_results=1, use_ytmusic=True)

    assert results == [
        {
            "id": "bSnlKl_PoQU",
            "title": "Bohemian Rhapsody",
            "duration": 354,
            "thumbnail": "https://img.youtube.com/vi/bSnlKl_PoQU/mqdefault.jpg",
            "webpage_url": "https://www.youtube.com/watch?v=bSnlKl_PoQU",
            "channel": "Queen",
            "artist": "Queen",
        }
    ]


def test_ytmusic_search_can_skip_blocking_artist_enrichment(monkeypatch, tmp_path):
    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _FakeYoutubeDL)

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))
    monkeypatch.setattr(
        downloader,
        "peek_brief",
        lambda video_id: (_ for _ in ()).throw(AssertionError("peek_brief should not run")),
    )

    results = downloader.search_youtube(
        "bohemian rhapsody",
        max_results=1,
        use_ytmusic=True,
        enrich_missing=False,
    )

    assert results[0]["id"] == "bSnlKl_PoQU"
    assert results[0]["artist"] == ""


def test_download_profile_uses_bounded_network_resilience(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_YTDLP_SOCKET_TIMEOUT", raising=False)
    monkeypatch.delenv("SOUNDSIBLE_YTDLP_HTTP_CHUNK_SIZE", raising=False)
    monkeypatch.delenv("SOUNDSIBLE_YTDLP_RETRY_SLEEP", raising=False)

    args = yd._ytdlp_download_resilience_args()

    assert args == [
        "--socket-timeout",
        "30",
        "--http-chunk-size",
        "10M",
        "--retry-sleep",
        "http:exp=1:20",
        "--retry-sleep",
        "fragment:exp=1:20",
    ]


def test_download_profile_honors_environment_overrides(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_YTDLP_SOCKET_TIMEOUT", "45")
    monkeypatch.setenv("SOUNDSIBLE_YTDLP_HTTP_CHUNK_SIZE", "4M")
    monkeypatch.setenv("SOUNDSIBLE_YTDLP_RETRY_SLEEP", "linear=2:10")

    args = yd._ytdlp_download_resilience_args()

    assert args == [
        "--socket-timeout",
        "45",
        "--http-chunk-size",
        "4M",
        "--retry-sleep",
        "http:linear=2:10",
        "--retry-sleep",
        "fragment:linear=2:10",
    ]


def test_audio_selector_never_falls_back_to_unrestricted_best_video():
    assert yd.YDL_FORMAT_AUDIO == (
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]"
    )
    assert "/best/" not in yd.YDL_FORMAT_AUDIO


def test_cookie_fallback_only_handles_authentication_and_format_failures():
    assert yd._should_retry_download_with_cookies("ERROR: Sign in to confirm your age")
    assert yd._should_retry_download_with_cookies("ERROR: HTTP Error 403: Forbidden")
    assert yd._should_retry_download_with_cookies("Requested format is not available")
    assert not yd._should_retry_download_with_cookies(
        "Got error: 137 bytes read, 10400093 more expected"
    )
