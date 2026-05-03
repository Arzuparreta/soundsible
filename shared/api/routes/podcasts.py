"""
Podcast subscriptions, RSS episodes, and enclosure preview streaming.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime as dt
from typing import Any, Dict, List, Optional

import requests
from flask import Blueprint, Response, jsonify, request, stream_with_context

from shared.hardening import rate_limit, require_admin
from shared.models import LibraryMetadata, PodcastSubscription
from shared.podcast_preview_token import decode_enclosure_stream_token, mint_enclosure_stream_token
from shared.podcast_rss import assert_safe_http_url, fetch_episodes_for_feed

logger = logging.getLogger(__name__)

podcasts_bp = Blueprint("podcasts", __name__, url_prefix="")

_ITUNES_SEARCH = "https://itunes.apple.com/search"
_CACHE_TTL_SEC = 1800
_fetch_lock = threading.Lock()


def _get_api():
    from shared.api import _ensure_lib_metadata, socketio

    return {"_ensure_lib_metadata": _ensure_lib_metadata, "socketio": socketio}


def _subscription_by_id(metadata: LibraryMetadata, feed_id: str) -> Optional[Dict[str, Any]]:
    for s in metadata.podcast_subscriptions:
        if isinstance(s, dict) and s.get("id") == feed_id:
            return s
    return None


@podcasts_bp.route("/api/podcasts/subscriptions", methods=["GET"])
@rate_limit("podcasts_list", limit=60, window_sec=60)
def list_subscriptions():
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"subscriptions": []})
    return jsonify({"subscriptions": list(metadata.podcast_subscriptions)})


@podcasts_bp.route("/api/podcasts/subscribe", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("podcasts_subscribe", limit=40, window_sec=60)
def subscribe():
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.get_json(silent=True) or {}
    rss_url = (data.get("rss_url") or "").strip()
    if not rss_url:
        return jsonify({"error": "rss_url required"}), 400
    try:
        assert_safe_http_url(rss_url)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    title_guess = (data.get("title") or "").strip()
    author_guess = (data.get("author") or "").strip()
    image_guess = (data.get("image_url") or "").strip()
    itunes_id = (data.get("itunes_collection_id") or "").strip()

    from shared.podcast_rss import fetch_feed_body, parse_feed_episodes

    try:
        body = fetch_feed_body(rss_url)
        eps = parse_feed_episodes(body, rss_url)
        parsed = None
        try:
            import feedparser

            parsed = feedparser.parse(body)
        except Exception:
            parsed = None
        feed_title = title_guess
        feed_author = author_guess
        feed_image = image_guess
        if parsed and getattr(parsed, "feed", None):
            fd = parsed.feed
            if not feed_title:
                feed_title = (getattr(fd, "title", None) or "").strip() or "Podcast"
            if not feed_author:
                feed_author = (getattr(fd, "author", None) or getattr(fd, "subtitle", None) or "").strip()
            if not feed_image and getattr(fd, "image", None):
                href = getattr(fd.image, "href", None)
                if href:
                    feed_image = str(href).strip()
    except Exception as e:
        logger.warning("Podcast subscribe fetch failed: %s", e)
        return jsonify({"error": f"Could not load feed: {e}"}), 400

    subscription_id = str(uuid.uuid4())
    sub = PodcastSubscription(
        id=subscription_id,
        title=feed_title or "Podcast",
        author=feed_author or "",
        rss_url=rss_url,
        image_url=feed_image or None,
        itunes_collection_id=itunes_id or None,
    ).to_dict()

    # Dedupe by rss_url
    metadata.podcast_subscriptions = [s for s in metadata.podcast_subscriptions if isinstance(s, dict) and s.get("rss_url") != rss_url]
    metadata.podcast_subscriptions.append(sub)
    metadata.podcast_episode_cache[subscription_id] = {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "episodes": eps[:500],
    }
    lib._save_metadata()
    api["socketio"].emit("library_updated")
    return jsonify({"status": "success", "subscription": sub})


@podcasts_bp.route("/api/podcasts/subscriptions/<feed_id>", methods=["DELETE"])
@require_admin(allow_trusted_network=True)
@rate_limit("podcasts_unsub", limit=40, window_sec=60)
def unsubscribe(feed_id: str):
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    before = len(metadata.podcast_subscriptions)
    metadata.podcast_subscriptions = [
        s for s in metadata.podcast_subscriptions if not (isinstance(s, dict) and s.get("id") == feed_id)
    ]
    if len(metadata.podcast_subscriptions) == before:
        return jsonify({"error": "Not found"}), 404
    metadata.podcast_episode_cache.pop(feed_id, None)
    lib._save_metadata()
    api["socketio"].emit("library_updated")
    return jsonify({"status": "success"})


@podcasts_bp.route("/api/podcasts/feeds/<feed_id>/episodes", methods=["GET"])
@rate_limit("podcasts_episodes", limit=120, window_sec=60)
def feed_episodes(feed_id: str):
    api = _get_api()
    lib, metadata = api["_ensure_lib_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    sub = _subscription_by_id(metadata, feed_id)
    if not sub:
        return jsonify({"error": "Unknown feed"}), 404
    rss_url = (sub.get("rss_url") or "").strip()
    if not rss_url:
        return jsonify({"error": "Invalid subscription"}), 400

    refresh = request.args.get("refresh") in ("1", "true", "yes")
    cache = metadata.podcast_episode_cache.get(feed_id) if isinstance(metadata.podcast_episode_cache, dict) else None
    now = time.time()
    need_fetch = refresh
    if not need_fetch and isinstance(cache, dict):
        fetched_at = cache.get("fetched_at") or ""
        try:
            t = dt.fromisoformat(fetched_at.replace("Z", "+00:00")).timestamp()
            if now - t > _CACHE_TTL_SEC:
                need_fetch = True
        except Exception:
            need_fetch = True
    else:
        need_fetch = need_fetch or not cache

    episodes: List[Dict[str, Any]] = []
    if need_fetch:
        with _fetch_lock:
            try:
                episodes = fetch_episodes_for_feed(rss_url)
            except Exception as e:
                logger.warning("RSS refresh failed for %s: %s", feed_id, e)
                if isinstance(cache, dict) and isinstance(cache.get("episodes"), list):
                    episodes = cache["episodes"]
                else:
                    return jsonify({"error": str(e)}), 502
            metadata.podcast_episode_cache[feed_id] = {
                "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "episodes": episodes[:500],
            }
            lib._save_metadata()
    else:
        episodes = (cache or {}).get("episodes") or []

    return jsonify({"feed_id": feed_id, "subscription": sub, "episodes": episodes})


@podcasts_bp.route("/api/podcasts/episodes-by-url", methods=["GET"])
@rate_limit("podcasts_episodes_browse", limit=120, window_sec=60)
def episodes_by_feed_url():
    """
    Episodes for an RSS URL without a subscription (browse / preview).
    Same SSRF rules as subscribe; does not write library metadata.
    """
    rss_url = (request.args.get("rss_url") or "").strip()
    if not rss_url:
        return jsonify({"error": "rss_url required"}), 400
    try:
        assert_safe_http_url(rss_url)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    try:
        episodes = fetch_episodes_for_feed(rss_url)
    except Exception as e:
        logger.warning("RSS browse fetch failed: %s", e)
        return jsonify({"error": str(e)}), 502
    return jsonify({"rss_url": rss_url, "episodes": episodes})


@podcasts_bp.route("/api/podcasts/enclosure/peek", methods=["POST"])
@rate_limit("podcasts_peek", limit=120, window_sec=60)
def enclosure_peek():
    data = request.get_json(silent=True) or {}
    url = (data.get("enclosure_url") or "").strip()
    if not url:
        return jsonify({"error": "enclosure_url required"}), 400
    try:
        assert_safe_http_url(url)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    token, exp = mint_enclosure_stream_token(url)
    return jsonify({"stream_token": token, "expires_at": exp})


@podcasts_bp.route("/api/podcasts/stream/<token>", methods=["GET"])
@rate_limit("podcasts_stream", limit=120, window_sec=60)
def enclosure_stream(token: str):
    decoded = decode_enclosure_stream_token(token)
    if not decoded:
        return jsonify({"error": "Invalid or expired token"}), 400
    url = decoded["enclosure_url"]
    try:
        assert_safe_http_url(url)
    except ValueError:
        return jsonify({"error": "Invalid URL"}), 400
    range_header = request.headers.get("Range")
    req_headers = {"User-Agent": "SoundsiblePodcast/1.0", "Accept": "audio/*,*/*"}
    if range_header:
        req_headers["Range"] = range_header
    try:
        resp = requests.get(url, headers=req_headers, stream=True, timeout=(5, 120), allow_redirects=True)
        resp.raise_for_status()

        def iter_chunks():
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk

        out_headers = {}
        ct = resp.headers.get("Content-Type")
        if ct:
            out_headers["Content-Type"] = ct
        cr = resp.headers.get("Content-Range")
        if cr:
            out_headers["Content-Range"] = cr
        cl = resp.headers.get("Content-Length")
        if cl:
            out_headers["Content-Length"] = cl

        return Response(
            stream_with_context(iter_chunks()),
            status=resp.status_code,
            headers=out_headers,
            direct_passthrough=True,
        )
    except Exception as e:
        logger.warning("Podcast enclosure stream error: %s", e)
        return jsonify({"error": "Stream unavailable"}), 502
