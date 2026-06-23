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

from shared.discovery_intelligence import (
    POSITIVE_LISTENING_EVENTS,
    build_music_recommendations,
    build_podcast_recommendations,
    emit_discovery_event,
    load_discovery_settings,
    load_recently_saved_tracks,
    save_discovery_settings,
)
from shared.hardening import SCOPE_ADMIN_CONFIG, require_scope
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

# RSS chart often returns 503 from some networks; browser-like UA sometimes helps.
_HTTP_HEADERS_RSS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) "
        "Gecko/20100101 Firefox/128.0"
    ),
    "Accept": "application/json,text/plain,*/*",
}
_HTTP_HEADERS_ITUNES = {"User-Agent": "SoundsibleDiscovery/1.0"}

_PODCAST_TOP_CACHE: dict[str, tuple[float, list]] = {}
_PODCAST_TOP_TTL_SEC = 90
_DEEZER_JSON_CACHE: dict[str, tuple[float, dict]] = {}
_DEEZER_TRACK_CACHE_TTL_SEC = 180
_MUSIC_FEED_CACHE: dict[str, tuple[float, dict]] = {}
_MUSIC_FEED_TTL_SEC = 120
_LOOKUP_CHUNK = 40
# Short search terms — merged and deduped when RSS chart is unavailable.
_ITUNES_TOP_FALLBACK_TERMS = ("podcast", "news", "comedy", "technology", "sports")
_CURATED_DEEZER_PLAYLISTS = (
    ("3155776842", "Fresh picks"),
)
_CURATED_DISCOVERY_SEARCHES = (
    ("latin pop", "Fresh latin pop"),
    ("indie pop", "Indie discoveries"),
    ("electronic", "Electronic pulse"),
)


def _podcast_row_from_itunes_search(r: dict) -> dict | None:
    if not isinstance(r, dict):
        return None
    feed = (r.get("feedUrl") or "").strip()
    if not feed:
        return None
    cid = r.get("collectionId")
    cid_str = str(cid) if cid is not None else ""
    if not cid_str:
        return None
    return {
        "itunes_collection_id": cid_str,
        "title": (r.get("collectionName") or "").strip() or "Podcast",
        "author": (r.get("artistName") or "").strip(),
        "feed_url": feed,
        "image_url": (r.get("artworkUrl600") or r.get("artworkUrl100") or "").strip(),
    }


def _get_api():
    import shared.api as api_mod
    return {
        "get_core": api_mod.get_core,
        "get_downloader": api_mod.get_downloader,
        "queue_manager_dl": api_mod.queue_manager_dl,
        "start_downloader_pump": api_mod.start_downloader_pump,
        "parse_intake_item": api_mod.parse_intake_item,
        "_mod": api_mod,
    }


@discovery_bp.route("/api/discovery/settings", methods=["GET"])
@rate_limit("discovery_settings_get", limit=60, window_sec=60)
def discovery_settings_get():
    return jsonify(load_discovery_settings())


@discovery_bp.route("/api/discovery/settings", methods=["PATCH"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("discovery_settings_patch", limit=30, window_sec=60)
def discovery_settings_patch():
    data = request.get_json(silent=True) or {}
    if "learning_enabled" in data and not isinstance(data.get("learning_enabled"), bool):
        return jsonify({"error": "learning_enabled must be boolean"}), 400
    return jsonify(save_discovery_settings(data))


@discovery_bp.route("/api/discovery/events", methods=["POST"])
@rate_limit("discovery_events", limit=240, window_sec=60)
def discovery_events_post():
    data = request.get_json(silent=True) or {}
    event = (data.get("event") or "").strip()
    payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
    if event not in POSITIVE_LISTENING_EVENTS:
        return jsonify({"error": "Unsupported discovery event"}), 400
    recorded = emit_discovery_event(event, payload)
    return jsonify({"status": "recorded" if recorded else "disabled", "recorded": recorded})


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
    from shared.resolution_confidence import best_candidate, classify_confidence, CONFIDENCE_HIGH
    from shared.database import DatabaseManager

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
    db = DatabaseManager()
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
        q = f"{title} {artist}".strip()
        raw_results = dl.downloader.search_youtube(q, max_results=6, use_ytmusic=True)
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
        "source_type": "ytmusic_search",
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

    new_item = api["queue_manager_dl"].add(parsed)
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


def _norm_music_key(title: object, artist: object) -> str:
    title_s = re.sub(r"\s+", " ", str(title or "").strip().casefold())
    artist_s = re.sub(r"\s+", " ", str(artist or "").strip().casefold())
    return f"{artist_s}\x00{title_s}"


def _deezer_json(path: str, params: dict | None = None, ttl_sec: int = _DEEZER_TRACK_CACHE_TTL_SEC) -> dict:
    params = params or {}
    key = f"{path}?{tuple(sorted((str(k), str(v)) for k, v in params.items()))}"
    now = time.time()
    cached = _DEEZER_JSON_CACHE.get(key)
    if cached and cached[0] > now:
        return cached[1]
    resp = requests.get(
        f"{_DEEZER_HOST}/{path}",
        params=params,
        timeout=8,
        headers={"User-Agent": "SoundsibleDiscovery/1.0"},
    )
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        data = {}
    _DEEZER_JSON_CACHE[key] = (now + ttl_sec, data)
    return data


def _deezer_track_to_feed_item(row: dict, *, source: str, reason: str, reason_code: str, in_library: bool) -> dict | None:
    if not isinstance(row, dict):
        return None
    deezer_id = row.get("id")
    title = (row.get("title_short") or row.get("title") or "").strip()
    artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
    artist = (artist_row.get("name") or row.get("artist") or "").strip()
    if not deezer_id or not title or not artist:
        return None
    album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
    cover = (
        album_row.get("cover_xl")
        or album_row.get("cover_big")
        or album_row.get("cover_medium")
        or row.get("cover")
        or ""
    )
    return {
        "id": f"deezer:{deezer_id}",
        "media_type": "music_track",
        "source": source,
        "title": title,
        "artist": artist,
        "album": (album_row.get("title") or "").strip(),
        "duration": int(row.get("duration") or 0),
        "cover": cover,
        "deezer_id": str(deezer_id),
        "rank": int(row.get("rank") or 0),
        "reason": reason,
        "reason_code": reason_code,
        "confidence": 0.72,
        "action_state": {
            "in_library": bool(in_library),
            "saved": bool(in_library),
            "playable": True,
            "downloadable": not in_library,
            "needs_resolution": True,
        },
        "external_ids": {"deezer_id": str(deezer_id)},
    }


def _append_external_items(
    items: list[dict],
    rows: list,
    *,
    section_id: str,
    title: str,
    reason: str,
    reason_code: str,
    source: str,
    local_keys: set[str],
    seen: set[str],
    limit: int,
) -> dict | None:
    section_ids: list[str] = []
    for row in rows:
        if len(section_ids) >= limit:
            break
        if not isinstance(row, dict):
            continue
        artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
        key = _norm_music_key(row.get("title_short") or row.get("title"), artist_row.get("name") or row.get("artist"))
        item = _deezer_track_to_feed_item(
            row,
            source=source,
            reason=reason,
            reason_code=reason_code,
            in_library=key in local_keys,
        )
        if not item or item["id"] in seen:
            continue
        seen.add(item["id"])
        items.append(item)
        section_ids.append(item["id"])
    if not section_ids:
        return None
    return {
        "id": section_id,
        "title": title,
        "reason": reason,
        "item_ids": section_ids,
        "section_type": source,
    }


def _catalog_item_to_feed_item(row: dict, *, source: str, reason: str, reason_code: str, local_keys: set[str]) -> dict | None:
    title = (row.get("title") or "").strip()
    artist = (row.get("artist") or row.get("subtitle") or "").strip()
    if not title or not artist:
        return None
    ext = row.get("external_ids") if isinstance(row.get("external_ids"), dict) else {}
    local_key = _norm_music_key(title, artist)
    item_id = row.get("id") or f"{source}:{artist}:{title}"
    return {
        "id": str(item_id),
        "media_type": "music_track",
        "source": source,
        "title": title,
        "artist": artist,
        "album": (row.get("album") or "").strip(),
        "duration": int(row.get("duration") or 0),
        "cover": row.get("cover") or "",
        "deezer_id": str(ext.get("deezer_id") or "") or None,
        "rank": int(row.get("popularity") or 0),
        "reason": reason,
        "reason_code": reason_code,
        "confidence": 0.68,
        "action_state": {
            "in_library": local_key in local_keys,
            "saved": local_key in local_keys,
            "playable": True,
            "downloadable": local_key not in local_keys,
            "needs_resolution": True,
        },
        "external_ids": ext,
    }


def _append_catalog_items(
    items: list[dict],
    rows: list[dict],
    *,
    section_id: str,
    title: str,
    reason: str,
    reason_code: str,
    source: str,
    local_keys: set[str],
    seen: set[str],
    limit: int,
) -> dict | None:
    section_ids: list[str] = []
    for row in rows:
        if len(section_ids) >= limit:
            break
        item = _catalog_item_to_feed_item(
            row,
            source=source,
            reason=reason,
            reason_code=reason_code,
            local_keys=local_keys,
        )
        if not item or item["id"] in seen:
            continue
        seen.add(item["id"])
        items.append(item)
        section_ids.append(item["id"])
    if not section_ids:
        return None
    return {
        "id": section_id,
        "title": title,
        "reason": reason,
        "item_ids": section_ids,
        "section_type": source,
    }


def _local_library_keys(metadata) -> set[str]:
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    return {_norm_music_key(t.title, t.artist or t.album_artist) for t in tracks}


def _build_music_feed(metadata, fav_ids: list[str], limit: int) -> dict:
    local_recs = build_music_recommendations(metadata, fav_ids, limit=limit)
    local_keys = _local_library_keys(metadata)
    items: list[dict] = []
    seen: set[str] = set()
    sections: list[dict] = []

    chart_rows: list = []
    try:
        chart = _deezer_json("chart", {"limit": max(24, limit)}, ttl_sec=_DEEZER_TRACK_CACHE_TTL_SEC)
        tracks = chart.get("tracks") if isinstance(chart.get("tracks"), dict) else {}
        chart_rows = tracks.get("data") if isinstance(tracks.get("data"), list) else []
    except Exception as exc:
        logger.info("Discovery music feed: Deezer chart unavailable: %s", exc)

    trending = _append_external_items(
        items,
        chart_rows,
        section_id="trending_now",
        title="Trending now",
        reason="Live chart metadata from Deezer, resolved through Soundsible when you play or save.",
        reason_code="deezer_chart",
        source="deezer_chart",
        local_keys=local_keys,
        seen=seen,
        limit=min(12, limit),
    )
    if trending:
        sections.append(trending)

    new_to_you_rows = [
        row for row in chart_rows
        if _norm_music_key(
            row.get("title_short") or row.get("title"),
            (row.get("artist") or {}).get("name") if isinstance(row.get("artist"), dict) else row.get("artist"),
        ) not in local_keys
    ]
    new_to_you = _append_external_items(
        items,
        new_to_you_rows,
        section_id="new_to_you",
        title="New to you",
        reason="Fresh tracks that are not already in your local library.",
        reason_code="deezer_new_to_you",
        source="deezer_new_to_you",
        local_keys=local_keys,
        seen=seen,
        limit=min(12, limit),
    )
    if new_to_you:
        sections.append(new_to_you)

    for playlist_id, fallback_title in _CURATED_DEEZER_PLAYLISTS:
        try:
            playlist = _deezer_json(f"playlist/{playlist_id}", {"limit": min(24, limit)}, ttl_sec=_DEEZER_TRACK_CACHE_TTL_SEC)
            tracks = playlist.get("tracks") if isinstance(playlist.get("tracks"), dict) else {}
            rows = tracks.get("data") if isinstance(tracks.get("data"), list) else []
        except Exception as exc:
            logger.info("Discovery music feed: Deezer playlist %s unavailable: %s", playlist_id, exc)
            continue
        playlist_title = (playlist.get("title") or fallback_title).strip()
        sec = _append_external_items(
            items,
            rows,
            section_id=f"playlist_{playlist_id}",
            title=playlist_title,
            reason="Curated music metadata you can preview and save into your own library.",
            reason_code="deezer_playlist",
            source="deezer_playlist",
            local_keys=local_keys,
            seen=seen,
            limit=min(12, limit),
        )
        if sec:
            sections.append(sec)

    existing_external = any(str(s.get("section_type") or "").startswith("deezer") for s in sections)
    if not existing_external:
        try:
            from shared.api.routes.catalog import _deezer_search, _musicbrainz_search

            rows: list[dict] = []
            for query, _title in _CURATED_DISCOVERY_SEARCHES:
                rows.extend(_deezer_search(query, max(8, min(12, limit))))
                if len(rows) >= limit:
                    break
            if not rows:
                for query, _title in _CURATED_DISCOVERY_SEARCHES:
                    rows.extend(_musicbrainz_search(query, max(6, min(10, limit))))
                    if len(rows) >= limit:
                        break
            fallback = _append_catalog_items(
                items,
                rows,
                section_id="fresh_external",
                title="Fresh outside your library",
                reason="Catalog metadata from external music directories, resolved through Soundsible when you play or save.",
                reason_code="catalog_fallback",
                source="catalog_discovery",
                local_keys=local_keys,
                seen=seen,
                limit=min(12, limit),
            )
            if fallback:
                sections.insert(0, fallback)
        except Exception as exc:
            logger.info("Discovery music feed: catalog fallback unavailable: %s", exc)

    for item in local_recs.get("items") or []:
        if not isinstance(item, dict) or not item.get("id") or str(item["id"]) in seen:
            continue
        seen.add(str(item["id"]))
        items.append(item)
    for section in local_recs.get("sections") or []:
        if isinstance(section, dict) and section.get("item_ids"):
            sections.append(section)

    return {
        "generated_at": int(time.time()),
        "items": items,
        "sections": sections,
        "settings": local_recs.get("settings") or load_discovery_settings(),
    }


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
    fav_manager = getattr(mod, "favourites_manager", None)
    fav_ids = fav_manager.get_all() if fav_manager is not None else []
    return jsonify(build_music_recommendations(metadata, fav_ids, limit=limit))


@discovery_bp.route("/api/discovery/music/feed", methods=["GET"])
@rate_limit("discovery_music_feed", limit=120, window_sec=60)
def discovery_music_feed():
    limit = min(50, max(1, request.args.get("limit", type=int) or 24))
    cache_key = f"music-feed-v2:{limit}"
    now = time.time()
    cached = _MUSIC_FEED_CACHE.get(cache_key)
    if cached and cached[0] > now:
        body = dict(cached[1])
        body["cached"] = True
        return jsonify(body)

    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    mod = api["_mod"]
    fav_manager = getattr(mod, "favourites_manager", None)
    fav_ids = fav_manager.get_all() if fav_manager is not None else []

    try:
        body = _build_music_feed(metadata, fav_ids, limit)
    except Exception as exc:
        logger.warning("Discovery music feed failed: %s", exc)
        if cached:
            body = dict(cached[1])
            body["cached"] = True
            body["stale"] = True
            return jsonify(body)
        body = {
            "generated_at": int(time.time()),
            "items": [],
            "sections": [],
            "settings": load_discovery_settings(),
            "error": "Discovery feed unavailable",
        }
        return jsonify(body), 502

    body["cached"] = False
    _MUSIC_FEED_CACHE[cache_key] = (now + _MUSIC_FEED_TTL_SEC, dict(body))
    return jsonify(body)


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
    return jsonify(build_podcast_recommendations(metadata, limit=limit))


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


@discovery_bp.route("/api/discovery/podcasts/top", methods=["GET"])
@rate_limit("discovery_podcasts_top", limit=60, window_sec=60)
def itunes_podcast_top():
    country = _country_code(request.args.get("country"))
    limit = min(50, max(1, request.args.get("limit", type=int) or 24))
    explicit_seg = _explicit_segment_from_request()
    allow_explicit = explicit_seg == "explicit"
    cache_key = f"{country}:{limit}:{explicit_seg}"
    now = time.time()
    cached = _PODCAST_TOP_CACHE.get(cache_key)
    if cached and cached[0] > now:
        return jsonify({"results": cached[1]})

    results: list[dict] = []
    try:
        results = _top_podcasts_from_rss_chart(country, limit, explicit_seg)
    except Exception as exc:
        logger.info("Podcast top chart RSS unavailable (%s); using iTunes search mix.", exc)

    if not results:
        results = _top_podcasts_itunes_search_fallback(country, limit, allow_explicit)

    if not results:
        return jsonify({"error": "Directory unreachable", "results": []}), 502

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
