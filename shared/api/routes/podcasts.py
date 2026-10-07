"""
Podcast subscriptions, RSS episodes, and enclosure preview streaming.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

import requests
from flask import Blueprint, Response, jsonify, request, stream_with_context

from shared.hardening import SCOPE_LIBRARY_WRITE, rate_limit, require_scope
from shared.models import LibraryMetadata, PodcastSubscription
from shared.podcast_preview_token import decode_enclosure_stream_token, mint_enclosure_stream_token
from shared.podcast_rss import FeedCheck, assert_safe_http_url, check_feed, fetch_feed_body, parse_feed, parse_feed_episodes

logger = logging.getLogger(__name__)

podcasts_bp = Blueprint("podcasts", __name__, url_prefix="")

_ITUNES_SEARCH = "https://itunes.apple.com/search"
# How long a followed show's feed is taken as read. Opening a show looks at its
# feed again past this, so a new episode is there the next time it is opened;
# within it, going back and forth between a show and its episodes costs nothing.
_RECHECK_SEC = 60
_CACHED_EPISODES = 500
_fetch_lock = threading.Lock()
# When each followed show's feed was last looked at, on the monotonic clock.
# Kept in memory rather than with the cache, so that a look that finds nothing
# new writes nothing; after a restart a show is simply looked at once more.
_checked: Dict[str, float] = {}


def _get_api():
    from shared.api import _ensure_lib_metadata, emit_to_user, socketio

    return {
        "_ensure_lib_metadata": _ensure_lib_metadata,
        "socketio": socketio,
        "emit_to_user": emit_to_user,
    }


def _cached_episodes(episodes: List[Dict[str, Any]], next_after: Optional[int], looked: FeedCheck) -> Dict[str, Any]:
    """What a followed show keeps of its feed: its first episodes, and where the
    rest of the feed picks up after them (#250). Past a list cut here the count
    is of episodes, which can only fall short of the entries they came from, so
    the page that follows may repeat a few the list has but never skips one.

    It also keeps what tells the next read whether the feed has changed: the
    validators the feed sent, and a digest of the page for feeds that send
    none, so an unchanged feed is neither parsed nor saved again."""
    kept = episodes[:_CACHED_EPISODES]
    return {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "episodes": kept,
        "next": len(kept) if len(episodes) > len(kept) else next_after,
        "validators": looked.validators,
        "digest": _digest(looked.page.xml) if looked.page else None,
    }


def _digest(xml: bytes) -> str:
    return hashlib.sha1(xml).hexdigest()


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
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
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

    try:
        looked = check_feed(rss_url)
        show, eps = parse_feed(looked.page.xml, rss_url)
        feed_title = title_guess or show["title"]
        feed_author = author_guess or show["author"]
        feed_image = image_guess or show["image_url"]
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
    metadata.podcast_episode_cache[subscription_id] = _cached_episodes(eps, looked.page.next, looked)
    _checked[subscription_id] = time.monotonic()
    lib.require_saved()
    api["emit_to_user"]("library_updated")
    return jsonify({"status": "success", "subscription": sub})


@podcasts_bp.route("/api/podcasts/subscriptions/<feed_id>", methods=["DELETE"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
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
    _checked.pop(feed_id, None)
    lib.require_saved()
    api["emit_to_user"]("library_updated")
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

    # `cached` answers from what was kept without going to the feed, for the
    # page to show at once; the read that follows it looks at the feed for
    # anything new. `refresh` reads the feed whole, whenever it was last read.
    refresh = _flag("refresh")
    cache = _kept(metadata, feed_id)
    if cache is not None and not refresh and (_flag("cached") or not _due(feed_id)):
        return _episodes_answer(feed_id, sub, cache["episodes"], cache.get("next"), changed=False)

    with _fetch_lock:
        # Another request for the same show may have looked while this one
        # waited; what it found is in the cache now.
        cache = _kept(metadata, feed_id)
        if cache is not None and not refresh and not _due(feed_id):
            return _episodes_answer(feed_id, sub, cache["episodes"], cache.get("next"), changed=False)
        try:
            looked = check_feed(rss_url, None if refresh or cache is None else cache.get("validators"))
        except Exception as e:
            # What was kept stands untouched: a failed read used to be saved
            # as a fresh one, which hid new episodes for another half hour.
            logger.warning("RSS refresh failed for %s: %s", feed_id, e)
            if cache is None or refresh:
                return jsonify({"error": str(e)}), 502
            _checked[feed_id] = time.monotonic()
            return _episodes_answer(feed_id, sub, cache["episodes"], cache.get("next"), changed=False)
        _checked[feed_id] = time.monotonic()
        if looked.page is None or (cache is not None and _digest(looked.page.xml) == cache.get("digest")):
            if cache.get("validators") != looked.validators:
                cache["validators"] = looked.validators
                lib.require_saved()
            return _episodes_answer(feed_id, sub, cache["episodes"], cache.get("next"), changed=False)
        episodes = parse_feed_episodes(looked.page.xml, rss_url)
        next_after = looked.page.next
        metadata.podcast_episode_cache[feed_id] = _cached_episodes(episodes, next_after, looked)
        lib.require_saved()
    return _episodes_answer(feed_id, sub, episodes, next_after, changed=True)


def _kept(metadata: LibraryMetadata, feed_id: str) -> Optional[Dict[str, Any]]:
    cache = metadata.podcast_episode_cache.get(feed_id) if isinstance(metadata.podcast_episode_cache, dict) else None
    return cache if isinstance(cache, dict) and isinstance(cache.get("episodes"), list) else None


def _flag(name: str) -> bool:
    return request.args.get(name) in ("1", "true", "yes")


def _due(feed_id: str) -> bool:
    last = _checked.get(feed_id)
    return last is None or time.monotonic() - last >= _RECHECK_SEC


def _episodes_answer(feed_id: str, sub: Dict[str, Any], episodes: List[Dict[str, Any]], next_after: Any, changed: bool):
    """`changed` says the list is not the one the page was last given, so a
    page already showing the show has something to replace."""
    return jsonify({
        "feed_id": feed_id,
        "subscription": sub,
        "episodes": episodes,
        "next": next_after if isinstance(next_after, int) else None,
        "changed": changed,
    })


@podcasts_bp.route("/api/podcasts/episodes-by-url", methods=["GET"])
@rate_limit("podcasts_episodes_browse", limit=120, window_sec=60)
def episodes_by_feed_url():
    """
    A show and its episodes from an RSS URL without a subscription, so a show
    found in the directory can be opened before it is followed. Same SSRF rules
    as subscribe; does not write library metadata.

    A feed too long to read at once comes a page at a time: `next` in the
    answer, handed back as `after`, asks for the page that follows. Followed
    shows read their further pages here too (#250).
    """
    rss_url = (request.args.get("rss_url") or "").strip()
    if not rss_url:
        return jsonify({"error": "rss_url required"}), 400
    try:
        assert_safe_http_url(rss_url)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    after = max(0, request.args.get("after", 0, type=int))
    try:
        page = fetch_feed_body(rss_url, after)
        show, episodes = parse_feed(page.xml, rss_url)
    except Exception as e:
        logger.warning("RSS browse fetch failed: %s", e)
        return jsonify({"error": str(e)}), 502
    return jsonify({"rss_url": rss_url, "show": show, "episodes": episodes, "next": page.next})


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
    resp = None
    try:
        resp = requests.get(url, headers=req_headers, stream=True, timeout=(5, 120), allow_redirects=True)
        resp.raise_for_status()

        def iter_chunks():
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
            finally:
                resp.close()

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

        response = Response(
            stream_with_context(iter_chunks()),
            status=resp.status_code,
            headers=out_headers,
            direct_passthrough=True,
        )
        response.call_on_close(resp.close)
        return response
    except Exception as e:
        if resp is not None:
            resp.close()
        logger.warning("Podcast enclosure stream error: %s", e)
        return jsonify({"error": "Stream unavailable"}), 502
