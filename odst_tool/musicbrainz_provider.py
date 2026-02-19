"""
MusicBrainz candidate provider.
Returns normalized candidate dicts for metadata scoring.
"""

from __future__ import annotations

from typing import Any, Dict, List
import musicbrainzngs


musicbrainzngs.set_useragent("Soundsible", "1.0.0", "https://github.com/Arzuparreta/soundsible")


def search_candidates(artist: str, title: str, limit: int = 6) -> List[Dict[str, Any]]:
    artist = (artist or "").strip()
    title = (title or "").strip()
    if not artist or not title:
        return []

    out: List[Dict[str, Any]] = []
    try:
        result = musicbrainzngs.search_recordings(artist=artist, recording=title, limit=max(1, limit))
    except Exception:
        return []

    for rec in result.get("recording-list", []):
        release_list = rec.get("release-list") or []
        if not release_list:
            continue
        rel = release_list[0]
        duration_sec = 0
        if rec.get("length"):
            try:
                duration_sec = int(int(rec.get("length")) / 1000)
            except Exception:
                duration_sec = 0
        out.append(
            {
                "title": rec.get("title") or "",
                "artist": rec.get("artist-credit-phrase") or "",
                "album": rel.get("title") or "",
                "duration_sec": duration_sec,
                "isrc": (rec.get("isrc-list") or [None])[0],
                "album_artist": rel.get("artist-credit-phrase") or "",
                "cover_url": f"https://coverartarchive.org/release/{rel.get('id')}/front" if rel.get("id") else None,
                "catalog_source": "musicbrainz",
                "catalog_id": rec.get("id"),
                "musicbrainz_id": rec.get("id"),
            }
        )
    return out

