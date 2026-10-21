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

from shared.downloader import youtube_downloader as yd  # noqa: E402
import yt_dlp  # noqa: E402
from shared.downloader.youtube import search  # noqa: E402
from shared.resolution_confidence import classify_confidence, score_candidate  # noqa: E402


@pytest.fixture
def downloader(tmp_path, monkeypatch):
    monkeypatch.setattr(yt_dlp, "YoutubeDL", MagicMock())
    return yd.YouTubeDownloader(output_dir=tmp_path)


def test_asks_the_surface_that_carries_durations(downloader, monkeypatch):
    seen = {}

    def fake_search(query, cookies, max_results=10, use_ytmusic=True, enrich_missing=True):
        seen.update(
            query=query,
            max_results=max_results,
            use_ytmusic=use_ytmusic,
            enrich_missing=enrich_missing,
        )
        return [{"id": "abcdefghijk", "title": "x", "duration": 200, "channel": "y"}]

    monkeypatch.setattr(search, "search_youtube", fake_search)

    downloader.search_match_candidates("Queen", "Bohemian Rhapsody", max_results=6)

    assert seen["query"] == "Bohemian Rhapsody Queen"
    assert seen["max_results"] == 6
    assert seen["use_ytmusic"] is False, "YouTube Music returns no durations to score with"
    assert seen["enrich_missing"] is False, "enrichment cannot recover a duration anyway"


def test_ignores_the_browse_preference(downloader, monkeypatch):
    """SOUNDSIBLE_YT_SEARCH_SOURCE picks where people browse. Scoring is not
    browsing, and following it here is what cost 5.2 s per cold resolve."""
    monkeypatch.setenv("SOUNDSIBLE_YT_SEARCH_SOURCE", "ytmusic")
    seen = []
    monkeypatch.setattr(
        search,
        "search_youtube",
        lambda query, cookies, **kw: seen.append(kw) or [],
    )

    downloader.search_match_candidates("Queen", "Bohemian Rhapsody")

    assert seen[0]["use_ytmusic"] is False
    assert [call['use_ytmusic'] for call in seen] == [False, True]


def test_empty_track_asks_nothing(downloader, monkeypatch):
    called = []
    monkeypatch.setattr(search, "search_youtube", lambda *a, **kw: called.append(1) or [])

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


def test_empty_video_search_recovers_music_candidates_with_real_durations(downloader, monkeypatch):
    calls, peeks = [], []
    def fake_search(query, cookies, **kw):
        calls.append(kw)
        return ([{'id': '8lbGTPi60TA', 'title': 'Por Ser un Pervertido', 'channel': 'Robe - Topic'},
                 {'id': '5YGEid34Cqg', 'title': 'Por Ser un Pervertido (Live)', 'channel': 'Robe - Topic'}]
                if kw['use_ytmusic'] else [])
    def peek(video, cookies):
        peeks.append(video)
        return {'id': video, 'title': 'Por Ser un Pervertido', 'channel': 'Robe', 'duration': 344}
    monkeypatch.setattr(search, 'search_youtube', fake_search)
    monkeypatch.setattr(search, 'peek_brief', peek)
    rows = downloader.search_match_candidates('Robe', 'Por Ser un Pervertido')
    assert [call['use_ytmusic'] for call in calls] == [False, True]
    assert peeks == ['8lbGTPi60TA']
    assert rows[0]['duration'] == 344
    score, reason = score_candidate('Robe', 'Por Ser un Pervertido', 343, rows[0])
    assert classify_confidence(score) == 'high'
    assert reason == 'title_artist_duration'


def test_nonempty_primary_never_pays_for_music_or_peeks(downloader, monkeypatch):
    calls = []
    def primary(query, cookies, **kw):
        calls.append(kw)
        return [{'id': 'gi3GiEIpeZU', 'title': 'Por Ser un Pervertido', 'channel': 'Robe', 'duration': 344}]
    monkeypatch.setattr(search, 'search_youtube', primary)
    monkeypatch.setattr(search, 'peek_brief', lambda *a: pytest.fail('No extra extraction'))
    assert downloader.search_match_candidates('Robe', 'Por Ser un Pervertido')[0]['duration'] == 344
    assert len(calls) == 1 and calls[0]['use_ytmusic'] is False


def test_fallback_is_bounded_and_does_not_invent_duration(downloader, monkeypatch):
    peeks = []
    def music(query, cookies, **kw):
        return ([{'id': f'video{i:06d}', 'title': 'Song', 'channel': 'Artist'} for i in range(8)]
                if kw['use_ytmusic'] else [])
    def peek(video, cookies):
        peeks.append(video)
        if video.endswith('0'):
            raise OSError('unavailable')
        return {'id': video, 'title': 'Song', 'channel': 'Artist', 'duration': 0}
    monkeypatch.setattr(search, 'search_youtube', music)
    monkeypatch.setattr(search, 'peek_brief', peek)
    rows = downloader.search_match_candidates('Artist', 'Song')
    assert len(peeks) == 3
    assert len(rows) == 2 and all(row['duration'] == 0 for row in rows)


def test_fallback_preserves_music_source_errors(downloader, monkeypatch):
    def search_or_fail(query, cookies, **kw):
        if kw['use_ytmusic']:
            raise OSError('network down')
        return []
    monkeypatch.setattr(search, 'search_youtube', search_or_fail)
    with pytest.raises(OSError, match='network down'):
        downloader.search_match_candidates('Artist', 'Song')
