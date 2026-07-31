"""Discovery: settings, listening feedback, saving a discovered song, and the
read-only Deezer proxy browsers need because api.deezer.com sends no CORS.

The rest of discovery lives in siblings that attach to the same blueprint —
`discovery_feed` (the music feed), `auto_mode` (the planner and DJ engine),
`discovery_graph` (the related-video expansion), `podcasts_directory` (Apple).
Importing them here is what registers their routes, so `discovery_bp` still
carries the whole surface.
"""

from __future__ import annotations

import logging
import re

import requests
from flask import Response, jsonify, request

from shared.hardening import rate_limit
from shared.providers import deezer
from shared.discovery_intelligence import (
    POSITIVE_LISTENING_EVENTS,
    build_music_recommendations,
    emit_discovery_event,
    load_discovery_settings,
    load_recently_saved_tracks,
    record_not_interested,
    reset_discovery_profile,
    save_discovery_settings,
    undo_discovery_feedback,
)

from .discovery_bp import discovery_bp
from .discovery_common import _get_api, _invalidate_personalized_cache

# Re-exported for external consumers that used to import these from discovery.py.
from .discovery_graph import _discover_executor, _discover_inflight, _discover_request_seeds, warm_discover_top_seeds  # noqa: F401  # imported by shared/api/__init__.py and tests
from .auto_mode import (  # noqa: F401  # imported by tests
    _build_auto_pools,
    _build_music_plan,
    _dj_item_analysis,
    _dj_source_path,
    _planner_artist_candidates,
    _planner_context_related,
    _planner_item_from_related,
    _planner_related_artist_pool,
    _resolve_generated_playback,
)
from .discovery_common import _DEEZER_TRACK_CACHE_TTL_SEC, _DISCOVERY_FEED_CACHE  # noqa: F401  # imported by tests
from .discovery_feed import (  # noqa: F401  # imported by tests
    _build_discovery_feed_body,
    _build_music_feed,
    _cached_related_feed_candidates,
    _deezer_json,
    _DISCOVERY_FEED_INFLIGHT,
    _DISCOVERY_FEED_LOCK,
    _schedule_discovery_feed_refresh,
)

# DJ engine symbols that used to be in discovery.py's namespace.
from shared.dj_engine import cached_analysis, request_analysis  # noqa: F401  # imported by tests

# Imported for their side effect: each attaches its routes to `discovery_bp`.
from . import discovery_graph as _discovery_graph  # noqa: F401,E402
from . import discovery_feed as _discovery_feed  # noqa: F401,E402
from . import auto_mode as _auto_mode  # noqa: F401,E402
from . import podcasts_directory as _podcasts_directory  # noqa: F401,E402

logger = logging.getLogger(__name__)

_ALLOWED_PATH = re.compile(
    r"^(playlist/\d+|chart|search|track/\d+|artist/\d+/top)$"
)

_MAX_PERSONALIZED_SEEDS = 5


@discovery_bp.route("/api/discovery/settings", methods=["GET"])
@rate_limit("discovery_settings_get", limit=60, window_sec=60)
def discovery_settings_get():
    return jsonify(load_discovery_settings())


@discovery_bp.route("/api/discovery/settings", methods=["PATCH"])
@rate_limit("discovery_settings_patch", limit=30, window_sec=60)
def discovery_settings_patch():
    data = request.get_json(silent=True) or {}
    if "learning_enabled" in data and not isinstance(data.get("learning_enabled"), bool):
        return jsonify({"error": "learning_enabled must be boolean"}), 400
    if "autoplay_enabled" in data and not isinstance(data.get("autoplay_enabled"), bool):
        return jsonify({"error": "autoplay_enabled must be boolean"}), 400
    saved = save_discovery_settings(data)
    _invalidate_personalized_cache()
    return jsonify(saved)


@discovery_bp.route("/api/discovery/profile", methods=["DELETE"])
@rate_limit("discovery_profile_reset", limit=6, window_sec=60)
def discovery_profile_reset():
    reset_discovery_profile()
    _invalidate_personalized_cache()
    return jsonify({"status": "reset"})


@discovery_bp.route("/api/discovery/events", methods=["POST"])
@rate_limit("discovery_events", limit=240, window_sec=60)
def discovery_events_post():
    data = request.get_json(silent=True) or {}
    event = (data.get("event") or "").strip()
    payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
    if event not in POSITIVE_LISTENING_EVENTS:
        return jsonify({"error": "Unsupported discovery event"}), 400
    recorded = emit_discovery_event(event, payload)
    if recorded:
        _invalidate_personalized_cache()
    return jsonify({"status": "recorded" if recorded else "disabled", "recorded": recorded})


@discovery_bp.route("/api/discovery/feedback", methods=["POST"])
@rate_limit("discovery_feedback", limit=120, window_sec=60)
def discovery_feedback_post():
    data = request.get_json(silent=True) or {}
    if data.get("feedback") != "not_interested":
        return jsonify({"error": "Unsupported feedback"}), 400
    item = data.get("item") if isinstance(data.get("item"), dict) else {}
    event_id = record_not_interested(item)
    if event_id:
        _invalidate_personalized_cache()
    return jsonify({
        "status": "recorded" if event_id else "disabled",
        "recorded": bool(event_id),
        "event_id": event_id or None,
    })


@discovery_bp.route("/api/discovery/feedback/<event_id>", methods=["DELETE"])
@rate_limit("discovery_feedback_undo", limit=120, window_sec=60)
def discovery_feedback_undo(event_id: str):
    undone = undo_discovery_feedback(event_id)
    if undone:
        _invalidate_personalized_cache()
    return jsonify({"status": "undone" if undone else "not_found", "undone": undone}), (200 if undone else 404)


@discovery_bp.route("/api/discovery/save", methods=["POST"])
@rate_limit("discovery_save", limit=60, window_sec=60)
def discovery_save():
    """
    Resolve a Deezer track to YouTube and queue it for download.

    Request body:
      artist       str  required
      title        str  required
      duration     int  optional  seconds
      deezer_id    str  optional  numeric Deezer track id
      cover        str  optional  cover art URL
      confirm_video_id  str  optional  user-confirmed YouTube video id (skips search)

    Response:
      {status: "queued",       confidence, confidence_level, queue_id}
      {status: "needs_review", confidence, confidence_level, candidates: [...]}
      {status: "failed",       reason, candidates: [...]}
    """
    from shared.resolution_confidence import best_candidate, classify_confidence
    from shared.database import instance_db

    data = request.get_json(silent=True) or {}
    artist = (data.get("artist") or "").strip()
    title = (data.get("title") or "").strip()
    if not artist or not title:
        return jsonify({"error": "artist and title are required"}), 400

    duration_s = None
    raw_dur = data.get("duration")
    if raw_dur is not None:
        try:
            duration_s = int(raw_dur)
        except (TypeError, ValueError):
            pass

    deezer_id = (data.get("deezer_id") or "").strip() or None
    cover = (data.get("cover") or "").strip() or None
    confirm_video_id = (data.get("confirm_video_id") or "").strip() or None

    api = _get_api()

    # — User-confirmed video id bypasses search/scoring —
    if confirm_video_id:
        return _queue_confirmed(
            artist, title, duration_s, deezer_id, cover, confirm_video_id, api
        )

    # — Check resolution cache —
    db = instance_db()
    cached = db.get_cached_resolution(artist, title)
    if cached and cached.get("confidence") is not None:
        score = cached["confidence"]
        level = classify_confidence(score)
        if level == "high":
            return _queue_confirmed(
                artist, title, duration_s, deezer_id, cover, cached["id"], api,
                confidence=score, confidence_reason=cached.get("confidence_reason"),
            )
        # Medium/low: still show review even if cached, candidates may be stale
        return jsonify({
            "status": "needs_review",
            "confidence": score,
            "confidence_level": level,
            "best": _candidate_summary(cached),
            "candidates": cached.get("candidates") or [],
        })

    # — Search YouTube for candidates —
    try:
        dl = api["get_downloader"](open_browser=False)
        raw_results = dl.downloader.search_match_candidates(artist, title, max_results=6)
    except Exception as exc:
        logger.warning("discovery/save: YouTube search failed: %s", exc)
        return jsonify({"status": "failed", "reason": "search_error", "candidates": []}), 502

    if not raw_results:
        db.set_cached_resolution(artist, title, {
            "id": "",
            "failure_state": "not_found",
            "confidence": 0.0,
            "confidence_reason": "no_match",
        })
        return jsonify({"status": "failed", "reason": "not_found", "candidates": []}), 404

    best, score, reason, ranked = best_candidate(artist, title, duration_s, raw_results)

    # Cache the result
    db.set_cached_resolution(artist, title, {
        "id": best.get("id", ""),
        "duration": best.get("duration"),
        "thumbnail": best.get("thumbnail") or f"https://img.youtube.com/vi/{best.get('id','')}/mqdefault.jpg",
        "webpage_url": best.get("webpage_url") or f"https://www.youtube.com/watch?v={best.get('id','')}",
        "channel": best.get("channel") or best.get("uploader") or "",
        "confidence": score,
        "confidence_reason": reason,
        "candidates": ranked,
    })

    level = classify_confidence(score)

    if level == "high":
        return _queue_confirmed(
            artist, title, duration_s, deezer_id, cover, best["id"], api,
            confidence=score, confidence_reason=reason,
        )

    return jsonify({
        "status": "needs_review",
        "confidence": score,
        "confidence_level": level,
        "best": _candidate_summary({**best, "confidence": score, "confidence_reason": reason}),
        "candidates": ranked,
    })


def _candidate_summary(c: dict) -> dict:
    vid = c.get("id") or c.get("youtube_id") or ""
    return {
        "video_id": vid,
        "title": c.get("title") or "",
        "channel": c.get("channel") or c.get("uploader") or "",
        "duration": c.get("duration") or 0,
        "thumbnail": c.get("thumbnail") or (f"https://img.youtube.com/vi/{vid}/mqdefault.jpg" if vid else ""),
        "confidence": c.get("confidence"),
        "confidence_level": c.get("confidence_level") or c.get("confidence_reason"),
    }


def _queue_confirmed(
    artist: str,
    title: str,
    duration_s,
    deezer_id,
    cover,
    video_id: str,
    api: dict,
    confidence: float = 1.0,
    confidence_reason: str = "confirmed",
):
    """Add a confirmed video id to the download queue and return queued status."""
    thumb = cover or (f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg" if video_id else "")
    item = {
        "source_type": "youtube_url",
        "song_str": f"https://www.youtube.com/watch?v={video_id}" if video_id else "",
        "video_id": video_id,
        "display_title": title,
        "display_artist": artist,
        "thumbnail_url": thumb,
        "duration_sec": duration_s,
        "metadata_evidence": {
            "title": title,
            "artist": artist,
            "deezer_id": deezer_id,
            "save_flow": "discovery_save",
        },
    }
    parsed, err = api["parse_intake_item"](item)
    if err:
        return jsonify({"status": "failed", "reason": err, "candidates": []}), 400

    parsed["intake_source"] = parsed.get("source_type")
    import hashlib
    import json as _json
    parsed["intake_payload_hash"] = hashlib.sha256(
        _json.dumps(parsed, sort_keys=True, default=str).encode()
    ).hexdigest()

    new_item = api["queue_manager_dl"].add(parsed, user_id=api["user_id"])
    try:
        if not api["queue_manager_dl"].is_processing:
            api["start_downloader_pump"]()
    except Exception:
        pass

    emit_discovery_event("music_saved_to_library", {
        "artist": artist,
        "title": title,
        "deezer_id": deezer_id,
        "video_id": video_id,
        "confidence": confidence,
    })

    return jsonify({
        "status": "queued",
        "queue_id": new_item.get("id"),
        "video_id": video_id,
        "confidence": confidence,
        "confidence_level": "confirmed" if confidence_reason == "confirmed" else (
            "high" if confidence >= 0.75 else "medium"
        ),
        "confidence_reason": confidence_reason,
    })


@discovery_bp.route("/api/discovery/music/recommendations", methods=["GET"])
@rate_limit("discovery_music_recommendations", limit=120, window_sec=60)
def discovery_music_recommendations():
    limit = min(50, max(1, request.args.get("limit", type=int) or 24))
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    mod = api["_mod"]
    fav_ids = mod.favourite_library_ids()
    return jsonify(build_music_recommendations(metadata, fav_ids, limit=limit))


@discovery_bp.route("/api/discovery/music/recently-saved", methods=["GET"])
@rate_limit("discovery_recently_saved", limit=60, window_sec=60)
def discovery_recently_saved():
    limit = min(24, max(1, request.args.get("limit", type=int) or 12))
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    library_tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    track_by_id = {t.id: t for t in library_tracks}

    saved = load_recently_saved_tracks(limit)
    items = []
    for ev in saved:
        track = track_by_id.get(ev["track_id"])
        item = {
            "track_id": ev["track_id"],
            "title": ev["title"] or (track.title if track else ""),
            "artist": ev["artist"] or (track.artist if track else ""),
            "saved_at": ev["saved_at"],
            "in_library": track is not None,
            "deezer_id": ev["deezer_id"],
            "youtube_id": ev["youtube_id"],
        }
        if track:
            item["cover"] = getattr(track, "cover_art_key", None) or ""
            item["album"] = track.album or ""
            item["duration"] = int(track.duration or 0)
        items.append(item)
    return jsonify({"items": items})


@discovery_bp.route("/api/discovery/deezer/<path:deezer_path>", methods=["GET"])
@rate_limit("discovery_deezer", limit=120, window_sec=60)
def deezer_proxy(deezer_path: str):
    if not _ALLOWED_PATH.fullmatch(deezer_path):
        return jsonify({"error": "Unsupported Deezer path"}), 400
    upstream = f"{deezer.HOST}/{deezer_path}"
    try:
        # The pooled session, but not the cache: this passes bytes and status
        # straight through for arbitrary paths, so there is nothing to key on.
        resp = deezer.session().get(upstream, params=request.args, timeout=20)
    except requests.RequestException as exc:
        logger.warning("Deezer proxy request failed: %s", exc)
        return jsonify({"error": "Deezer unreachable"}), 502

    ct = resp.headers.get("Content-Type", "application/json")
    return Response(resp.content, status=resp.status_code, content_type=ct)
