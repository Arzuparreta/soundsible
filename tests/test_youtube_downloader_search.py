from pathlib import Path

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
