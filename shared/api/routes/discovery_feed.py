"""The music discovery feed.

Built from the listening rollup plus Deezer enrichment, and served
stale-while-revalidate: a cold request answers from local recommendations
without waiting on Deezer, and the enriched version replaces it in the
background.
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
    build_music_recommendations,
    compose_discovery_feed,
    load_listening_event_rollups,
    load_discovery_settings,
    rank_recommendation_rows,
)
from shared.hardening import rate_limit
from shared.music_identity import youtube_music_metadata
from shared.providers import deezer
from shared.text_utils import fold_text, identity_key

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
    cover = deezer.image(album_row, "cover") or str(row.get("cover") or "")
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


def _top_taste_artists(metadata, fav_ids: list[str], limit: int = _MAX_PERSONALIZED_SEEDS) -> list[str]:
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
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
) -> None:
    deadline = time.monotonic() + 12.0
    used_related_artists: set[str] = set()
    added = 0
    for artist in _top_taste_artists(metadata, fav_ids):
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
    # Newest first: a seed is a guess at what the listener is into now, and the
    # songs they added most recently are the best one the library holds. Ordered
    # by the day each joined rather than by manifest position, which a rescan or
    # a re-keyed id can move.
    newest_first = sorted(tracks, key=lambda track: track.added_at or "", reverse=True)
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
        for track in newest_first:
            if str(track.artist or track.album_artist or "").strip().casefold() == artist:
                add_seed(track)
                break
    for track in newest_first:
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


def _build_discovery_feed_body(limit: int, *, include_external: bool = True) -> dict:
    api = _get_api()
    lib = api["get_library"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    fav_ids = api["favourite_library_ids"]()
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
    body = compose_discovery_feed(
        feed,
        rollup=load_listening_event_rollups(),
        max_sections=6,
        section_size=limit,
    )

    if include_external:
        from shared.discovery_browse import build_browse_sections

        body.update(build_browse_sections(_top_taste_artists(metadata, fav_ids), min(limit, 10)))
    return body


def _refresh_discovery_feed_cache(cache_key: str, user_id: str | None, limit: int) -> None:
    try:
        from shared.user_context import user_context

        with user_context(user_id):
            body = _build_discovery_feed_body(limit, include_external=True)
        now = time.time()
        with _DISCOVERY_FEED_LOCK:
            previous = _DISCOVERY_FEED_CACHE.get(cache_key)
            if body.get("browse_error") and previous:
                current_sections = {s["id"]: s for s in body.get("browse_sections", [])}
                for section in previous[2].get("browse_sections", []):
                    current_sections.setdefault(section["id"], section)
                body["browse_sections"] = [current_sections[key] for key in ("artists", "albums") if key in current_sections]
            _DISCOVERY_FEED_CACHE[cache_key] = (
                now + (5 if body.get("browse_error") else _DISCOVERY_FEED_TTL_SEC),
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
        refreshing = cache_key in _DISCOVERY_FEED_INFLIGHT
    if cached and cached[0] > now and request.args.get("refresh") != "1":
        body = dict(cached[2])
        body.update({"cached": True, "stale": False, "revalidating": refreshing})
        return jsonify(body)
    if cached and cached[1] > now:
        revalidating = _schedule_discovery_feed_refresh(cache_key, user_id, limit) or refreshing
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
    revalidating = _schedule_discovery_feed_refresh(cache_key, user_id, limit) or refreshing
    body.update({"cached": False, "stale": False, "revalidating": revalidating})
    return jsonify(body)
