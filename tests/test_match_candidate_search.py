"""Why the scoring paths ask for a different search than the browse paths.

`best_candidate` weighs title, channel and duration. YouTube Music's search
returns ids and titles only, so a resolve that used it had to recover the rest
one full extraction at a time — 5.2 s for eight candidates, on top of the 0.9 s
search. Plain YouTube search carries all three fields in that same 0.9 s, and
its weaker ranking costs nothing here because every result gets re-scored
against a track we already know.

Without a duration the ceiling is title (0.45) plus channel (0.30) = 0.75, so a
match could only ever reach `high` by scoring perfectly on both. That is the
regression these tests exist to prevent.
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
from shared.resolution_confidence import classify_confidence, score_candidate  # noqa: E402


@pytest.fixture
def downloader(tmp_path, monkeypatch):
    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", MagicMock())
    return yd.YouTubeDownloader(output_dir=tmp_path)


def test_asks_the_surface_that_carries_durations(downloader, monkeypatch):
    seen = {}

    def fake_search(query, max_results=10, use_ytmusic=True, enrich_missing=True):
        seen.update(
            query=query,
            max_results=max_results,
            use_ytmusic=use_ytmusic,
            enrich_missing=enrich_missing,
        )
        return [{"id": "abcdefghijk", "title": "x", "duration": 200, "channel": "y"}]

    monkeypatch.setattr(downloader, "search_youtube", fake_search)

    downloader.search_match_candidates("Queen", "Bohemian Rhapsody", max_results=6)

    assert seen["query"] == "Bohemian Rhapsody Queen"
    assert seen["max_results"] == 6
    assert seen["use_ytmusic"] is False, "YouTube Music returns no durations to score with"
    assert seen["enrich_missing"] is False, "enrichment cannot recover a duration anyway"


def test_ignores_the_browse_preference(downloader, monkeypatch):
    """SOUNDSIBLE_YT_SEARCH_SOURCE picks where people browse. Scoring is not
    browsing, and following it here is what cost 5.2 s per cold resolve."""
    monkeypatch.setenv("SOUNDSIBLE_YT_SEARCH_SOURCE", "ytmusic")
    seen = {}
    monkeypatch.setattr(
        downloader,
        "search_youtube",
        lambda query, **kw: seen.update(kw) or [],
    )

    downloader.search_match_candidates("Queen", "Bohemian Rhapsody")

    assert seen["use_ytmusic"] is False


def test_empty_track_asks_nothing(downloader, monkeypatch):
    called = []
    monkeypatch.setattr(downloader, "search_youtube", lambda *a, **kw: called.append(1) or [])

    assert downloader.search_match_candidates("", "") == []
    assert called == []


def test_a_duration_is_what_lets_a_match_reach_high():
    """The point of all of the above, stated as a score."""
    candidate = {"title": "Bohemian Rhapsody", "channel": "Queen", "duration": 354}
    with_duration, _ = score_candidate("Queen", "Bohemian Rhapsody", 354, candidate)

    without = dict(candidate, duration=0)
    without_duration, _ = score_candidate("Queen", "Bohemian Rhapsody", 354, without)

    assert classify_confidence(with_duration) == "high"
    assert with_duration > without_duration
