"""Recommendation helpers: stable identity and dedupe keys for raw items."""

import hashlib
import re


def normalize_artist_title(artist: str, title: str) -> str:
    """Single key for (artist, title) for dedupe and stable id. Lowercase, stripped, collapsed whitespace."""
    a = (artist or "").strip().lower()
    t = (title or "").strip().lower()
    a = re.sub(r"\s+", " ", a)
    t = re.sub(r"\s+", " ", t)
    return f"{a}|{t}"


def raw_stable_id(artist: str, title: str) -> str:
    """Stable id for a raw recommendation (same artist+title => same id). Frontend can use for session dedupe."""
    key = normalize_artist_title(artist, title)
    if not key or key == "|":
        return "raw-unknown"
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()[:14]
    return f"raw-{h}"


def raw_to_dict(r, stable_id: str) -> dict:
    """Turn a RawRecommendation or dict into a serializable dict with the given stable id."""
    if hasattr(r, "__dict__"):
        d = {k: v for k, v in r.__dict__.items() if not k.startswith("_")}
    else:
        d = dict(r)
    d["id"] = stable_id
    return d
