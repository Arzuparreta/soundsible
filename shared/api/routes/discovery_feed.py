"""The music discovery feed.

Built from local taste seeds (listening rollup, favourites, playlists, and saved
entities) plus Deezer and YouTube graph enrichment, and served
stale-while-revalidate: a cold request answers from cached graph mixes without
waiting on Deezer, and the enriched version replaces it in the background.
"""

from __future__ import annotations

import hashlib
from itertools import zip_longest
import logging
import re
import time

from flask import jsonify, request

from shared.database import instance_db
from shared.discovery_intelligence import (
    artist_recommendation_multiplier,
    compose_discovery_feed,
    load_listening_event_rollups,
    load_discovery_settings,
    rank_recommendation_rows,
)
from shared.discovery_seeds import (
    record_recent_graph_seeds,
    record_recent_taste_seeds,
    select_graph_seed_tracks,
    select_release_seed_artists,
    select_taste_artists,
)
from shared.discovery_signals import register_discovery_signal_handler
from shared.hardening import rate_limit
from shared.music_identity import youtube_music_metadata
from shared.providers import deezer
from shared.text_utils import fold_text, identity_key

from .discovery_bp import discovery_bp
from .discovery_common import (
    _DISCOVERY_FEED_CACHE,
    _DISCOVERY_FEED_DIRTY,
    _DISCOVERY_FEED_EXECUTOR,
    _DISCOVERY_FEED_INFLIGHT,
    _DISCOVERY_FEED_LOCK,
    _DISCOVERY_FEED_STALE_SEC,
    _DISCOVERY_FEED_TTL_SEC,
    _MAX_PERSONALIZED_SEEDS,
    _get_api,
    _invalidate_personalized_cache_for_user_detailed,
)
from .discovery_graph import _schedule_expand

logger = logging.getLogger(__name__)

#: Same key `routes/catalog.py` builds, so a row matched in one view matches in
#: the other. It was a second implementation of it until this became an alias.
_norm_music_key = identity_key


def _deezer_json(path: str, params: dict | None = None, ttl_sec: int | None = None) -> dict:
    """The cache behind this used to be a module-level dict that never evicted —
    one entry per artist name ever searched, for the life of the process — and
    it did not single-flight, so N concurrent identical requests each hit
    Deezer. Both are properties of `shared.providers.deezer` now."""
    return deezer.get(path, params, ttl_sec=ttl_sec)


def _row_artist_name(row: dict, fallback: str = "") -> str:
    artist_field = row.get("artist")
    if isinstance(artist_field, dict):
        name = artist_field.get("name")
    elif isinstance(artist_field, str):
        name = artist_field
    else:
        name = ""
    return str(name or fallback).strip()


def _section_slug(prefix: str, text: str) -> str:
    folded = fold_text(text)
    slug = re.sub(r"[^a-z0-9]+", "_", folded).strip("_")[:44]
    if slug and all(ord(ch) < 128 for ch in folded):
        return f"{prefix}_{slug}"
    digest = hashlib.sha1(text.strip().casefold().encode("utf-8")).hexdigest()[:8]
    return f"{prefix}_{slug}_{digest}" if slug else f"{prefix}_{digest}"


def _deezer_track_to_feed_item(row: dict, *, source: str, reason: str, reason_code: str, in_library: bool) -> dict | None:
    if not isinstance(row, dict):
        return None
    deezer_id = row.get("id")
    title = (row.get("title_short") or row.get("title") or "").strip()
    artist = _row_artist_name(row)
    if not deezer_id or not title or not artist:
        return None
    album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
    artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
    deezer_artist_id = str(artist_row.get("id") or "").strip()
    isrc = str(row.get("isrc") or "").strip()
    cover = deezer.image(album_row, "cover") or str(row.get("cover") or "")
    external_ids = {"deezer_id": str(deezer_id)}
    if deezer_artist_id:
        external_ids["deezer_artist_id"] = deezer_artist_id
    if isrc:
        external_ids["isrc"] = isrc
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
        "external_ids": external_ids,
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
    section_reason: str | None = None,
    reason_key: str | None = None,
    reason_params: dict | None = None,
) -> dict | None:
    section_ids: list[str] = []
    for row in rows:
        if len(section_ids) >= limit:
            break
        if not isinstance(row, dict):
            continue
        row_artist = _row_artist_name(row)
        key = _norm_music_key(row.get("title_short") or row.get("title"), row_artist)
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
        "reason": section_reason or reason,
        "item_ids": section_ids,
        "section_type": source,
    }
    if title_key:
        section["title_key"] = title_key
    if title_params:
        section["title_params"] = title_params
    if reason_key:
        section["reason_key"] = reason_key
    if reason_params:
        section["reason_params"] = reason_params
    return section


def _top_taste_artists(
    metadata,
    fav_ids: list[str],
    limit: int = _MAX_PERSONALIZED_SEEDS,
    *,
    rotate: bool = False,
) -> list[str]:
    return select_taste_artists(metadata, fav_ids, limit=limit, rotate=rotate)


def _resolve_deezer_artist_id(
    artist_name: str,
    *,
    allow_approximate: bool = False,
    search_limit: int = 8,
) -> str | None:
    """Resolve an artist name to a Deezer artist id, folding diacritics and ranking by fans."""
    wanted = fold_text(artist_name)
    if not wanted:
        return None
    search = _deezer_json("search/artist", {"q": artist_name, "limit": search_limit})
    rows = [
        row
        for row in (search.get("data") if isinstance(search.get("data"), list) else [])
        if isinstance(row, dict) and row.get("id") and (row.get("name") or "").strip()
    ]
    if not rows:
        return None
    exact = [row for row in rows if fold_text(row.get("name")) == wanted]
    if exact:
        exact.sort(key=lambda row: int(row.get("nb_fan") or 0), reverse=True)
        return str(exact[0]["id"])
    if allow_approximate:
        return str(rows[0]["id"])
    return None


def _deezer_artist_top_rows(artist_name: str, limit: int) -> list[dict]:
    """The artist's top tracks, found through a plain artist search: Deezer's
    `artist:"…"` field syntax stopped answering in October 2026."""
    artist_id = _resolve_deezer_artist_id(artist_name, allow_approximate=True, search_limit=8)
    if not artist_id:
        return []
    top = _deezer_json(f"artist/{artist_id}/top", {"limit": max(limit, 12)})
    top_rows = top.get("data") if isinstance(top.get("data"), list) else []
    return top_rows[:limit]


def _deezer_related_artist_rows(
    artist_name: str,
    limit: int,
    *,
    local_keys: set[str] | None = None,
    exclude_ids: set[str] | None = None,
    used_related_artists: set[str] | None = None,
    deadline: float | None = None,
    per_artist: int = 2,
) -> list[dict]:
    """Top tracks from artists related to `artist_name`, round-robin interleaved."""
    if deadline is not None and time.monotonic() >= deadline:
        return []
    seed_id = _resolve_deezer_artist_id(artist_name, allow_approximate=False, search_limit=5)
    if not seed_id:
        return []
    if deadline is not None and time.monotonic() >= deadline:
        return []
    rel = _deezer_json(f"artist/{seed_id}/related", {"limit": 10})
    rel_rows = rel.get("data") if isinstance(rel.get("data"), list) else []
    seed_folded = fold_text(artist_name)
    related_artists: list[tuple[str, str]] = []
    seen_artists: set[str] = {seed_id}
    for row in rel_rows:
        if not isinstance(row, dict):
            continue
        rel_id = str(row.get("id") or "").strip()
        rel_name = str(row.get("name") or "").strip()
        if not rel_id or not rel_name or rel_id in seen_artists:
            continue
        if fold_text(rel_name) == seed_folded:
            continue
        seen_artists.add(rel_id)
        related_artists.append((rel_id, rel_name))
    if not related_artists:
        return []

    if used_related_artists:
        fresh = [pair for pair in related_artists if pair[0] not in used_related_artists]
        reused = [pair for pair in related_artists if pair[0] in used_related_artists]
        related_artists = fresh + reused
    related_artists.sort(
        key=lambda pair: artist_recommendation_multiplier(pair[1], deezer_artist_id=pair[0]),
        reverse=True,
    )

    pools: list[list[dict]] = []
    fetched = 0
    for rel_id, rel_name in related_artists:
        if fetched >= 6 or (len(pools) >= 5 and sum(len(p) for p in pools) >= limit):
            break
        if deadline is not None and time.monotonic() >= deadline:
            break
        fetched += 1
        try:
            top = _deezer_json(
                f"artist/{rel_id}/top",
                {"limit": max(per_artist * 4, 8)},
            )
        except deezer.DeezerQuotaError:
            raise
        except Exception as exc:
            logger.info("Discovery music feed: related artist %s (%s) unavailable: %s", rel_name, rel_id, exc)
            continue
        top_rows = top.get("data") if isinstance(top.get("data"), list) else []
        pool: list[dict] = []
        for row in top_rows:
            if not isinstance(row, dict):
                continue
            track_id = row.get("id")
            full_title = (row.get("title") or "").strip()
            short_title = (row.get("title_short") or "").strip()
            title = short_title or full_title
            artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
            if str(artist_row.get("id") or "").strip() == seed_id:
                continue
            row_artist = _row_artist_name(row, fallback=rel_name)
            if not track_id or not title or not row_artist:
                continue
            if fold_text(row_artist) == seed_folded:
                continue
            if exclude_ids and f"deezer:{track_id}" in exclude_ids:
                continue
            if local_keys and any(
                _norm_music_key(candidate, row_artist) in local_keys
                for candidate in (full_title, short_title)
                if candidate
            ):
                continue
            if not isinstance(row.get("artist"), dict) or not artist_row.get("name"):
                row = {**row, "artist": {"id": rel_id, "name": row_artist}}
            pool.append(row)
            if len(pool) >= per_artist:
                break
        if pool:
            pools.append(pool)
            if used_related_artists is not None:
                used_related_artists.add(rel_id)

    out: list[dict] = []
    seen_track_ids: set[str] = set()
    for round_items in zip_longest(*pools):
        for row in round_items:
            if not row:
                continue
            tid = str(row.get("id") or "")
            if not tid or tid in seen_track_ids:
                continue
            seen_track_ids.add(tid)
            out.append(row)
            if len(out) >= limit:
                return out
    return out


def _append_personalized_artist_sections(
    items: list[dict],
    sections: list[dict],
    *,
    metadata,
    fav_ids: list[str],
    local_keys: set[str],
    seen: set[str],
    limit: int,
    taste_seeds: list[str] | None = None,
    rotate: bool = False,
) -> None:
    deadline = time.monotonic() + 12.0
    used_related_artists: set[str] = set()
    added = 0
    artists = taste_seeds if taste_seeds is not None else _top_taste_artists(metadata, fav_ids, rotate=rotate)
    for artist in artists:
        if time.monotonic() >= deadline:
            break
        try:
            rows = _deezer_related_artist_rows(
                artist,
                max(12, min(18, limit)),
                local_keys=local_keys,
                exclude_ids=seen,
                used_related_artists=used_related_artists,
                deadline=deadline,
            )
        except deezer.DeezerQuotaError:
            logger.info("Discovery music feed: Deezer quota reached; skipping remaining seeds")
            break
        except Exception as exc:
            logger.info("Discovery music feed: personalized seed %s unavailable: %s", artist, exc)
            continue
        sec = _append_external_items(
            items,
            rows,
            section_id=_section_slug("because_you_listen", artist),
            title=f"More like {artist}",
            reason=f"Similar to {artist}.",
            section_reason=f"Similar artists to {artist} based on your listening and library.",
            reason_code="taste_artist_seed",
            source="deezer_taste_artist",
            local_keys=local_keys,
            seen=seen,
            limit=min(10, limit),
            title_key="more_like",
            title_params={"artist": artist},
            reason_key="because_listen",
            reason_params={"artist": artist},
        )
        if sec:
            sections.append(sec)
            added += 1
        if added >= 3:
            break


def _local_library_keys(metadata) -> set[str]:
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    return {_norm_music_key(t.title, t.artist or t.album_artist) for t in tracks}


def _local_album_keys(metadata) -> set[str]:
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    return {
        key
        for t in tracks
        if (key := _norm_music_key(t.album, t.album_artist or t.artist))
    }


def _build_music_feed(
    metadata,
    fav_ids: list[str],
    limit: int,
    *,
    taste_seeds: list[str] | None = None,
    rotate: bool = False,
) -> dict:
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
        taste_seeds=taste_seeds,
        rotate=rotate,
    )

    ranked_items = rank_recommendation_rows(items, source="discover")
    return {
        "generated_at": int(time.time()),
        "items": ranked_items,
        "sections": sections,
        "settings": load_discovery_settings(),
        "needs_seed": not bool(sections),
    }


def _cached_related_feed_candidates(
    metadata,
    fav_ids: list[str],
    *,
    items: list[dict],
    sections: list[dict],
    limit: int,
    rotate: bool = False,
    user_id: str | None = None,
    record_seeds: bool = False,
) -> None:
    """Add cached YouTube graph candidates without blocking feed consumers.

    Missing seeds are warmed in the existing bounded worker pool.
    """
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    if not tracks:
        return
    local_video_ids = {
        str(getattr(track, "youtube_id", "") or "")
        for track in tracks
        if getattr(track, "youtube_id", None)
    }
    seeds = select_graph_seed_tracks(
        metadata,
        fav_ids,
        limit=8,
        user_id=user_id,
        rotate=rotate,
        require_youtube_id=True,
    )

    known_ids = {str(item.get("id")) for item in items}
    added_sections = 0
    scheduled_misses = 0
    seed_batch = seeds[:6]
    if record_seeds and seed_batch:
        record_recent_graph_seeds(user_id, [seed.id for seed in seed_batch])
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
            item = {
                "id": item_id,
                "media_type": "music_track",
                "source": "youtube_related",
                **youtube_music_metadata(row),
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
            "reason_key": "explore_connections",
            "reason_params": {"title": seed.title},
            "section_type": "youtube_graph",
            "item_ids": section_ids,
        })
        added_sections += 1
        if added_sections >= 2:
            break


def _build_discovery_feed_body(
    limit: int,
    *,
    include_external: bool = True,
    rotate: bool = False,
) -> dict:
    from shared.user_context import current_user_id

    api = _get_api()
    lib = api["get_library"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    fav_ids = api["favourite_library_ids"]()
    user_id = current_user_id()
    taste_seeds: list[str] | None = None
    if include_external:
        taste_seeds = _top_taste_artists(metadata, fav_ids, rotate=rotate)
        feed = _build_music_feed(
            metadata,
            fav_ids,
            max(36, limit * 4),
            taste_seeds=taste_seeds,
            rotate=rotate,
        )
    else:
        feed = {
            "generated_at": int(time.time()),
            "items": [],
            "sections": [],
            "settings": load_discovery_settings(),
            "needs_seed": True,
        }
    _cached_related_feed_candidates(
        metadata,
        fav_ids,
        items=feed["items"],
        sections=feed["sections"],
        limit=limit,
        rotate=rotate,
        user_id=user_id,
        record_seeds=include_external,
    )
    body = compose_discovery_feed(
        feed,
        rollup=load_listening_event_rollups(),
        max_sections=6,
        section_size=limit,
    )

    if include_external:
        from shared.discovery_browse import build_browse_sections

        seeds = taste_seeds if taste_seeds is not None else _top_taste_artists(metadata, fav_ids, rotate=rotate)
        release_seeds = select_release_seed_artists(metadata, fav_ids, limit=8, user_id=user_id)
        body.update(
            build_browse_sections(
                seeds,
                min(limit, 10),
                release_seeds=release_seeds,
                owned_album_keys=_local_album_keys(metadata),
            )
        )
        if any(not sec.get("popular", True) for sec in body.get("browse_sections") or []):
            body["needs_seed"] = False
        if seeds:
            record_recent_taste_seeds(user_id, seeds)
    return body


def _refresh_discovery_feed_cache(
    cache_key: str,
    user_id: str | None,
    limit: int,
    *,
    rotate: bool = False,
    _followup: bool = False,
) -> None:
    payload: dict = {"limit": limit}
    rerun = False
    try:
        from shared import request_scope
        from shared.user_context import user_context

        with request_scope.request_scope(), user_context(user_id):
            body = _build_discovery_feed_body(limit, include_external=True, rotate=rotate)
        now = time.time()
        with _DISCOVERY_FEED_LOCK:
            previous = _DISCOVERY_FEED_CACHE.get(cache_key)
            if body.get("browse_error") and previous:
                current_sections = {s["id"]: s for s in body.get("browse_sections", [])}
                for section in previous[2].get("browse_sections", []):
                    current_sections.setdefault(section["id"], section)
                body["browse_sections"] = [
                    current_sections[key]
                    for key in ("new_releases", "artists", "albums")
                    if key in current_sections
                ]
            dirty = not _followup and cache_key in _DISCOVERY_FEED_DIRTY
            expires_at = 0 if dirty else now + (5 if body.get("browse_error") else _DISCOVERY_FEED_TTL_SEC)
            _DISCOVERY_FEED_CACHE[cache_key] = (
                expires_at,
                now + _DISCOVERY_FEED_STALE_SEC,
                dict(body),
            )
        payload = {
            "limit": limit,
            "generated_at": body.get("generated_at"),
            "browse_error": bool(body.get("browse_error")),
        }
    except Exception as exc:
        logger.warning("Discovery feed refresh failed: %s", exc)
        payload = {"limit": limit, "error": True}
    finally:
        with _DISCOVERY_FEED_LOCK:
            if not _followup and cache_key in _DISCOVERY_FEED_DIRTY:
                _DISCOVERY_FEED_DIRTY.discard(cache_key)
                rerun = True
            else:
                _DISCOVERY_FEED_INFLIGHT.discard(cache_key)
                _DISCOVERY_FEED_DIRTY.discard(cache_key)
        emit = _get_api().get("emit_to_user")
        if callable(emit):
            try:
                emit("discovery_feed_ready", payload, user_id=user_id)
            except Exception as exc:
                logger.debug("Discovery feed ready emit failed: %s", exc)
        if rerun:
            try:
                _DISCOVERY_FEED_EXECUTOR.submit(
                    _refresh_discovery_feed_cache,
                    cache_key,
                    user_id,
                    limit,
                    rotate=False,
                    _followup=True,
                )
            except Exception as exc:
                with _DISCOVERY_FEED_LOCK:
                    _DISCOVERY_FEED_INFLIGHT.discard(cache_key)
                logger.warning("Discovery feed followup submit failed: %s", exc)


def _schedule_discovery_feed_refresh(
    cache_key: str,
    user_id: str | None,
    limit: int,
    *,
    rotate: bool = False,
) -> bool:
    with _DISCOVERY_FEED_LOCK:
        if cache_key in _DISCOVERY_FEED_INFLIGHT:
            _DISCOVERY_FEED_DIRTY.add(cache_key)
            return False
        _DISCOVERY_FEED_INFLIGHT.add(cache_key)
        _DISCOVERY_FEED_DIRTY.discard(cache_key)
    try:
        _DISCOVERY_FEED_EXECUTOR.submit(_refresh_discovery_feed_cache, cache_key, user_id, limit, rotate=rotate)
    except Exception:
        with _DISCOVERY_FEED_LOCK:
            _DISCOVERY_FEED_INFLIGHT.discard(cache_key)
        raise
    return True


def notify_discovery_signal(user_id: str | None = None, *, always_refresh: bool = False) -> bool:
    """Invalidate cached Discover feeds for ``user_id`` and wake cold (or forced) ones."""
    from shared.user_context import current_user_id

    uid = user_id if user_id is not None else current_user_id()
    scheduled = False
    for cache_key, feed_limit, was_cold in _invalidate_personalized_cache_for_user_detailed(uid):
        if not (always_refresh or was_cold):
            continue
        try:
            if _schedule_discovery_feed_refresh(cache_key, uid, feed_limit, rotate=False):
                scheduled = True
        except Exception as exc:
            logger.debug("Discovery signal refresh failed for %s: %s", cache_key, exc)
    return scheduled


def _dispatch_discovery_signal(
    user_id: str | None = None,
    *,
    always_refresh: bool = False,
) -> bool:
    return notify_discovery_signal(user_id, always_refresh=always_refresh)


register_discovery_signal_handler(_dispatch_discovery_signal)


@discovery_bp.route("/api/discovery/music/feed", methods=["GET"])
@rate_limit("discovery_music_feed", limit=120, window_sec=60)
def discovery_music_feed():
    """Ranked zero-query discovery with stale-while-revalidate delivery."""
    from shared.user_context import current_user_id

    limit = min(16, max(4, request.args.get("limit", type=int) or 10))
    user_id = current_user_id()
    cache_key = f"discovery-feed-v4:{user_id or '-'}:{limit}"
    now = time.time()
    refresh_requested = request.args.get("refresh") == "1"
    with _DISCOVERY_FEED_LOCK:
        cached = _DISCOVERY_FEED_CACHE.get(cache_key)
        refreshing = cache_key in _DISCOVERY_FEED_INFLIGHT
    if cached and cached[0] > now and not refresh_requested:
        body = dict(cached[2])
        body.update({"cached": True, "stale": False, "revalidating": refreshing})
        return jsonify(body)
    if cached and (cached[1] > now or refresh_requested):
        revalidating = _schedule_discovery_feed_refresh(
            cache_key,
            user_id,
            limit,
            rotate=True,
        ) or refreshing
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
    revalidating = _schedule_discovery_feed_refresh(
        cache_key,
        user_id,
        limit,
        rotate=refresh_requested,
    ) or refreshing
    body.update({"cached": False, "stale": False, "revalidating": revalidating})
    return jsonify(body)
