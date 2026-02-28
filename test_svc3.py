"""Smoke test: RecommendationsService with Last.fm only (no Spotify)."""
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from recommendations.providers.lastfm_provider import LastFmRecommendationProvider
from recommendations.service import RecommendationsService
from recommendations.providers.base import Seed
from dotenv import load_dotenv

load_dotenv()

lastfm_api_key = os.getenv("LASTFM_API_KEY")
lastfm_provider = LastFmRecommendationProvider(lastfm_api_key)

print("Providers initialized:")
print(f"Last.fm available: {getattr(lastfm_provider, 'is_available', False)}")

svc = RecommendationsService(lastfm_provider, None)

seeds = [Seed(artist="The Beatles", title="Hey Jude")]
print(f"Calling get_recommendations with seeds: {seeds}")
results, reason = svc.get_recommendations(seeds, limit=20, library_tracks=[], resolve=False)
print(f"Results len: {len(results)}, reason: {reason}")
if results:
    print(f"First result: {results[0]}")
