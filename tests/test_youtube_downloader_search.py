from pathlib import Path
import sys
from unittest.mock import MagicMock

# These deps are required by the production code path under test, but not by
# this specific module's assertions. If they are installed in the test
# environment they take precedence; otherwise fall back to a MagicMock stub so
# CI without them can still run search/preview tests. We deliberately avoid
# stubbing *over* an already-loaded real module so unrelated tests that
# import mutagen (e.g., player.library → setup_tool.audio) keep working.
for _module in ("yt_dlp", "mutagen", "mutagen.id3", "mutagen.mp3", "mutagen.flac"):
    if _module in sys.modules:
        continue
    try:
        __import__(_module)
    except Exception:
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


def test_audio_selector_preview_tier_prefers_low_bitrate_audio_first():
    """The preview selector must lead with abr-banded audio so the engine
    moves the fewest bytes possible on a preview click, while still
    containing the full fallback chain so any video resolves."""
    preview = yd.YDL_FORMAT_AUDIO_PREVIEW
    parts = [p for p in preview.split("/") if p]
    assert parts[0].startswith("bestaudio[ext=m4a][abr<=130]")
    assert parts[1].startswith("bestaudio[ext=webm][abr<=170]")
    # The fallback chain must still include every selector used by the
    # download-tier YDL_FORMAT_AUDIO so a video never fails to resolve.
    for required in [
        "worstaudio[ext=m4a]",
        "worstaudio[ext=webm]",
        "worst[acodec!=none]",
        "bestaudio[ext=m4a]",
        "bestaudio[ext=webm]",
        "bestaudio",
    ]:
        assert required in preview
    assert parts[-1] == "worst[acodec!=none]"
    # And never degrade to a stream that bundles video.
    assert "/best/" not in preview


def test_get_stream_url_returns_direct_url_from_extract_info_in_process(monkeypatch, tmp_path):
    """Cold-path in-process resolution: extract_info() returns a dict with a
    'url' field, and get_stream_url returns it without spawning a subprocess."""
    captured_opts = {}

    class _YDL:
        def __init__(self, opts):
            self.opts = opts
            captured_opts.update(opts)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def extract_info(self, url, download=False):
            assert url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            assert download is False
            assert self.opts["format"] == yd.YDL_FORMAT_AUDIO_PREVIEW
            return {
                "id": "dQw4w9WgXcQ",
                "title": "Never Gonna Give You Up",
                "url": "https://rr.googlevideo.com/preview/audio",
            }

    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _YDL)
    monkeypatch.delenv("SOUNDSIBLE_YT_PROXY", raising=False)

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))

    url = downloader.get_stream_url("dQw4w9WgXcQ")

    assert url == "https://rr.googlevideo.com/preview/audio"
    # Noplaylist + quiet + no_warnings must be present so the extractor stays
    # focused on a single video and silent.
    assert captured_opts.get("noplaylist") is True
    assert captured_opts.get("quiet") is True
    assert captured_opts.get("no_warnings") is True


def test_get_stream_url_reads_url_from_requested_formats_when_top_level_missing(monkeypatch, tmp_path):
    """When the chosen URL lives under `requested_formats` (typical when yt-dlp
    separates muxed streams), get_stream_url walks it instead of returning None."""

    class _YDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def extract_info(self, url, download=False):
            return {
                "id": "dQw4w9WgXcQ",
                "requested_formats": [
                    {"format_id": "140", "url": "https://rr.googlevideo.com/aac"},
                ],
            }

    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _YDL)
    monkeypatch.delenv("SOUNDSIBLE_YT_PROXY", raising=False)

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))
    assert downloader.get_stream_url("dQw4w9WgXcQ") == "https://rr.googlevideo.com/aac"


def test_get_stream_url_returns_none_for_format_not_available(monkeypatch, tmp_path):
    """A 'Requested format is not available' error should be swallowed as a
    soft failure (None), not propagated through the __ERROR__ sentinel."""

    class _RaisingYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def extract_info(self, url, download=False):
            raise Exception("Requested format is not available for this video")

    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _RaisingYDL)
    monkeypatch.delenv("SOUNDSIBLE_YT_PROXY", raising=False)

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))
    assert downloader.get_stream_url("dQw4w9WgXcQ") is None


def test_get_stream_url_rejects_empty_or_none_video_id(tmp_path):
    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))
    assert downloader.get_stream_url("") is None
    assert downloader.get_stream_url(None) is None  # type: ignore[arg-type]


def test_get_stream_url_uses_proxy_first_when_set(monkeypatch, tmp_path):
    """With SOUNDSIBLE_YT_PROXY set the first attempt must spawn with proxy
    in opts and the subsequent ipv4 default must not be reached."""
    seen = []

    class _YDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def extract_info(self, url, download=False):
            seen.append(self.opts.get("proxy"))
            return {
                "id": "dQw4w9WgXcQ",
                "url": f"https://rr.googlevideo.com/proxy-hit/{len(seen)}",
            }

    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _YDL)
    monkeypatch.setenv("SOUNDSIBLE_YT_PROXY", "http://residential.invalid:8080")

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))
    url = downloader.get_stream_url("dQw4w9WgXcQ")

    assert url == "https://rr.googlevideo.com/proxy-hit/1"
    assert seen == ["http://residential.invalid:8080"]  # stopped at attempt 1


def test_cookie_fallback_only_handles_authentication_and_format_failures():
    assert yd._should_retry_download_with_cookies("ERROR: Sign in to confirm your age")
    assert yd._should_retry_download_with_cookies("ERROR: HTTP Error 403: Forbidden")
    assert yd._should_retry_download_with_cookies("Requested format is not available")
    assert not yd._should_retry_download_with_cookies(
        "Got error: 137 bytes read, 10400093 more expected"
    )


class _RecordingYoutubeDL:
    """Records every extract_info invocation and returns the next prepared
    response. Asserts on the URL it was called with so tests can verify the
    new attempt order: RD mix flat FIRST, then YTMusic search, then RD full."""

    def __init__(self, responses):
        self.opts = None
        self._responses = list(responses)
        self.calls = []
        self.urls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def extract_info(self, search_input, download=False):
        self.urls.append(search_input)
        self.calls.append(search_input)
        if not self._responses:
            return {}
        return self._responses.pop(0)


def test_get_related_videos_tries_rd_mix_flat_first(monkeypatch, tmp_path):
    """Attempt 1 must be the RD mix flat extract (one yt-dlp call, no fan-out)."""
    instances = []

    class _YDL(_RecordingYoutubeDL):
        def __init__(self, opts):
            super().__init__([{
                "entries": [
                    {"id": "relA1BcdEfG", "title": "Rel One", "duration": 200, "thumbnail": "t"},
                ],
            }])
            self.opts = opts
            instances.append(self)

    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _YDL)

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))
    # Disable cookies to keep the first attempt's opts predictable.
    downloader.cookie_file = None
    downloader.cookie_browser = None

    results = downloader.get_related_videos("seedxxxxxxX", max_results=5)

    assert results and results[0]["id"] == "relA1BcdEfG"
    # Only one yt-dlp invocation; first URL is the RD mix.
    assert len(instances) == 1
    assert instances[0].urls == [
        "https://www.youtube.com/watch?v=seedxxxxxxX&list=RDseedxxxxxxX&start_radio=1"
    ]
    # And flat extraction was requested.
    assert instances[0].opts.get("extract_flat") == "in_playlist"


def test_get_related_videos_falls_back_to_ytmusic_search_when_rd_mix_empty(monkeypatch, tmp_path):
    """When the RD mix flat extract returns no entries, the fallback is a
    YTMusic search; with enrich=False, search_youtube must NOT issue the
    per-item peek_brief fan-out."""
    instances = []
    # Each yt-dlp instantiation gets the next scheduled response (instance #1 =
    # RD mix flat empty, instance #2 = YTMusic search hit).
    queue = [
        {"entries": []},
        {
            "entries": [
                {"id": "ytmFallback01", "title": "Fallback", "duration": 180, "thumbnail": "t"},
            ],
        },
    ]

    class _YDL:
        def __init__(self, opts):
            self.opts = opts
            self.urls = []
            self._response = queue.pop(0)
            instances.append(self)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def extract_info(self, url, download=False):
            self.urls.append(url)
            return self._response

    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", _YDL)

    downloader = yd.YouTubeDownloader(output_dir=Path(tmp_path))
    downloader.cookie_file = None
    downloader.cookie_browser = None

    # peek_brief must NOT be called when enrich=False.
    def _no_peek(*a, **k):
        raise AssertionError("peek_brief should not run when enrich=False")

    monkeypatch.setattr(downloader, "peek_brief", _no_peek)
    # _peek_video_metadata runs in the fallback — make it return metadata so the search query is built.
    monkeypatch.setattr(
        downloader,
        "_peek_video_metadata",
        lambda url: {"track": "Seed Title", "channel": "Seed Artist"},
    )

    results = downloader.get_related_videos("seedxxxxxxX", max_results=5, enrich=False)

    assert results and results[0]["id"] == "ytmFallback01"
    # First call was RD flat, second was YTMusic search.
    assert len(instances) == 2
    assert "music.youtube.com/search" in instances[1].urls[0]
