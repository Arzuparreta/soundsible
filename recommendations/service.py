"""Recommendations: YouTube mix (related) only. Extensible for future sources."""

import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


def get_recommendations(
    seed_video_ids: List[str],
    limit: int,
    downloader: Any = None,
) -> List[Dict[str, Any]]:
    """
    Return recommended videos for the given seeds.
    Today this reads the first seed and performs one YouTube Music mix/related request.
    Same item shape as ODST search: id, title, duration, thumbnail, webpage_url, channel, artist.
    """
    if not downloader or not seed_video_ids:
        return []
    seed = seed_video_ids[0]
    try:
        raw = downloader.get_related_videos(seed, max_results=limit)
    except Exception as e:
        logger.warning("[Discover] get_recommendations failed for seed %s: %s", seed, e)
        return []
    return [dict(item) for item in raw[:limit]]
