"""
LRCLIB lyrics client (https://lrclib.net).

Free, keyless provider of synced (LRC) and plain lyrics. Lookup is done by
artist + title + album + duration; duration disambiguates versions of the
same song. LRCLIB asks clients to identify themselves via User-Agent.
"""

import logging
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)

_LRCLIB_HOST = "https://lrclib.net"
_USER_AGENT = "Soundsible/1.0 (https://github.com/Arzuparreta/soundsible)"
_TIMEOUT_SEC = 6
# Max acceptable duration difference when picking a search fallback result
_DURATION_TOLERANCE_SEC = 3


def _result_to_record(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "synced": item.get("syncedLyrics") or None,
        "plain": item.get("plainLyrics") or None,
        "instrumental": bool(item.get("instrumental")),
        "source": "lrclib",
    }


def _lrclib_get(path: str, params: Dict[str, Any]) -> Optional[Any]:
    resp = requests.get(
        f"{_LRCLIB_HOST}{path}",
        params=params,
        headers={"User-Agent": _USER_AGENT},
        timeout=_TIMEOUT_SEC,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def fetch_lyrics(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Fetch lyrics from LRCLIB for a track.

    Returns {"synced", "plain", "instrumental", "source"} when a match is
    found (a not-found lookup returns a record with all-empty lyrics so the
    caller can negative-cache it), or None on network/provider errors so the
    caller does NOT cache and a later request retries.
    """
    if not artist or not title:
        return None
    try:
        # Exact match first: /api/get requires all four fields to line up.
        if album and duration:
            item = _lrclib_get("/api/get", {
                "artist_name": artist,
                "track_name": title,
                "album_name": album,
                "duration": int(duration),
            })
            if item:
                return _result_to_record(item)

        # Fallback: fuzzy search, pick the closest duration within tolerance
        # (or the first result when the track duration is unknown).
        results = _lrclib_get("/api/search", {
            "artist_name": artist,
            "track_name": title,
        })
        best = None
        if isinstance(results, list):
            for item in results:
                if not duration:
                    best = item
                    break
                item_duration = item.get("duration")
                if item_duration is None:
                    continue
                diff = abs(int(item_duration) - int(duration))
                if diff <= _DURATION_TOLERANCE_SEC and (
                    best is None or diff < abs(int(best["duration"]) - int(duration))
                ):
                    best = item
        if best:
            return _result_to_record(best)
        # Provider answered but has nothing: negative-cacheable not-found.
        return {"synced": None, "plain": None, "instrumental": False, "source": "lrclib"}
    except requests.RequestException as e:
        logger.warning("LRCLIB request failed for %s - %s: %s", artist, title, e)
        return None
    except (ValueError, KeyError, TypeError) as e:
        logger.warning("LRCLIB response parse error for %s - %s: %s", artist, title, e)
        return None
