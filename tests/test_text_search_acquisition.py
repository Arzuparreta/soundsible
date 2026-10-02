"""A song named in text is matched the way every other song is.

Downloads queued as text — an artist and title, or just words — used to go
through a matcher of their own: word overlap against "artist - title official
audio", with a list of forbidden words. It disagreed with the resolver the rest
of the app uses, and a missing artist was searched as the literal "Unknown".
They now score candidates with `shared.resolution_confidence` and download the
winner exactly as a chosen video is downloaded.
"""

import pytest

from shared.downloader.youtube import search
from shared.downloader.youtube_downloader import YouTubeDownloader


def _row(video_id, title, channel, duration):
    return {
        "id": video_id,
        "title": title,
        "channel": channel,
        "duration": duration,
        "webpage_url": f"https://www.youtube.com/watch?v={video_id}",
    }


@pytest.fixture
def downloader(tmp_path, monkeypatch):
    dl = YouTubeDownloader(output_dir=tmp_path)
    dl.downloaded = []
    monkeypatch.setattr(
        dl, "process_video",
        lambda url, metadata_hint=None, progress_callback=None: dl.downloaded.append((url, metadata_hint)) or "track",
    )
    return dl


def test_the_best_scored_upload_is_downloaded_with_the_hint(downloader, monkeypatch):
    asked = {}

    def candidates(artist, title, cookies, max_results=8):
        asked.update(artist=artist, title=title)
        return [
            _row("lyricsrepst", "Bohemian Rhapsody (Lyrics)", "Lyrics Hub", 359),
            _row("officialvid", "Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official", 355),
        ]

    monkeypatch.setattr(search, "search_match_candidates", candidates)
    hint = {"artist": "Queen", "title": "Bohemian Rhapsody", "duration_sec": 354, "album": "A Night at the Opera"}

    assert downloader.process_query("Queen - Bohemian Rhapsody", metadata_hint=hint) == "track"

    assert asked == {"artist": "Queen", "title": "Bohemian Rhapsody"}
    assert downloader.downloaded == [("https://www.youtube.com/watch?v=officialvid", hint)]


def test_plain_words_search_as_the_title_and_leave_the_tags_to_the_upload(downloader, monkeypatch):
    asked = {}

    def candidates(artist, title, cookies, max_results=8):
        asked.update(artist=artist, title=title)
        return [_row("bohemianrha", "Bohemian Rhapsody", "Queen - Topic", 355)]

    monkeypatch.setattr(search, "search_match_candidates", candidates)

    downloader.process_query("bohemian rhapsody")

    # No artist is invented: the old path searched for "Unknown - …".
    assert asked == {"artist": "", "title": "bohemian rhapsody"}
    # Nothing in the hint, so the file's own tags name the song, not the typed words.
    assert downloader.downloaded == [("https://www.youtube.com/watch?v=bohemianrha", {})]


def test_a_different_version_is_not_downloaded(downloader, monkeypatch):
    monkeypatch.setattr(
        search, "search_match_candidates",
        lambda *a, **k: [_row("livewembley", "Bohemian Rhapsody (Live at Wembley)", "Queen", 360)],
    )

    with pytest.raises(Exception, match="No YouTube upload matches"):
        downloader.process_query("Bohemian Rhapsody", metadata_hint={"artist": "Queen"})
    assert downloader.downloaded == []


def test_nothing_found_is_a_failure_not_a_silent_skip(downloader, monkeypatch):
    monkeypatch.setattr(search, "search_match_candidates", lambda *a, **k: [])

    with pytest.raises(Exception, match="No YouTube upload matches"):
        downloader.process_query("an unknowable song")
    assert downloader.downloaded == []
