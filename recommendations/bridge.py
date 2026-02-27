"""Bridge: resolve recommended artist+title to YouTube video via ODST search."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Set, Tuple

from .providers.base import RawRecommendation


def _normalize(s: str) -> str:
    return (s or "").strip().lower()


def _library_key(track: Dict[str, Any]) -> Tuple[str, str]:
    return (_normalize(track.get("artist") or ""), _normalize(track.get("title") or ""))


def _resolve_one(
    raw: RawRecommendation,
    downloader: Any,
    max_per_track: int,
) -> Optional[Dict[str, Any]]:
    """Resolve a single raw recommendation to one YouTube item, or None."""
    query = f"{raw.artist} {raw.title}"
    try:
        results = downloader.search_youtube(query, max_results=max_per_track, use_ytmusic=True)
    except Exception:
        return None
    for entry in results or []:
        video_id = entry.get("id")
        if not video_id:
            continue
        return {
            "id": video_id,
            "title": entry.get("title") or raw.title,
            "duration": entry.get("duration") or 0,
            "thumbnail": entry.get("thumbnail") or "",
            "webpage_url": entry.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
            "channel": entry.get("channel") or "",
            "artist": raw.artist,
        }
    return None


def resolve_to_youtube(
    raw_list: List[RawRecommendation],
    downloader: Any,
    library_tracks: Optional[List[Dict[str, Any]]] = None,
    max_per_track: int = 3,
    max_workers: int = 8,
) -> List[Dict[str, Any]]:
    """
    For each RawRecommendation, run ODST search_youtube and return first hit.
    Resolutions run in parallel to reduce total time.
    Same shape as /api/downloader/youtube/search: id, title, duration, thumbnail, webpage_url, channel, artist.
    Skips tracks already in library (by normalized artist+title).
    """
    library_keys: Set[Tuple[str, str]] = set()
    if library_tracks:
        for t in library_tracks:
            library_keys.add(_library_key(t))
    to_resolve: List[Tuple[int, RawRecommendation]] = []
    for i, raw in enumerate(raw_list):
        if _normalize(raw.artist) and _normalize(raw.title) and (raw.artist.lower(), raw.title.lower()) in library_keys:
            continue
        to_resolve.append((i, raw))
    if not to_resolve:
        return []
    index_to_item: Dict[int, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_resolve_one, raw, downloader, max_per_track): (i, raw)
            for i, raw in to_resolve
        }
        for future in as_completed(futures):
            i, _ = futures[future]
            try:
                item = future.result()
                if item:
                    index_to_item[i] = item
            except Exception:
                pass
    seen_video_ids: Set[str] = set()
    out: List[Dict[str, Any]] = []
    for i in sorted(index_to_item.keys()):
        item = index_to_item[i]
        video_id = item.get("id")
        if not video_id or video_id in seen_video_ids:
            continue
        seen_video_ids.add(video_id)
        out.append(item)
    return out
