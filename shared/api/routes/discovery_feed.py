"""The music discovery feed.

Built from the listening rollup plus Deezer enrichment, and served
stale-while-revalidate: a cold request answers from local recommendations
without waiting on Deezer, and the enriched version replaces it in the
background.
"""

from __future__ import annotations

import logging
import re
import time

from flask import jsonify, request

from shared.database import instance_db
from shared.discovery_intelligence import (
    build_music_recommendations,
    compose_discovery_feed,
    load_listening_event_rollups,
    load_discovery_settings,
    rank_recommendation_rows,
)
from shared.hardening import rate_limit
from shared.providers import deezer
from shared.text_utils import identity_key

from .discovery_bp import discovery_bp
from .discovery_common import (
    _DEEZER_TRACK_CACHE_TTL_SEC,
    _DISCOVERY_FEED_CACHE,
    _DISCOVERY_FEED_EXECUTOR,
    _DISCOVERY_FEED_INFLIGHT,
    _DISCOVERY_FEED_LOCK,
    _DISCOVERY_FEED_STALE_SEC,
    _DISCOVERY_FEED_TTL_SEC,
    _MAX_PERSONALIZED_SEEDS,
    _get_api,
)
from .discovery_graph import _schedule_expand

logger = logging.getLogger(__name__)

#: Same key `routes/catalog.py` builds, so a row matched in one view matches in
#: the other. It was a second implementation of it until this became an alias.
_norm_music_key = identity_key


def _deezer_json(path: str, params: dict | None = None, ttl_sec: int = _DEEZER_TRACK_CACHE_TTL_SEC) -> dict:
    """The cache behind this used to be a module-level dict that never evicted —
    one entry per artist name ever searched, for the life of the process — and
    it did not single-flight, so N concurrent identical requests each hit
    Deezer. Both are properties of `shared.providers.deezer` now."""
    return deezer.get(path, params, ttl_sec=ttl_sec)


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
    title_key: str | None = None,
    title_params: dict | None = None,
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
    section = {
        "id": section_id,
        "title": title,
        "reason": reason,
        "item_ids": section_ids,
        "section_type": source,
    }
    if title_key:
        section["title_key"] = title_key
    if title_params:
        section["title_params"] = title_params
    return section


def _top_taste_artists(metadata, fav_ids: list[str], limit: int = _MAX_PERSONALIZED_SEEDS) -> list[str]:
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    if not tracks:
        return []
    rollup = load_listening_event_rollups()
    by_id = {t.id: t for t in tracks}
    scores: dict[str, float] = {}
    display: dict[str, str] = {}

    def add_artist(raw: object, score: float) -> None:
        name = str(raw or "").strip()
        key = name.casefold()
        if not key:
            return
        scores[key] = scores.get(key, 0.0) + score
        display.setdefault(key, name)

    for idx, tid in enumerate(fav_ids):
        track = by_id.get(str(tid))
        if track:
            add_artist(track.album_artist or track.artist, 9.0 - min(idx, 8) * 0.35)

    playlists = metadata.playlists if metadata and isinstance(metadata.playlists, dict) else {}
    playlist_track_ids: set[str] = set()
    for ids in playlists.values():
        if isinstance(ids, list):
            playlist_track_ids.update(str(x) for x in ids)
    for tid in playlist_track_ids:
        track = by_id.get(tid)
        if track:
            add_artist(track.album_artist or track.artist, 3.0)

    artist_counts: dict[str, int] = {}
    for track in tracks:
        name = track.album_artist or track.artist
        key = str(name or "").strip().casefold()
        if not key:
            continue
        artist_counts[key] = artist_counts.get(key, 0) + 1
        display.setdefault(key, str(name).strip())
    for key, count in artist_counts.items():
        scores[key] = scores.get(key, 0.0) + min(8.0, count * 1.4)

    for key, count in rollup.artist_plays.items():
        scores[key] = scores.get(key, 0.0) + min(12.0, count * 2.0)
        display.setdefault(key, key.title())
    for key, count in rollup.artist_saves.items():
        scores[key] = scores.get(key, 0.0) + min(10.0, count * 3.0)
        display.setdefault(key, key.title())

    ranked = sorted(scores, key=lambda key: scores[key], reverse=True)
    return [display[key] for key in ranked[:limit] if display.get(key)]


def _deezer_artist_top_rows(artist_name: str, limit: int) -> list[dict]:
    search = _deezer_json("search", {"q": f'artist:"{artist_name}"', "limit": 8}, ttl_sec=_DEEZER_TRACK_CACHE_TTL_SEC)
    rows = search.get("data") if isinstance(search.get("data"), list) else []
    artist_id = ""
    for row in rows:
        if not isinstance(row, dict):
            continue
        artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
        name = (artist_row.get("name") or "").strip()
        if name.casefold() == artist_name.strip().casefold():
            artist_id = str(artist_row.get("id") or "")
            break
    if not artist_id:
        for row in rows:
            if not isinstance(row, dict):
                continue
            artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
            artist_id = str(artist_row.get("id") or "")
            if artist_id:
                break
    if not artist_id:
        return rows[:limit]
    top = _deezer_json(f"artist/{artist_id}/top", {"limit": max(limit, 12)}, ttl_sec=_DEEZER_TRACK_CACHE_TTL_SEC)
    top_rows = top.get("data") if isinstance(top.get("data"), list) else []
    return top_rows[:limit]


def _append_personalized_artist_sections(
    items: list[dict],
    sections: list[dict],
    *,
    metadata,
    fav_ids: list[str],
    local_keys: set[str],
    seen: set[str],
    limit: int,
) -> None:
    added = 0
    for artist in _top_taste_artists(metadata, fav_ids):
        try:
            rows = _deezer_artist_top_rows(artist, max(12, min(18, limit)))
        except Exception as exc:
            logger.info("Discovery music feed: personalized seed %s unavailable: %s", artist, exc)
            continue
        sec = _append_external_items(
            items,
            rows,
            section_id=f"because_you_listen_{re.sub(r'[^a-z0-9]+', '_', artist.casefold()).strip('_')[:44]}",
            title=f"More like {artist}",
            reason="Based on artists you play, save, favourite, or collect in playlists.",
            reason_code="taste_artist_seed",
            source="deezer_taste_artist",
            local_keys=local_keys,
            seen=seen,
            limit=min(10, limit),
            title_key="more_like",
            title_params={"artist": artist},
        )
        if sec:
            sections.append(sec)
            added += 1
        if added >= 3:
            break


def _local_library_keys(metadata) -> set[str]:
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    return {_norm_music_key(t.title, t.artist or t.album_artist) for t in tracks}


def _build_music_feed(metadata, fav_ids: list[str], limit: int) -> dict:
    local_recs = build_music_recommendations(metadata, fav_ids, limit=limit)
    local_keys = _local_library_keys(metadata)
    items: list[dict] = []
    seen: set[str] = set()
    sections: list[dict] = []

    _append_personalized_artist_sections(
        items,
        sections,
        metadata=metadata,
        fav_ids=fav_ids,
        local_keys=local_keys,
        seen=seen,
        limit=limit,
    )

    if sections:
        for item in local_recs.get("items") or []:
            if not isinstance(item, dict) or not item.get("id") or str(item["id"]) in seen:
                continue
            seen.add(str(item["id"]))
            items.append(item)
        for section in local_recs.get("sections") or []:
            if isinstance(section, dict) and section.get("item_ids"):
                sections.append(section)

    ranked_items = rank_recommendation_rows(items, source="discover")
    return {
        "generated_at": int(time.time()),
        "items": ranked_items,
        "sections": sections,
        "settings": local_recs.get("settings") or load_discovery_settings(),
        "needs_seed": not bool(sections),
    }


def _cached_related_feed_candidates(
    metadata,
    fav_ids: list[str],
    *,
    items: list[dict],
    sections: list[dict],
    limit: int,
) -> None:
    """Add cached YouTube graph candidates without blocking feed consumers.

    Missing seeds are warmed in the existing bounded worker pool.
    """
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    if not tracks:
        return
    by_id = {track.id: track for track in tracks}
    rollup = load_listening_event_rollups()
    local_video_ids = {
        str(getattr(track, "youtube_id", "") or "")
        for track in tracks
        if getattr(track, "youtube_id", None)
    }
    seeds: list = []
    seen_seed_ids: set[str] = set()

    def add_seed(track) -> None:
        video = str(getattr(track, "youtube_id", "") or "")
        if not video or track.id in seen_seed_ids:
            return
        seen_seed_ids.add(track.id)
        seeds.append(track)

    for track_id in fav_ids:
        track = by_id.get(str(track_id))
        if track:
            add_seed(track)
    for artist in rollup.recent_artists:
        for track in reversed(tracks):
            if str(track.artist or track.album_artist or "").strip().casefold() == artist:
                add_seed(track)
                break
    for track in reversed(tracks):
        add_seed(track)
        if len(seeds) >= 8:
            break

    known_ids = {str(item.get("id")) for item in items}
    added_sections = 0
    scheduled_misses = 0
    seed_batch = seeds[:6]
    # One query for the whole batch instead of one per seed.
    cached_mixes = instance_db().get_related_mixes(
        str(getattr(seed, "youtube_id", "") or "") for seed in seed_batch
    )
    for seed in seed_batch:
        video_id = str(getattr(seed, "youtube_id", "") or "")
        cached = cached_mixes.get(video_id)
        if cached is None:
            if scheduled_misses < 2:
                _schedule_expand(video_id)
                scheduled_misses += 1
            continue
        section_ids: list[str] = []
        for row in rank_recommendation_rows(cached, source="discover"):
            candidate_video_id = str(row.get("video_id") or row.get("id") or "")
            if (
                not candidate_video_id
                or candidate_video_id in local_video_ids
                or len(section_ids) >= min(10, limit)
            ):
                continue
            item_id = f"youtube:{candidate_video_id}"
            if item_id in known_ids:
                continue
            known_ids.add(item_id)
            artist = str(row.get("channel") or row.get("uploader") or row.get("artist") or "")
            item = {
                "id": item_id,
                "media_type": "music_track",
                "source": "youtube_related",
                "title": str(row.get("title") or "Unknown"),
                "artist": artist,
                "duration": int(row.get("duration") or 0),
                "cover": str(row.get("thumbnail") or ""),
                "reason": f'Related to "{seed.title}".',
                "reason_code": "library_graph",
                "recommendation_identity": row.get("recommendation_identity"),
                "score": float(row.get("score") or 0.5),
                "confidence": 0.82,
                "action_state": {
                    "in_library": False,
                    "saved": False,
                    "playable": True,
                    "downloadable": True,
                    "needs_resolution": False,
                },
                "external_ids": {"youtube_id": candidate_video_id},
            }
            items.append(item)
            section_ids.append(item_id)
        if not section_ids:
            continue
        sections.append({
            "id": f"explore_from_{seed.id}",
            "title": f"Explore from {seed.title}",
            "title_key": "explore_from",
            "title_params": {"title": seed.title},
            "reason": f'Connections from "{seed.title}" in your local music graph.',
            "section_type": "youtube_graph",
            "item_ids": section_ids,
        })
        added_sections += 1
        if added_sections >= 2:
            break


def _build_discovery_feed_body(limit: int, *, include_external: bool = True) -> dict:
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    fav_ids = api["_mod"].favourite_library_ids()
    if include_external:
        feed = _build_music_feed(metadata, fav_ids, max(36, limit * 4))
    else:
        feed = build_music_recommendations(metadata, fav_ids, limit=max(24, limit * 3))
    if not feed["sections"]:
        local = build_music_recommendations(metadata, fav_ids, limit=max(24, limit * 3))
        feed["items"].extend(local.get("items") or [])
        feed["sections"].extend(local.get("sections") or [])
    _cached_related_feed_candidates(
        metadata,
        fav_ids,
        items=feed["items"],
        sections=feed["sections"],
        limit=limit,
    )
    return compose_discovery_feed(
        feed,
        rollup=load_listening_event_rollups(),
        max_sections=6,
        section_size=limit,
    )


def _refresh_discovery_feed_cache(cache_key: str, user_id: str | None, limit: int) -> None:
    try:
        from shared.user_context import user_context

        with user_context(user_id):
            body = _build_discovery_feed_body(limit, include_external=True)
        now = time.time()
        with _DISCOVERY_FEED_LOCK:
            _DISCOVERY_FEED_CACHE[cache_key] = (
                now + _DISCOVERY_FEED_TTL_SEC,
                now + _DISCOVERY_FEED_STALE_SEC,
                dict(body),
            )
    except Exception as exc:
        logger.warning("Discovery feed refresh failed: %s", exc)
    finally:
        with _DISCOVERY_FEED_LOCK:
            _DISCOVERY_FEED_INFLIGHT.discard(cache_key)


def _schedule_discovery_feed_refresh(cache_key: str, user_id: str | None, limit: int) -> bool:
    with _DISCOVERY_FEED_LOCK:
        if cache_key in _DISCOVERY_FEED_INFLIGHT:
            return False
        _DISCOVERY_FEED_INFLIGHT.add(cache_key)
    _DISCOVERY_FEED_EXECUTOR.submit(_refresh_discovery_feed_cache, cache_key, user_id, limit)
    return True


@discovery_bp.route("/api/discovery/music/feed", methods=["GET"])
@rate_limit("discovery_music_feed", limit=120, window_sec=60)
def discovery_music_feed():
    """Ranked zero-query discovery with stale-while-revalidate delivery."""
    from shared.user_context import current_user_id

    limit = min(16, max(4, request.args.get("limit", type=int) or 10))
    user_id = current_user_id()
    cache_key = f"discovery-feed-v4:{user_id or '-'}:{limit}"
    now = time.time()
    with _DISCOVERY_FEED_LOCK:
        cached = _DISCOVERY_FEED_CACHE.get(cache_key)
    if cached and cached[0] > now:
        body = dict(cached[2])
        body.update({"cached": True, "stale": False, "revalidating": False})
        return jsonify(body)
    if cached and cached[1] > now:
        revalidating = _schedule_discovery_feed_refresh(cache_key, user_id, limit)
        body = dict(cached[2])
        body.update({"cached": True, "stale": True, "revalidating": revalidating})
        return jsonify(body)

    try:
        body = _build_discovery_feed_body(limit, include_external=False)
    except Exception as exc:
        logger.warning("Discovery feed build failed: %s", exc)
        return jsonify({
            "v": 1,
            "generated_at": int(now),
            "items": [],
            "sections": [],
            "profile": {
                "maturity": "cold",
                "event_count": 0,
                "distinct_tracks": 0,
                "learning_enabled": load_discovery_settings().get("learning_enabled", True),
            },
            "needs_seed": True,
            "cached": False,
            "stale": False,
            "revalidating": False,
            "error": "Discovery feed unavailable",
        }), 502

    with _DISCOVERY_FEED_LOCK:
        _DISCOVERY_FEED_CACHE[cache_key] = (
            now + _DISCOVERY_FEED_TTL_SEC,
            now + _DISCOVERY_FEED_STALE_SEC,
            dict(body),
        )
    revalidating = _schedule_discovery_feed_refresh(cache_key, user_id, limit)
    body.update({"cached": False, "stale": False, "revalidating": revalidating})
    return jsonify(body)
