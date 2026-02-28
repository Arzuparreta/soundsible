"""Integration test: RecommendationsService with real ODSTDownloader + Last.fm (no Spotify)."""
import sys
import os
import json
from pathlib import Path
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))

from odst_tool.odst_downloader import ODSTDownloader
from recommendations.providers.lastfm_provider import LastFmRecommendationProvider
from recommendations.service import RecommendationsService
from recommendations.providers.base import Seed

load_dotenv()

print("Initializing ODSTDownloader + Last.fm...")
dl = ODSTDownloader(Path("/tmp/odst_test_output"))

lastfm_api_key = os.getenv("LASTFM_API_KEY")
lastfm_provider = LastFmRecommendationProvider(lastfm_api_key)
print(f"Last.fm available? {lastfm_provider.is_available}")

print("Initializing RecommendationsService...")
svc = RecommendationsService(lastfm_provider, dl.downloader)

try:
    seeds = [Seed(artist="Joji", title="Run"), Seed(artist="Post Malone", title="Circles")]
    print("Calling get_recommendations with resolve=False...")
    results, reason = svc.get_recommendations(seeds, limit=5, library_tracks=[], resolve=False)
    print(f"Results len: {len(results)}, reason: {reason}")
    if results:
        print(f"First result: {json.dumps(results[0], indent=2)}")
except Exception as e:
    import traceback
    traceback.print_exc()
