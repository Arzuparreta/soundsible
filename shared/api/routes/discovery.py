"""
Deezer read-only proxy: browsers cannot call api.deezer.com directly (no CORS).
Station forwards allowlisted GET paths to Deezer and returns JSON unchanged.
"""

from __future__ import annotations

import logging
import re
import time

import requests
from flask import Blueprint, Response, jsonify, request

from shared.hardening import rate_limit

logger = logging.getLogger(__name__)

discovery_bp = Blueprint("discovery", __name__, url_prefix="")

_DEEZER_HOST = "https://api.deezer.com"
_ALLOWED_PATH = re.compile(
    r"^(playlist/\d+|chart|search|track/\d+|artist/\d+/top)$"
)

_ITUNES_SEARCH = "https://itunes.apple.com/search"
_ITUNES_LOOKUP = "https://itunes.apple.com/lookup"
_APPLE_PODCAST_TOP = "https://rss.itunes.apple.com/api/v1/{country}/podcasts/top-podcasts/all/{limit}/{explicit}.json"

_PODCAST_TOP_CACHE: dict[str, tuple[float, list]] = {}
_PODCAST_TOP_TTL_SEC = 45 * 60
_LOOKUP_CHUNK = 40


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
            headers={"User-Agent": "SoundsibleDiscovery/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("iTunes podcast search failed: %s", exc)
        return jsonify({"error": "Directory unreachable", "results": []}), 502

    results = []
    for r in data.get("results") or []:
        if not isinstance(r, dict):
            continue
        feed = (r.get("feedUrl") or "").strip()
        if not feed:
            continue
        cid = r.get("collectionId")
        results.append(
            {
                "itunes_collection_id": str(cid) if cid is not None else "",
                "title": (r.get("collectionName") or "").strip() or "Podcast",
                "author": (r.get("artistName") or "").strip(),
                "feed_url": feed,
                "image_url": (r.get("artworkUrl600") or r.get("artworkUrl100") or "").strip(),
            }
        )
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
                headers={"User-Agent": "SoundsibleDiscovery/1.0"},
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


@discovery_bp.route("/api/discovery/podcasts/top", methods=["GET"])
@rate_limit("discovery_podcasts_top", limit=60, window_sec=60)
def itunes_podcast_top():
    country = _country_code(request.args.get("country"))
    limit = min(50, max(1, request.args.get("limit", type=int) or 24))
    explicit_seg = _explicit_segment_from_request()
    cache_key = f"{country}:{limit}:{explicit_seg}"
    now = time.time()
    cached = _PODCAST_TOP_CACHE.get(cache_key)
    if cached and cached[0] > now:
        return jsonify({"results": cached[1]})

    url = _APPLE_PODCAST_TOP.format(country=country, limit=limit, explicit=explicit_seg)
    try:
        resp = requests.get(
            url,
            timeout=25,
            headers={"User-Agent": "SoundsibleDiscovery/1.0"},
        )
        resp.raise_for_status()
        chart_data = resp.json()
    except Exception as exc:
        logger.warning("Apple top podcasts chart failed: %s", exc)
        return jsonify({"error": "Chart unreachable", "results": []}), 502

    rows = _extract_top_podcast_chart(chart_data)
    if not rows:
        _PODCAST_TOP_CACHE[cache_key] = (now + _PODCAST_TOP_TTL_SEC, [])
        return jsonify({"results": []})

    ids = [r["itunes_collection_id"] for r in rows]
    feeds = _lookup_feed_urls(ids)

    results = []
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

    _PODCAST_TOP_CACHE[cache_key] = (now + _PODCAST_TOP_TTL_SEC, results)
    return jsonify({"results": results})


@discovery_bp.route("/api/discovery/deezer/<path:deezer_path>", methods=["GET"])
@rate_limit("discovery_deezer", limit=120, window_sec=60)
def deezer_proxy(deezer_path: str):
    if not _ALLOWED_PATH.fullmatch(deezer_path):
        return jsonify({"error": "Unsupported Deezer path"}), 400
    upstream = f"{_DEEZER_HOST}/{deezer_path}"
    try:
        resp = requests.get(
            upstream,
            params=request.args,
            timeout=20,
            headers={"User-Agent": "SoundsibleDiscovery/1.0"},
        )
    except requests.RequestException as exc:
        logger.warning("Deezer proxy request failed: %s", exc)
        return jsonify({"error": "Deezer unreachable"}), 502

    ct = resp.headers.get("Content-Type", "application/json")
    return Response(resp.content, status=resp.status_code, content_type=ct)
