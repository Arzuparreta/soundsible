"""YouTube video ids, watch URLs and thumbnails."""

from __future__ import annotations

from typing import Optional
from urllib.parse import parse_qs, urlparse


def is_valid_video_id(video_id: Optional[str]) -> bool:
    """True if this looks like a YouTube video id (11 chars, alphanumeric + -_). Filters RDAM*, channel IDs, etc."""
    if not video_id or not isinstance(video_id, str):
        return False
    s = video_id.strip()
    if len(s) != 11:
        return False
    return all(c.isalnum() or c in "-_" for c in s)


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def thumbnail_url(video_id: Optional[str]) -> Optional[str]:
    """YouTube thumbnail URL (mqdefault). Returns None if video_id is falsy."""
    if not video_id:
        return None
    return f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg"


def video_id_from_url(url: str) -> Optional[str]:
    """Extract YouTube video ID from youtube.com or youtu.be URL."""
    if not url or not isinstance(url, str):
        return None
    parsed = urlparse(url.strip())
    if "youtu.be" in parsed.netloc:
        vid = (parsed.path or "").strip("/").split("?")[0].split("/")[0]
        return vid if is_valid_video_id(vid) else None
    if "youtube.com" in parsed.netloc:
        vid = (parse_qs(parsed.query).get("v") or [None])[0]
        return str(vid) if vid and is_valid_video_id(str(vid)) else None
    return None
