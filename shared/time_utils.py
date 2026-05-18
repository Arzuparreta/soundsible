"""Timezone-aware UTC helpers (replaces deprecated datetime.utcnow())."""

from __future__ import annotations

from datetime import datetime, timezone

UTC = timezone.utc


def utc_now_iso_naive() -> str:
    """UTC instant as naive ISO string (compatible with historical utcnow().isoformat())."""
    return datetime.now(UTC).replace(tzinfo=None).isoformat()


def utc_now_iso_z() -> str:
    """UTC instant as ISO-8601 with Z suffix."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def utc_naive() -> datetime:
    """Naive datetime whose components are UTC (e.g. SQLite timestamps)."""
    return datetime.now(UTC).replace(tzinfo=None)
