"""References already returned by an extractor; never a thumbnail probe.

Declared dimensions describe a candidate, not proof that its URL exists. Full
YouTube extracts also contain guessed URLs, so dimensionless entries do not
outrank an observed reference. Alternative video frames are not cover art.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

MAX_CANDIDATES = 8


def candidates(info: dict) -> list[dict]:
    result = {}
    for entry in (info.get('thumbnails') or [])[:100]:
        if not isinstance(entry, dict):
            continue
        url = entry.get('url')
        if not isinstance(url, str) or len(url) > 2048:
            continue
        try:
            parsed = urlsplit(url)
        except ValueError:
            continue
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            continue
        if re.search(r'/(?:[123]|(?:sd|hq|mq)[123])\.(?:jpg|webp)$', parsed.path):
            continue
        width, height = entry.get('width'), entry.get('height')
        measured = all(type(n) is int and 0 < n <= 20000 for n in (width, height))
        if not measured:
            continue
        result[url] = {'url': url, 'width': width, 'height': height,
                       'provenance': 'extractor', 'verified': False}
    return sorted(result.values(), key=lambda c: (-min(c['width'], c['height']),
                                                  -c['width'], c['url']))[:MAX_CANDIDATES]


def thumbnail(info: dict, fallback: str | None = None) -> str | None:
    available = candidates(info)
    return available[0]['url'] if available else info.get('thumbnail') or fallback
