"""Podcast discovery against the public Apple directory.

Search, top charts (RSS with an iTunes search fallback), and recommendations
built from what has actually been listened to.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlsplit

import requests
from flask import jsonify, request

from shared.podcast_regions import PODCAST_COUNTRIES
from shared.api.memo import Memo
from shared.hardening import rate_limit
from shared.discovery_intelligence import (
    build_podcast_recommendations,
    load_discovery_settings,
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
        exploration = _podcast_top_results(_request_country(), limit, "explicit")
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
                "country": _request_country(),
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
    if c in PODCAST_COUNTRIES:
        return c
    return "us"


def _request_country() -> str:
    return _country_code(request.args.get("country") or load_discovery_settings().get("podcast_country"))


@discovery_bp.route("/api/discovery/podcasts/countries", methods=["GET"])
def podcast_countries():
    return jsonify({"countries": sorted(PODCAST_COUNTRIES)})


def _explicit_segment_from_request() -> str:
    v = (request.args.get("explicit") or "1").strip().lower()
    if v in ("0", "false", "no", "non-explicit", "clean"):
        return "non-explicit"
    return "explicit"


def _chart_genres(item: dict) -> list[dict]:
    return [{"id": str(g["genreId"]), "name": str(g["name"])}
            for g in item.get("genres", []) if isinstance(g, dict) and g.get("genreId") and g.get("name")]


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
                "genres": _chart_genres(item),
                "author": author,
                "image_url": img,
            }
        )
    return out


def _lookup_feed_urls(collection_ids: list[str], country: str = "us", *, strict: bool = False) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for i in range(0, len(collection_ids), _LOOKUP_CHUNK):
        part = [x for x in collection_ids[i : i + _LOOKUP_CHUNK] if x]
        if not part:
            continue
        try:
            resp = requests.get(
                _ITUNES_LOOKUP,
                params={"id": ",".join(part), "entity": "podcast", "country": country},
                timeout=20,
                headers=_HTTP_HEADERS_ITUNES,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as exc:
            logger.warning("iTunes podcast lookup failed: %s", exc)
            if strict:
                raise
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
    if explicit_seg == "non-explicit":
        chart_data["feed"]["results"] = [r for r in chart_data.get("feed", {}).get("results", [])
                                         if str(r.get("contentAdvisoryRating", "")).lower() not in ("explicit", "explict")]
    rows = _extract_top_podcast_chart(chart_data)
    if not rows:
        return []

    ids = [r["itunes_collection_id"] for r in rows]
    feeds = _lookup_feed_urls(ids, country)

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
                "genres": r["genres"],
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
    country = _request_country()
    limit = min(50, max(1, request.args.get("limit", type=int) or 24))
    explicit_seg = _explicit_segment_from_request()
    try:
        results = _podcast_top_memo.resolve(f"chart:{country}:{limit}:{explicit_seg}",
            lambda: _top_podcasts_from_rss_chart(country, limit, explicit_seg))
    except Exception:
        results = []
    if not results:
        return jsonify({"error": "Directory unreachable", "results": []}), 502
    return jsonify({"country": country, "results": results})


_episode_chart_memo: Memo[list] = Memo(ttl_sec=90, maxsize=64, negative_ttl_sec=15)
_episode_lookup_memo: Memo[list] = Memo(ttl_sec=90, maxsize=64, negative_ttl_sec=15)


def _top_episodes(country: str, limit: int) -> list[dict]:
    url = f"https://rss.marketingtools.apple.com/api/v2/{country}/podcasts/top/{limit}/podcast-episodes.json"
    resp = requests.get(url, timeout=25, headers=_HTTP_HEADERS_RSS)
    resp.raise_for_status()
    rows = []
    for item in resp.json().get("feed", {}).get("results", []):
        # The episode ID cannot be looked up directly. Its Apple link identifies
        # the parent show, whose lookup supplies the feed and episode audio.
        link = urlsplit(item.get("url") or "")
        match = re.search(r"/id(\d+)$", link.path)
        if link.hostname != "podcasts.apple.com" or not match or not str(item.get("id", "")).isdigit():
            continue
        rows.append({"episode_id": str(item["id"]), "itunes_collection_id": match[1],
                     "title": item.get("name") or "Podcast", "author": item.get("artistName") or "",
                     "image_url": item.get("artworkUrl100") or "", "genres": _chart_genres(item)})
    feeds = _lookup_feed_urls(list(dict.fromkeys(r["itunes_collection_id"] for r in rows)), country, strict=True)
    return [dict(row, feed_url=feeds[row["itunes_collection_id"]]) for row in rows
            if row["itunes_collection_id"] in feeds]


@discovery_bp.route("/api/discovery/podcasts/top-episodes", methods=["GET"])
@rate_limit("discovery_podcast_episodes", limit=60, window_sec=60)
def top_podcast_episodes():
    country = _request_country()
    limit = min(50, max(1, request.args.get("limit", type=int) or 20))
    try:
        rows = _episode_chart_memo.resolve(f"{country}:{limit}", lambda: _top_episodes(country, limit))
        return jsonify({"country": country, "results": rows})
    except Exception as exc:
        logger.info("Podcast episode chart unavailable: %s", exc)
        return jsonify({"error": "Directory unreachable", "results": []}), 502


@discovery_bp.route("/api/discovery/podcasts/episode", methods=["GET"])
@rate_limit("discovery_podcast_episode", limit=60, window_sec=60)
def podcast_chart_episode():
    country = _request_country()
    show_id = request.args.get("show_id") or ""
    episode_id = request.args.get("episode_id") or ""
    if not re.fullmatch(r"[0-9]{1,20}", show_id) or not re.fullmatch(r"[0-9]{1,20}", episode_id):
        return jsonify({"error": "Invalid podcast episode"}), 400

    def lookup():
        resp = requests.get(_ITUNES_LOOKUP, params={"id": show_id, "country": country,
                            "entity": "podcastEpisode", "limit": 200}, timeout=20, headers=_HTTP_HEADERS_ITUNES)
        resp.raise_for_status()
        return resp.json().get("results") or []

    try:
        rows = _episode_lookup_memo.resolve(f"{country}:{show_id}", lookup)
        show = next((r for r in rows if r.get("kind") == "podcast" and str(r.get("collectionId")) == show_id), {})
        row = next((r for r in rows if r.get("kind") == "podcast-episode"
                    and str(r.get("trackId")) == episode_id and str(r.get("collectionId")) == show_id
                    and r.get("episodeContentType") == "audio" and r.get("episodeUrl")), None)
        if not row:
            return jsonify({"error": "Episode unavailable"}), 404
        return jsonify({"show_title": show.get("collectionName") or row.get("collectionName"),
                        "feed_url": show.get("feedUrl") or row.get("feedUrl"),
                        "episode": {"guid": row.get("episodeGuid") or episode_id, "title": row.get("trackName"),
                                    "enclosure_url": row["episodeUrl"], "published": row.get("releaseDate"),
                                    "duration_sec": (row.get("trackTimeMillis") or 0) / 1000,
                                    "image": row.get("artworkUrl600") or row.get("artworkUrl100")}})
    except Exception as exc:
        logger.info("Podcast episode lookup unavailable: %s", exc)
        return jsonify({"error": "Directory unreachable"}), 502
