"""
RSS fetch and parse for podcast feeds. Used by Station API (server-side only).
"""

from __future__ import annotations

import ipaddress
import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, NamedTuple, Optional, Tuple
from urllib.parse import urljoin, urlparse

import feedparser
import requests

logger = logging.getLogger(__name__)

_PODCAST_UA = "SoundsiblePodcast/1.0 (+https://github.com/soundsible)"
_FETCH_TIMEOUT = (5, 45)
# How much of a feed one read takes. A show that has run for a decade can have a
# feed of tens of megabytes, and feedparser holds several times the XML it
# parses; past this the feed is cut to the episodes that fit instead of being
# refused whole (#250).
_MAX_FEED_BYTES = 8 * 1024 * 1024

# The markup a feed is cut by. CDATA and comments are passed over whole, so an
# `</item>` quoted in show notes is not taken for the end of an episode, and one
# the cut lands inside runs to the end rather than being read as markup.
_MARKUP = re.compile(
    rb"<!\[CDATA\[.*?(?:\]\]>|\Z)"
    rb"|<!--.*?(?:-->|\Z)"
    rb"|<[?!][^>]*>"
    rb"|<(/?)([A-Za-z_][-\w.:]*)(?:\"[^\"]*\"|'[^']*'|[^'\">])*?(/?)>",
    re.S,
)


class FeedBody(NamedTuple):
    """A feed as read. `partial` when it ran past `_MAX_FEED_BYTES`: `xml` then
    holds only the episodes that arrived whole, closed into a document of its
    own."""

    xml: bytes
    partial: bool


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


def fetch_feed_body(feed_url: str) -> FeedBody:
    assert_safe_http_url(feed_url)
    # Streamed so the limit bounds what is held, not just what is parsed: the
    # whole body used to be downloaded before its size was even looked at.
    with requests.get(
        feed_url,
        headers={"User-Agent": _PODCAST_UA},
        timeout=_FETCH_TIMEOUT,
        allow_redirects=True,
        stream=True,
    ) as resp:
        resp.raise_for_status()
        body = bytearray()
        for chunk in resp.iter_content(chunk_size=65536):
            body += chunk
            if len(body) > _MAX_FEED_BYTES:
                break
        else:
            return FeedBody(bytes(body), False)
    # Closing the response with the rest unread drops the connection instead of
    # downloading the remainder of a feed nothing is going to parse.
    del body[_MAX_FEED_BYTES:]
    return FeedBody(_leading_items(bytes(body)), True)


def _leading_items(prefix: bytes) -> bytes:
    """The start of a feed that was cut short, as a document of its own:
    everything up to the end of the last episode that arrived whole, then the
    elements still open around it closed. Podcast feeds nearly always list
    their newest episodes first, so what survives is the part of a show people
    open it for; a feed in the opposite order keeps its oldest instead. The
    tags are closed rather than left open because feedparser reads an
    unfinished document twice, the second time with its slower loose parser.

    Only ASCII-compatible encodings are read this way; in any other, or when not
    one episode fits, the feed is refused as it always was."""
    stack: List[bytes] = []
    item: Optional[bytes] = None
    parents: Optional[Tuple[bytes, ...]] = None
    cut = 0
    for match in _MARKUP.finditer(prefix):
        closing, name, empty = match.group(1, 2, 3)
        if name is None or empty:
            continue
        if not closing:
            if item is None:
                # The root says what an episode is: an `entry` under an Atom
                # `feed`, an `item` in RSS. Only those beside the first count.
                item = b"entry" if name == b"feed" else b"item"
            elif parents is None and name == item:
                parents = tuple(stack)
            stack.append(name)
        elif name in stack:
            # Whatever an element left unclosed ends with it, the way a lenient
            # parser reads the same markup.
            del stack[len(stack) - 1 - stack[::-1].index(name):]
            if name == item and tuple(stack) == parents:
                cut = match.end()
    if not cut or parents is None:
        raise ValueError("Feed too large")
    return prefix[:cut] + b"".join(b"</" + tag + b">" for tag in reversed(parents))


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


def _artwork_url(value: Any, feed_url: str) -> str:
    """An absolute, fetchable http(s) artwork URL, or "" when there is none.

    Feeds publish relative hrefs, and every URL that survives here is fetched by
    the Station when an episode is downloaded, so artwork goes through the same
    SSRF check as an enclosure rather than being trusted because it is "just an
    image".
    """
    url = str(value or "").strip()
    if not url:
        return ""
    if feed_url and not urlparse(url).scheme:
        url = urljoin(feed_url, url)
    try:
        assert_safe_http_url(url)
    except ValueError:
        return ""
    return url[:2048]


def parse_feed_image(feed: Any, feed_url: str = "") -> str:
    """The show's artwork. feedparser folds `<itunes:image href>` and the RSS
    `<image><url>` into the same `feed.image.href`, so one lookup covers both."""
    return _artwork_url(getattr(getattr(feed, "image", None), "href", None), feed_url)


def _entry_image(entry: Any, feed_url: str) -> str:
    """Artwork an episode carries of its own, if any."""
    own = _artwork_url(getattr(getattr(entry, "image", None), "href", None), feed_url)
    if own:
        return own
    for thumbnail in getattr(entry, "media_thumbnail", None) or []:
        if isinstance(thumbnail, dict):
            url = _artwork_url(thumbnail.get("url"), feed_url)
            if url:
                return url
    return ""


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


def parse_feed_show(feed: Any, feed_url: str = "") -> Dict[str, str]:
    """The show a parsed feed describes: what a page needs to head its episodes
    when all it was handed is the feed's URL. The author falls back to the
    subtitle the way a subscription records it, so a show reads the same before
    and after it is followed."""
    return {
        "title": (getattr(feed, "title", None) or "").strip(),
        "author": (getattr(feed, "author", None) or getattr(feed, "subtitle", None) or "").strip(),
        "image_url": parse_feed_image(feed, feed_url),
    }


def parse_feed(feed_xml: bytes, feed_url: str) -> Tuple[Dict[str, str], List[Dict[str, Any]]]:
    """The show and its episodes from one parse. A long-running show's feed is
    megabytes of XML, and parsing it twice to get both was the norm."""
    parsed = feedparser.parse(feed_xml)
    return parse_feed_show(getattr(parsed, "feed", None), feed_url), _episodes(parsed, feed_url)


def parse_feed_episodes(feed_xml: bytes, feed_url: str) -> List[Dict[str, Any]]:
    """Parse RSS/Atom; return episode dicts for UI and download queue."""
    return _episodes(feedparser.parse(feed_xml), feed_url)


def _episodes(parsed: Any, feed_url: str) -> List[Dict[str, Any]]:
    # Per-episode artwork is optional and most shows never set it, so an episode
    # without its own inherits the show's. Nothing downstream has another source
    # to fall back to: the episode dict is the only artwork the player, the
    # queue, the lock screen and the downloaded file's cover ever see, and "" at
    # this point is a blank cover on all of them.
    show_image = parse_feed_image(getattr(parsed, "feed", None), feed_url)
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

        image = _entry_image(entry, feed_url) or show_image

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
