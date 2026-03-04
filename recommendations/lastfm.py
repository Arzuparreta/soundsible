"""Last.fm recommendations via track.getSimilar API."""

import concurrent.futures
from typing import List, Optional

import requests

from .models import RawRecommendation, Seed

LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/"


def is_lastfm_available(api_key: Optional[str]) -> bool:
    """Whether Last.fm is configured (API key present)."""
    return bool((api_key or "").strip())


def _fetch_similar(s: Seed, limit: int, per_seed: int, api_key: str) -> List[RawRecommendation]:
    try:
        params = {
            "method": "track.getSimilar",
            "artist": s.artist,
            "track": s.title,
            "api_key": api_key,
            "format": "json",
            "limit": per_seed,
        }
        r = requests.get(LASTFM_API_BASE, params=params, timeout=10)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return []

    tracks = (data.get("similartracks") or {}).get("track") or []
    if isinstance(tracks, dict):
        tracks = [tracks]

    fetched: List[RawRecommendation] = []
    for t in tracks:
        if len(fetched) >= limit:
            break
        name = (t.get("name") or "").strip()
        artist_obj = t.get("artist")
        if isinstance(artist_obj, dict):
            artist = (artist_obj.get("name") or "").strip()
        else:
            artist = ""
        if not name and not artist:
            continue

        dur = t.get("duration")
        try:
            duration_sec = int(dur) if dur else None
        except ValueError:
            duration_sec = None

        raw = RawRecommendation(
            title=name,
            artist=artist,
            duration_sec=duration_sec,
        )
        fetched.append(raw)

    return fetched


def get_recommendations(
    seeds: List[Seed],
    limit: int,
    api_key: Optional[str],
) -> List[RawRecommendation]:
    """Return similar tracks from Last.fm for the given seeds. May return fewer than limit."""
    key = (api_key or "").strip()
    if not key or not seeds:
        return []
    seen: set = set()
    out: List[RawRecommendation] = []
    per_seed = max(5, (limit // len(seeds)) + 1)

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(_fetch_similar, s, limit, per_seed, key): s
            for s in seeds
        }
        for future in concurrent.futures.as_completed(futures):
            try:
                fetched_tracks = future.result()
                for r in fetched_tracks:
                    if len(out) >= limit:
                        break
                    k = (r.artist.lower(), r.title.lower())
                    if k in seen:
                        continue
                    seen.add(k)
                    out.append(r)
            except Exception:
                continue
    return out
