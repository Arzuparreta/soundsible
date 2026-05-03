"""
RSS fetch and parse for podcast feeds. Used by Station API (server-side only).
"""

from __future__ import annotations

import ipaddress
import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import feedparser
import requests

logger = logging.getLogger(__name__)

_PODCAST_UA = "SoundsiblePodcast/1.0 (+https://github.com/soundsible)"
_FETCH_TIMEOUT = (5, 45)
_MAX_FEED_BYTES = 8 * 1024 * 1024


def assert_safe_http_url(url: str) -> None:
    """Reject obvious SSRF targets for RSS/enclosure fetches."""
    if not url or not isinstance(url, str):
        raise ValueError("Invalid URL")
    u = url.strip()
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Only http(s) URLs are allowed")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("Missing host")
    if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        raise ValueError("Host not allowed")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
        raise ValueError("Host not allowed")


def fetch_feed_body(feed_url: str) -> bytes:
    assert_safe_http_url(feed_url)
    resp = requests.get(
        feed_url,
        headers={"User-Agent": _PODCAST_UA},
        timeout=_FETCH_TIMEOUT,
        allow_redirects=True,
    )
    resp.raise_for_status()
    data = resp.content
    if len(data) > _MAX_FEED_BYTES:
        raise ValueError("Feed too large")
    return data


def _first_audio_enclosure(entry: Any) -> Optional[str]:
    links = getattr(entry, "links", None) or []
    for link in links:
        if not isinstance(link, dict):
            continue
        if link.get("rel") == "enclosure":
            href = (link.get("href") or "").strip()
            typ = (link.get("type") or "").lower()
            if href and (typ.startswith("audio/") or typ in ("", "application/octet-stream")):
                return href
    # Fallback: media_content (some feeds)
    media = getattr(entry, "media_content", None) or []
    for m in media:
        if isinstance(m, dict):
            u = (m.get("url") or "").strip()
            t = (m.get("type") or "").lower()
            if u and (t.startswith("audio/") or not t):
                return u
    return None


def _parse_duration(val: Any) -> int:
    if val is None:
        return 0
    if isinstance(val, int):
        return max(0, val)
    s = str(val).strip()
    if not s:
        return 0
    if s.isdigit():
        return max(0, int(s))
    # HH:MM:SS or MM:SS
    parts = s.split(":")
    try:
        nums = [int(p) for p in parts if re.match(r"^\d+$", p)]
        if len(nums) == 3:
            return nums[0] * 3600 + nums[1] * 60 + nums[2]
        if len(nums) == 2:
            return nums[0] * 60 + nums[1]
    except (ValueError, TypeError):
        pass
    return 0


def parse_feed_episodes(feed_xml: bytes, feed_url: str) -> List[Dict[str, Any]]:
    """Parse RSS/Atom; return episode dicts for UI and download queue."""
    parsed = feedparser.parse(feed_xml)
    out: List[Dict[str, Any]] = []
    for entry in getattr(parsed, "entries", []) or []:
        title = (getattr(entry, "title", None) or "").strip() or "Untitled"
        guid = (getattr(entry, "id", None) or getattr(entry, "guid", None) or "").strip()
        if not guid:
            guid = (getattr(entry, "link", None) or title)[:512]
        published = ""
        if getattr(entry, "published_parsed", None):
            try:
                t = entry.published_parsed
                published = datetime(
                    t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec, tzinfo=timezone.utc
                ).isoformat()
            except Exception:
                published = (getattr(entry, "published", None) or "")[:64]
        else:
            published = (getattr(entry, "published", None) or getattr(entry, "updated", None) or "")[:64]

        enc = _first_audio_enclosure(entry)
        if not enc:
            continue
        try:
            assert_safe_http_url(enc)
        except ValueError:
            continue

        duration_sec = 0
        if hasattr(entry, "itunes_duration"):
            duration_sec = _parse_duration(entry.itunes_duration)

        image = ""
        if hasattr(entry, "image") and getattr(entry.image, "href", None):
            image = str(entry.image.href).strip()
        elif hasattr(entry, "media_thumbnail") and entry.media_thumbnail:
            image = str(entry.media_thumbnail[0].get("url", "")).strip()

        out.append(
            {
                "guid": guid[:2048],
                "title": title[:512],
                "published": published,
                "enclosure_url": enc,
                "duration_sec": max(0, duration_sec),
                "image": image,
            }
        )
    return out


def fetch_episodes_for_feed(feed_url: str) -> List[Dict[str, Any]]:
    body = fetch_feed_body(feed_url)
    return parse_feed_episodes(body, feed_url)
