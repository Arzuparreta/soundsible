"""Recommendations: YouTube mix (related) only. Extensible for future sources."""

from typing import Any, Dict, List


def get_recommendations(
    seed_video_ids: List[str],
    limit: int,
    downloader: Any = None,
) -> List[Dict[str, Any]]:
    """
    Return recommended videos for the given seed(s). Today: one YouTube Music mix request per seed.
    Same item shape as ODST search: id, title, duration, thumbnail, webpage_url, channel, artist.
    """
    if not downloader or not seed_video_ids:
        return []
    seed = seed_video_ids[0]
    try:
        raw = downloader.get_related_videos(seed, max_results=limit)
    except Exception:
        return []
    return [dict(item) for item in raw[:limit]]
