"""Recommendations: YouTube mix (related) only. Extensible for future sources."""

from typing import Any, Dict, List, Optional, Set


def get_recommendations(
    seed_video_ids: List[str],
    limit: int,
    library_youtube_ids: Optional[Set[str]] = None,
    downloader: Any = None,
) -> List[Dict[str, Any]]:
    """
    Return recommended videos for the given seed(s). Today: one YouTube Music mix request per seed.
    Filters out any result already in library_youtube_ids.
    Same item shape as ODST search: id, title, duration, thumbnail, webpage_url, channel, artist.
    """
    if not downloader or not seed_video_ids:
        return []
    library = library_youtube_ids or set()
    seed = seed_video_ids[0]
    try:
        raw = downloader.get_related_videos(seed, max_results=limit + len(library))
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        vid = item.get("id")
        if not vid or vid in library:
            continue
        if len(out) >= limit:
            break
        out.append(dict(item))
    return out
