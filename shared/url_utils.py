"""
YouTube URL helpers for Soundsible.
"""

from typing import Optional
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse


def normalize_youtube_url(url: str) -> str:
    """
    Normalize YouTube/YouTube Music URL to a single-video URL (no list=, index=, etc.).
    Address-bar links often include list= and cause wrong/failed downloads; Share → Copy link is correct.
    """
    if not url or not isinstance(url, str):
        return url
    url = url.strip()
    if "youtube.com" not in url and "youtu.be" not in url:
        return url
    try:
        parsed = urlparse(url)
        if "youtu.be" in parsed.netloc:
            video_id = (parsed.path or "").strip("/").split("?")[0].split("/")[0]
            if video_id:
                return f"https://www.youtube.com/watch?v={video_id}"
            return url
        q = parse_qs(parsed.query)
        video_id = (q.get("v") or [None])[0]
        if not video_id:
            return url
        # Note: Keep only V= and optionally si=; drop list, index, and all other params
        new_query = {"v": video_id}
        if "si" in q and q["si"]:
            new_query["si"] = q["si"][0]
        return urlunparse((parsed.scheme or "https", parsed.netloc or "www.youtube.com", parsed.path, "", urlencode(new_query), ""))
    except Exception:
        return url


def extract_youtube_video_id(url: str) -> Optional[str]:
    """Extract YouTube video id from youtube.com/youtu.be/music.youtube.com URLs."""
    if not url:
        return None
    try:
        parsed = urlparse(url.strip())
        host = (parsed.netloc or "").lower()
        if "youtu.be" in host:
            vid = (parsed.path or "").strip("/").split("/")[0]
            return vid or None
        if "youtube.com" in host:
            q = parse_qs(parsed.query)
            vid = (q.get("v") or [None])[0]
            return vid or None
    except Exception:
        return None
    return None


def validate_youtube_video_id(video_id: str) -> bool:
    """Allow only safe YouTube video id (11 chars, alphanumeric + -_)."""
    if not video_id or len(video_id) != 11:
        return False
    return all(c.isalnum() or c in '-_' for c in video_id)
