"""Typed YouTube stream resolution.

A googlevideo URL is not portable between network paths: when yt-dlp resolves
it through a residential relay, the CDN may reject a later fetch from the VPS
address.  Keeping the egress beside the URL makes that invariant impossible to
forget in preview streaming, prefetching, and legacy generator callers.
"""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Literal, Optional
from urllib.parse import parse_qs, urlparse

StreamEgress = Literal["direct", "relay"]


@dataclass(frozen=True)
class ResolvedStream:
    url: str
    egress: StreamEgress
    resolved_at: float
    expires_at: Optional[float] = None
    proxy_url: Optional[str] = None
    resolution_ms: int = 0

    def requests_proxies(self) -> Optional[dict[str, str]]:
        if self.egress != "relay" or not self.proxy_url:
            return None
        return {"http": self.proxy_url, "https": self.proxy_url}

    def cache_ttl(self, default_sec: int = 300, safety_margin_sec: int = 60) -> int:
        """Safe cache lifetime, bounded by the signed URL's own expiry."""
        if self.expires_at is None:
            return default_sec
        remaining = int(self.expires_at - time.time() - safety_margin_sec)
        return max(1, min(default_sec, remaining))


def resolved_stream(
    url: str,
    *,
    egress: StreamEgress,
    proxy_url: Optional[str] = None,
    resolution_ms: int = 0,
    now: Optional[float] = None,
) -> ResolvedStream:
    resolved_at = time.time() if now is None else now
    expires_at: Optional[float] = None
    try:
        raw_expiry = parse_qs(urlparse(url).query).get("expire", [None])[0]
        if raw_expiry is not None:
            parsed = float(raw_expiry)
            if parsed > resolved_at:
                expires_at = parsed
    except (TypeError, ValueError):
        pass
    return ResolvedStream(
        url=url,
        egress=egress,
        resolved_at=resolved_at,
        expires_at=expires_at,
        proxy_url=proxy_url if egress == "relay" else None,
        resolution_ms=max(0, int(resolution_ms)),
    )
