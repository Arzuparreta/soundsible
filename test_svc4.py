"""Unit test: RecommendationsService with mock Last.fm (no Spotify)."""
import sys
import os
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from recommendations.service import RecommendationsService
from recommendations.providers.base import Seed


class MockDownloader:
    pass


class MockLastFmProvider:
    @property
    def is_available(self):
        return True

    def get_recommendations(self, seeds, limit):
        class FakeRec:
            def __init__(self, artist, title, album, album_artist, duration, cover, isrc, year, track):
                self.artist = artist
                self.title = title
                self.album = album
                self.album_artist = album_artist
                self.duration_sec = duration
                self.cover_url = cover
                self.isrc = isrc
                self.year = year
                self.track_number = track

        return [
            FakeRec("The Beatles", "Let It Be", "Album", "Artist", 120, "url", "isrc", 1970, 1),
            FakeRec("The Beatles", "Yesterday", "Album", "Artist", 120, "url", "isrc", 1965, 1),
        ]


dl = MockDownloader()
lastfm_provider = MockLastFmProvider()

print("Testing RecommendationsService (Last.fm only)...")
svc = RecommendationsService(lastfm_provider, dl)

try:
    seeds = [Seed(artist="The Beatles", title="Hey Jude")]
    print("Calling get_recommendations with seeds...")
    results, reason = svc.get_recommendations(seeds, limit=20, library_tracks=[], resolve=False)
    print(f"Results len: {len(results)}, reason: {reason}")
    if results:
        print(f"First result: {json.dumps(results[0], indent=2)}")
except Exception as e:
    import traceback
    traceback.print_exc()
