"""Local cache for recommendation providers to avoid repeat external API hits."""

import json
from pathlib import Path
from typing import Dict, Any, Optional, List

class ProviderCache:
    """Stores local mappings of Track -> Spotify ID and Track -> Similar Tracks."""

    def __init__(self, cache_file: Path):
        self._cache_file = cache_file
        self._data: Dict[str, Any] = {
            "spotify_ids": {},
            "lastfm_similar": {}
        }
        self._load()

    def _load(self):
        if not self._cache_file.exists():
            return
        try:
            with open(self._cache_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    self._data = json.loads(content)
        except Exception as e:
            print(f"Warning: Could not load recommendation cache: {e}")

    def _save(self):
        try:
            self._cache_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self._cache_file, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False)
        except Exception as e:
            print(f"Warning: Could not save recommendation cache: {e}")

    def _key(self, artist: str, title: str) -> str:
        return f"{artist.lower().strip()}|{title.lower().strip()}"

    def get_spotify_id(self, artist: str, title: str) -> Optional[str]:
        return self._data.get("spotify_ids", {}).get(self._key(artist, title))

    def set_spotify_id(self, artist: str, title: str, spotify_id: str):
        if "spotify_ids" not in self._data:
            self._data["spotify_ids"] = {}
        self._data["spotify_ids"][self._key(artist, title)] = spotify_id
        self._save()

    def get_lastfm_similar(self, artist: str, title: str) -> Optional[List[Dict[str, Any]]]:
        return self._data.get("lastfm_similar", {}).get(self._key(artist, title))

    def set_lastfm_similar(self, artist: str, title: str, raw_recommendations: List[Dict[str, Any]]):
        if "lastfm_similar" not in self._data:
            self._data["lastfm_similar"] = {}
        self._data["lastfm_similar"][self._key(artist, title)] = raw_recommendations
        self._save()
