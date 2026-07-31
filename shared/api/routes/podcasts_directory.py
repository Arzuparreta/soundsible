"""Podcast discovery against the public Apple directory.

Search, top charts (RSS with an iTunes search fallback), and recommendations
built from what has actually been listened to.
"""

from __future__ import annotations

import logging
import re

import requests
from flask import jsonify, request

from shared.api.memo import Memo
from shared.hardening import rate_limit
from shared.discovery_intelligence import (
    build_podcast_recommendations,
)

from .discovery_bp import discovery_bp
from .discovery_common import (
    _APPLE_PODCAST_TOP,
    _HTTP_HEADERS_ITUNES,
    _HTTP_HEADERS_RSS,
    _ITUNES_LOOKUP,
    _ITUNES_SEARCH,
    _ITUNES_TOP_FALLBACK_TERMS,
    _LOOKUP_CHUNK,
    _get_api,
    _podcast_row_from_itunes_search,
)

logger = logging.getLogger(__name__)

_PODCAST_TOP_TTL_SEC = 90
#: Bounded and single-flighted, unlike the module dict this replaced.
_podcast_top_memo: Memo[list] = Memo(ttl_sec=_PODCAST_TOP_TTL_SEC, maxsize=64, negative_ttl_sec=15)

@discovery_bp.route("/api/discovery/podcasts/recommendations", methods=["GET"])
@rate_limit("discovery_podcast_recommendations", limit=120, window_sec=60)
def discovery_podcast_recommendations():
    limit = min(50, max(1, request.args.get("limit", type=int) or 24))
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    try:
        exploration = _podcast_top_results("us", limit, "explicit")
    except Exception as exc:
        logger.info("Podcast recommendation exploration unavailable: %s", exc)
        exploration = []
    return jsonify(build_podcast_recommendations(
        metadata,
        limit=limit,
        exploration_rows=exploration,
    ))


@discovery_bp.route("/api/discovery/podcasts/search", methods=["GET"])
@rate_limit("discovery_podcasts", limit=120, window_sec=60)
def itunes_podcast_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"results": []})
    limit = min(25, max(1, request.args.get("limit", type=int) or 15))
    try:
        resp = requests.get(
            _ITUNES_SEARCH,
            params={
                "term": q,
                "media": "podcast",
                "entity": "podcast",
                "limit": limit,
            },
            timeout=20,
            headers=_HTTP_HEADERS_ITUNES,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("iTunes podcast search failed: %s", exc)
        return jsonify({"error": "Directory unreachable", "results": []}), 502

    results = []
    for r in data.get("results") or []:
        row = _podcast_row_from_itunes_search(r)
        if row:
            results.append(row)
    return jsonify({"results": results})


def _country_code(raw: str | None) -> str:
    c = (raw or "us").strip().lower()
    if re.fullmatch(r"[a-z]{2}", c):
        return c
    return "us"


def _explicit_segment_from_request() -> str:
    v = (request.args.get("explicit") or "1").strip().lower()
    if v in ("0", "false", "no", "non-explicit", "clean"):
        return "non-explicit"
    return "explicit"


def _extract_top_podcast_chart(data: object) -> list[dict]:
    if not isinstance(data, dict):
        return []
    feed = data.get("feed")
    results = None
    if isinstance(feed, dict):
        results = feed.get("results")
    if results is None:
        results = data.get("results")
    if not isinstance(results, list):
        return []
    out: list[dict] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        cid = item.get("id")
        if cid is None:
            cid = item.get("collectionId")
        if cid is None:
            continue
        try:
            cid_str = str(int(cid))
        except (TypeError, ValueError):
            cid_str = str(cid).strip()
            if not cid_str:
                continue
        name = (item.get("name") or item.get("collectionName") or "").strip() or "Podcast"
        author = (item.get("artistName") or "").strip()
        img = (
            item.get("artworkUrl600")
            or item.get("artworkUrl100")
            or item.get("artworkUrl512")
            or ""
        )
        img = img.strip() if isinstance(img, str) else ""
        out.append(
            {
                "itunes_collection_id": cid_str,
                "title": name,
                "author": author,
                "image_url": img,
            }
        )
    return out


def _lookup_feed_urls(collection_ids: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for i in range(0, len(collection_ids), _LOOKUP_CHUNK):
        part = [x for x in collection_ids[i : i + _LOOKUP_CHUNK] if x]
        if not part:
            continue
        try:
            resp = requests.get(
                _ITUNES_LOOKUP,
                params={"id": ",".join(part), "entity": "podcast"},
                timeout=20,
                headers=_HTTP_HEADERS_ITUNES,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as exc:
            logger.warning("iTunes podcast lookup failed: %s", exc)
            continue
        for row in payload.get("results") or []:
            if not isinstance(row, dict):
                continue
            if row.get("kind") != "podcast":
                continue
            cid = row.get("collectionId")
            if cid is None:
                continue
            try:
                cid_str = str(int(cid))
            except (TypeError, ValueError):
                continue
            feed = (row.get("feedUrl") or "").strip()
            if feed:
                mapping[cid_str] = feed
    return mapping


def _top_podcasts_from_rss_chart(country: str, limit: int, explicit_seg: str) -> list[dict]:
    url = _APPLE_PODCAST_TOP.format(country=country, limit=limit, explicit=explicit_seg)
    resp = requests.get(url, timeout=25, headers=_HTTP_HEADERS_RSS)
    resp.raise_for_status()
    chart_data = resp.json()
    rows = _extract_top_podcast_chart(chart_data)
    if not rows:
        return []

    ids = [r["itunes_collection_id"] for r in rows]
    feeds = _lookup_feed_urls(ids)

    results: list[dict] = []
    for r in rows:
        cid = r["itunes_collection_id"]
        feed = feeds.get(cid)
        if not feed:
            continue
        results.append(
            {
                "itunes_collection_id": cid,
                "title": r["title"],
                "author": r["author"],
                "feed_url": feed,
                "image_url": r["image_url"],
            }
        )
    return results


def _top_podcasts_itunes_search_fallback(country: str, limit: int, allow_explicit: bool) -> list[dict]:
    """When rss.itunes.apple.com is down (503, etc.), build a discovery list from Search API (includes feedUrl)."""
    explicit = "Yes" if allow_explicit else "No"
    per_term = max(8, min(25, (limit + len(_ITUNES_TOP_FALLBACK_TERMS) - 1) // len(_ITUNES_TOP_FALLBACK_TERMS)))
    seen: set[str] = set()
    out: list[dict] = []

    for term in _ITUNES_TOP_FALLBACK_TERMS:
        if len(out) >= limit:
            break
        try:
            resp = requests.get(
                _ITUNES_SEARCH,
                params={
                    "term": term,
                    "media": "podcast",
                    "entity": "podcast",
                    "country": country,
                    "limit": per_term,
                    "explicit": explicit,
                },
                timeout=20,
                headers=_HTTP_HEADERS_ITUNES,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            logger.warning("iTunes search fallback term=%r failed: %s", term, exc)
            continue

        for r in data.get("results") or []:
            if len(out) >= limit:
                break
            row = _podcast_row_from_itunes_search(r)
            if not row:
                continue
            cid = row["itunes_collection_id"]
            if cid in seen:
                continue
            seen.add(cid)
            out.append(row)

    return out[:limit]


def _podcast_top_results(country: str, limit: int, explicit_seg: str) -> list[dict]:
    cache_key = f"{country}:{limit}:{explicit_seg}"

    def build() -> list[dict]:
        try:
            results = _top_podcasts_from_rss_chart(country, limit, explicit_seg)
        except Exception as exc:
            logger.info("Podcast top chart RSS unavailable (%s); using iTunes search mix.", exc)
            results = []
        if not results:
            results = _top_podcasts_itunes_search_fallback(
                country,
                limit,
                explicit_seg == "explicit",
            )
        return results

    # `Memo` rather than a module dict: this used to keep one entry per
    # (country, limit, explicit) combination forever, and an empty result was
    # simply not stored, so a failing chart was re-fetched on every request.
    return _podcast_top_memo.resolve(cache_key, build)


@discovery_bp.route("/api/discovery/podcasts/top", methods=["GET"])
@rate_limit("discovery_podcasts_top", limit=60, window_sec=60)
def itunes_podcast_top():
    country = _country_code(request.args.get("country"))
    limit = min(50, max(1, request.args.get("limit", type=int) or 24))
    explicit_seg = _explicit_segment_from_request()
    results = _podcast_top_results(country, limit, explicit_seg)
    if not results:
        return jsonify({"error": "Directory unreachable", "results": []}), 502
    return jsonify({"results": results})
