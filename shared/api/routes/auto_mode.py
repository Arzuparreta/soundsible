"""Auto Mode: what to play next, and how to get there.

Two halves that share a candidate pool. The planner turns a seed into a ranked
queue drawn from the local library, the related-video graph and discovery; the
DJ engine orders those candidates by how well they mix and describes the
transition between each pair.
"""

from __future__ import annotations

import hashlib
import logging
import random
import re
import time
import uuid
from concurrent.futures import wait

from flask import jsonify, request

from shared import request_scope
from shared.database import instance_db
from shared.discovery_intelligence import (
    build_music_recommendations,
    rank_recommendation_rows,
)
from shared.dj_engine import (
    DJ_PROFILES,
    analyse_audio,
    analysis_identity,
    cached_analysis,
    order_route,
    plan_transition,
    request_analysis,
    route_to_request,
)
from shared.hardening import rate_limit
from shared.listening_planner import (
    AUTO_PROFILES,
    LISTENING_INTENTS,
    auto_source_sequence,
    plan_generated_queue,
)
from shared.music_identity import canonical_music_identity
from shared.path_resolver import resolve_local_track_path
from shared.url_utils import validate_youtube_video_id

from .discovery_bp import discovery_bp
from .discovery_common import (
    _AUTO_CONTEXT_MAX,
    _AUTO_GRAPH_ANCHORS,
    _AUTO_GRAPH_FETCH_MISSES,
    _AUTO_RAW_LIMIT,
    _AUTO_ROUTER_LIMIT,
    _AUTO_SHORTLIST_LIMIT,
    _CANONICAL_RESOLVE_BUDGET_SEC,
    _PLAN_RESOLVE_EXECUTOR,
    _get_api,
)
from .discovery_feed import _build_discovery_feed_body, _deezer_artist_top_rows
from .discovery_graph import _resolve_seed_yt_id

logger = logging.getLogger(__name__)

def _planner_track_index(metadata) -> dict:
    """`{track_id: track}` for this library, built once per request.

    `dj-plan` looks a track up once per candidate, once per request target and
    once per accepted route item — up to ~40 times. Each lookup used to copy the
    whole track list and scan it, so the handler was O(candidates x library).
    """
    tracks = getattr(metadata, "tracks", None) or []
    if not tracks:
        return {}
    return request_scope.scoped(
        f"planner_track_index:{id(metadata)}:{len(tracks)}",
        lambda: {str(getattr(track, "id", "")): track for track in tracks},
    )


def _planner_track_by_id(metadata, track_id: str):
    if not track_id:
        return None
    return _planner_track_index(metadata).get(str(track_id))


def _planner_item_from_related(row: dict) -> dict | None:
    video_id = str(row.get("video_id") or row.get("id") or "").strip()
    if not validate_youtube_video_id(video_id):
        return None
    title = str(row.get("title") or "Unknown")
    channel = str(row.get("channel") or row.get("uploader") or row.get("artist") or "")
    identity = canonical_music_identity("", title, channel=channel)
    return {
        "id": video_id,
        "youtube_id": video_id,
        "discovery_youtube_id": video_id,
        "title": identity.title,
        "artist": identity.artist,
        "source_title": title,
        "source_artist": channel,
        "playback_source_kind": identity.source_kind,
        "canonical_identity": identity.key,
        "duration": int(row.get("duration") or 0),
        "cover": str(row.get("thumbnail") or ""),
        "source": "preview",
        "source_pool": "related",
        "reason": row.get("reason"),
        "reason_code": row.get("reason_code") or "seed_related",
        "recommendation_identity": row.get("recommendation_identity") or f"music:youtube:{video_id}",
        "score": float(row.get("score") or 0.5),
        "external_ids": {"youtube_id": video_id},
    }


def _planner_item_from_feed(item: dict, *, pool: str) -> dict | None:
    external = item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}
    video_id = str(external.get("youtube_id") or item.get("youtube_id") or "").strip()
    track_id = str(item.get("track_id") or "").strip()
    if not track_id and not validate_youtube_video_id(video_id):
        return None
    item_id = track_id or video_id
    title = str(item.get("title") or "Unknown")
    artist = str(item.get("artist") or "")
    source_title = str(item.get("source_title") or title)
    source_artist = str(item.get("source_artist") or artist)
    identity = canonical_music_identity(artist, source_title, channel=source_artist)
    return {
        "id": item_id,
        "track_id": track_id or None,
        "youtube_id": video_id or None,
        "title": identity.title,
        "artist": identity.artist,
        "source_title": source_title,
        "source_artist": source_artist,
        "playback_source_kind": identity.source_kind,
        "canonical_identity": identity.key,
        "album": str(item.get("album") or ""),
        "duration": int(item.get("duration") or 0),
        "cover": str(item.get("cover") or ""),
        "source": "library" if track_id else "preview",
        "source_pool": pool,
        "reason": item.get("reason"),
        "reason_code": item.get("reason_code"),
        "recommendation_identity": item.get("recommendation_identity")
        or (f"music:track:{track_id}" if track_id else f"music:youtube:{video_id}"),
        "score": float(item.get("score") or 0.5),
        "external_ids": {**external, **({"youtube_id": video_id} if video_id else {})},
    }


def _planner_artist_key(value: object) -> str:
    artist = re.sub(
        r"(?:\s*[-–—]\s*)?(?:topic|official(?:\s+music)?|vevo)$",
        "",
        str(value or "").strip(),
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", artist).strip(" -–—").casefold()


def _planner_video_id(metadata, item: dict) -> str:
    video_id = str(
        item.get("discovery_youtube_id")
        or item.get("youtube_id")
        or (
            (item.get("external_ids") or {}).get("youtube_id")
            if isinstance(item.get("external_ids"), dict)
            else ""
        )
        or (item.get("id") if item.get("source") == "preview" else "")
        or ""
    ).strip()
    if validate_youtube_video_id(video_id):
        return video_id
    track_id = str(item.get("track_id") or (item.get("id") if item.get("source") != "preview" else "") or "")
    track = _planner_track_by_id(metadata, track_id) if track_id else None
    candidate = str(getattr(track, "youtube_id", "") or "")
    return candidate if validate_youtube_video_id(candidate) else ""


def _resolve_generated_playback(item: dict, user_id: str | None) -> dict:
    """Prefer a canonical upload while retaining the discovery graph identity."""
    from shared.api.routes.catalog import _resolve_candidates
    from shared.resolution_confidence import CONFIDENCE_HIGH
    from shared.user_context import user_context

    current = canonical_music_identity(
        item.get("artist"),
        item.get("source_title") or item.get("title"),
        channel=item.get("source_artist") or item.get("artist"),
    )
    with user_context(user_id):
        best, candidates = _resolve_candidates(
            current.artist,
            current.title,
            int(item.get("duration") or 0) or None,
        )
    if not best or float(best.get("confidence") or 0) < CONFIDENCE_HIGH:
        return item
    best_title = str(best.get("title") or current.title)
    best_channel = str(best.get("channel") or best.get("uploader") or "")
    resolved = canonical_music_identity(current.artist, best_title, channel=best_channel)
    if resolved.version_tokens != current.version_tokens or resolved.source_rank <= current.source_rank:
        return item
    video_id = str(best.get("id") or "")
    if not validate_youtube_video_id(video_id):
        return item
    discovery_id = str(item.get("discovery_youtube_id") or item.get("youtube_id") or item.get("id") or "")
    return {
        **item,
        "id": video_id,
        "youtube_id": video_id,
        "discovery_youtube_id": discovery_id,
        "title": resolved.title,
        "artist": resolved.artist,
        "source_title": best_title,
        "source_artist": best_channel,
        "playback_source_kind": resolved.source_kind,
        "canonical_identity": resolved.key,
        "external_ids": {
            **(item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}),
            "youtube_id": video_id,
            "discovery_youtube_id": discovery_id,
        },
        # Feedback and generated-lane exclusions stay attached to the graph node
        # that discovered the song, not to whichever upload happened to play it.
        "recommendation_identity": item.get("recommendation_identity"),
        "resolution_candidates": len(candidates),
    }


def _canonicalize_generated_items(items: list[dict], user_id: str | None) -> list[dict]:
    """Bounded best-effort playback-source upgrade for an already chosen plan.

    Song selection is finished before this runs. A failed/slow lookup therefore
    cannot remove discovery: it simply leaves the original video in place while
    the single-flight resolver warms its cache for a later plan.
    """
    futures = {}
    submitted = 0
    for index, item in enumerate(items):
        if item.get("source") != "preview":
            continue
        identity = canonical_music_identity(
            item.get("artist"),
            item.get("source_title") or item.get("title"),
            channel=item.get("source_artist") or item.get("artist"),
        )
        if identity.source_kind in {"official_audio", "artist_audio"}:
            continue
        if submitted >= 3:
            break
        future = _PLAN_RESOLVE_EXECUTOR.submit(_resolve_generated_playback, dict(item), user_id)
        futures[future] = index
        submitted += 1
    if not futures:
        return items
    done, _ = wait(futures, timeout=_CANONICAL_RESOLVE_BUDGET_SEC)
    resolved = list(items)
    for future in done:
        try:
            resolved[futures[future]] = future.result()
        except Exception as exc:
            logger.debug("Generated playback source resolve failed: %s", exc)
    return resolved


def _planner_context(seed: dict, raw_context: object) -> list[dict]:
    rows = [
        dict(item)
        for item in (raw_context if isinstance(raw_context, list) else [])
        if isinstance(item, dict)
    ][-_AUTO_CONTEXT_MAX:]
    rows.append(dict(seed))
    deduped: list[dict] = []
    seen: set[str] = set()
    for item in rows:
        identity = str(
            item.get("youtube_id")
            or item.get("track_id")
            or item.get("id")
            or f"{item.get('artist', '')}:{item.get('title', '')}"
        ).strip()
        if not identity or identity in seen:
            continue
        seen.add(identity)
        deduped.append(item)
    return deduped[-_AUTO_CONTEXT_MAX:]


def _planner_uncached_related(video_id: str) -> list[dict]:
    api = _get_api()
    rows = api["get_downloader"](open_browser=False).downloader.get_related_videos(
        video_id,
        max_results=25,
        enrich=False,
    )
    instance_db().set_related_mix(video_id, rows)
    return rows


def _planner_context_related(
    metadata,
    context: list[dict],
    *,
    personalise: bool = True,
) -> tuple[list[dict], bool]:
    """Collect a bounded semantic neighbourhood around the route that survives."""
    anchors: list[tuple[str, float]] = []
    for index, item in enumerate(context[-_AUTO_GRAPH_ANCHORS:]):
        video_id = _planner_video_id(metadata, item)
        if not video_id:
            continue
        recency = 0.64 + 0.36 * ((index + 1) / min(len(context), _AUTO_GRAPH_ANCHORS))
        if all(existing != video_id for existing, _ in anchors):
            anchors.append((video_id, recency))

    mixes: dict[str, list[dict]] = {}
    misses: list[str] = []
    cached_mixes = instance_db().get_related_mixes(video_id for video_id, _ in anchors)
    for video_id, _ in anchors:
        cached = cached_mixes.get(video_id)
        if cached is None:
            misses.append(video_id)
        else:
            mixes[video_id] = cached

    futures = {
        _PLAN_RESOLVE_EXECUTOR.submit(_planner_uncached_related, video_id): video_id
        for video_id in misses[:_AUTO_GRAPH_FETCH_MISSES]
    }
    if futures:
        done, pending = wait(futures, timeout=8)
        for future in pending:
            future.cancel()
        for future in done:
            try:
                mixes[futures[future]] = future.result()
            except Exception as exc:
                logger.info("Auto context graph unavailable for %s: %s", futures[future], exc)

    candidates: dict[str, dict] = {}
    for video_id, recency in anchors:
        rows = mixes.get(video_id) or []
        ranked_rows = rank_recommendation_rows(rows, source="auto_mode") if personalise else rows
        for rank, raw in enumerate(ranked_rows[:25]):
            item = _planner_item_from_related(raw)
            if not item:
                continue
            semantic = max(0.18, recency * (1 - min(rank, 24) / 36))
            identity = str(item["recommendation_identity"])
            previous = candidates.get(identity)
            if previous and float(previous.get("semantic_score") or 0) >= semantic:
                continue
            item.update({
                "semantic_score": round(semantic, 6),
                "semantic_basis": "related_track",
                "score": round(
                    max(0.0001, float(item.get("score") or 0.5) * (0.7 + semantic * 0.3)),
                    6,
                ),
            })
            candidates[identity] = item
            if len(candidates) >= _AUTO_RAW_LIMIT:
                break
        if len(candidates) >= _AUTO_RAW_LIMIT:
            break
    return list(candidates.values()), bool(misses and not mixes)


def _planner_related_artist_pool(
    seed_artist: str,
    user_id: str | None,
    limit: int = 6,
) -> tuple[list[str], list[dict]]:
    """Return related artist names plus one playable representative per artist."""
    if not seed_artist:
        return [], []
    try:
        from shared.api.routes.catalog import (
            _deezer_artist_top_tracks,
            _deezer_related_artists,
            _resolve_artist_id,
        )

        artist_id, _ = _resolve_artist_id(seed_artist)
        if not artist_id:
            return [], []
        related_rows = _deezer_related_artists(artist_id, max(6, limit))[:limit]
    except Exception as exc:
        logger.info("Auto related artists unavailable for %s: %s", seed_artist, exc)
        return [], []

    names = [str(row.get("name") or "").strip() for row in related_rows if str(row.get("name") or "").strip()]
    futures = {
        _PLAN_RESOLVE_EXECUTOR.submit(_deezer_artist_top_tracks, str(row["deezer_id"]), 1): index
        for index, row in enumerate(related_rows)
        if row.get("deezer_id")
    }
    done, pending = wait(futures, timeout=5)
    for future in pending:
        future.cancel()
    seeds: list[tuple[int, dict]] = []
    for future in done:
        try:
            top = future.result()
        except Exception:
            top = []
        if not top:
            continue
        item = dict(top[0])
        item.update({
            "score": 0.62,
            "semantic_score": 0.62,
            "semantic_basis": "related_artist",
            "reason": f"Related to {seed_artist}.",
            "reason_code": "related_artist",
        })
        seeds.append((futures[future], item))
    seeds.sort(key=lambda pair: pair[0])

    resolution_futures = {
        _PLAN_RESOLVE_EXECUTOR.submit(_planner_resolve_artist_candidate, item, user_id): index
        for index, item in seeds
    }
    done, pending = wait(resolution_futures, timeout=8)
    for future in pending:
        future.cancel()
    resolved: list[tuple[int, dict]] = []
    for future in done:
        try:
            item = future.result()
        except Exception:
            item = None
        if item:
            item["source_pool"] = "discovery"
            item["semantic_score"] = 0.62
            item["semantic_basis"] = "related_artist"
            resolved.append((resolution_futures[future], item))
    resolved.sort(key=lambda pair: pair[0])
    return names, [item for _, item in resolved[:limit]]


def _planner_local_item(track, *, semantic_score: float, basis: str, favourite: bool) -> dict:
    video_id = str(getattr(track, "youtube_id", "") or "")
    score = min(1.0, semantic_score * 0.82 + (0.16 if favourite else 0.06))
    return {
        "id": str(track.id),
        "track_id": str(track.id),
        "youtube_id": video_id or None,
        "title": str(track.title or "Unknown"),
        "artist": str(track.artist or track.album_artist or ""),
        "album": str(track.album or ""),
        "duration": int(track.duration or 0),
        "cover": str(getattr(track, "cover_art_key", "") or ""),
        "source": "library",
        "source_pool": "local",
        "reason": "From your library and inside this session's musical path.",
        "reason_code": "session_library",
        "recommendation_identity": f"music:track:{track.id}",
        "score": round(score, 6),
        "semantic_score": round(semantic_score, 6),
        "semantic_basis": basis,
        "personal_score": 1.0 if favourite else 0.55,
        "external_ids": {"youtube_id": video_id} if video_id else {},
    }


def _build_auto_pools(
    metadata,
    context: list[dict],
    *,
    favourite_ids: set[str],
    user_id: str | None,
) -> tuple[dict[str, list[dict]], bool]:
    related, graph_degraded = _planner_context_related(metadata, context)
    seed_artist = str(context[-1].get("artist") or "") if context else ""
    related_artists, discovery = _planner_related_artist_pool(seed_artist, user_id)
    related_artist_keys = {_planner_artist_key(name) for name in related_artists}
    context_artist_keys = {
        _planner_artist_key(item.get("artist"))
        for item in context
        if _planner_artist_key(item.get("artist"))
    }
    semantic_by_video = {
        str(item.get("youtube_id") or ""): float(item.get("semantic_score") or 0)
        for item in related
        if item.get("youtube_id")
    }

    local: list[dict] = []
    for track in list(metadata.tracks if metadata and metadata.tracks else []):
        artist_key = _planner_artist_key(track.artist or track.album_artist)
        video_id = str(getattr(track, "youtube_id", "") or "")
        if video_id and video_id in semantic_by_video:
            semantic = semantic_by_video[video_id]
            basis = "related_track"
        elif artist_key and artist_key in context_artist_keys:
            semantic = 0.76
            basis = "same_artist"
        elif artist_key and artist_key in related_artist_keys:
            semantic = 0.62
            basis = "related_artist"
        else:
            continue
        local.append(_planner_local_item(
            track,
            semantic_score=semantic,
            basis=basis,
            favourite=str(track.id) in favourite_ids,
        ))

    local.sort(
        key=lambda item: (
            float(item.get("semantic_score") or 0),
            float(item.get("personal_score") or 0),
            float(item.get("score") or 0),
        ),
        reverse=True,
    )
    owned_video_ids = {
        str(item.get("youtube_id") or "")
        for item in local
        if item.get("youtube_id")
    }
    related = [
        item for item in related
        if str(item.get("youtube_id") or "") not in owned_video_ids
    ]
    discovery = [
        item for item in discovery
        if str(item.get("youtube_id") or "") not in owned_video_ids
    ]
    related.sort(key=lambda item: float(item.get("semantic_score") or 0), reverse=True)
    discovery.sort(key=lambda item: float(item.get("semantic_score") or 0), reverse=True)
    return {
        "local": local[:_AUTO_SHORTLIST_LIMIT],
        "related": related[:_AUTO_SHORTLIST_LIMIT],
        "discovery": discovery[:_AUTO_SHORTLIST_LIMIT],
    }, graph_degraded


def _planner_resolve_artist_candidate(item: dict, user_id: str | None) -> dict | None:
    from shared.api.routes.catalog import _resolve_candidates
    from shared.user_context import user_context

    with user_context(user_id):
        best, _ = _resolve_candidates(
            str(item.get("artist") or ""),
            str(item.get("title") or ""),
            int(item.get("duration") or 0) or None,
        )
    video_id = str(best.get("id") or "").strip()
    if not validate_youtube_video_id(video_id):
        return None
    resolved = dict(item)
    resolved["external_ids"] = {
        **(item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}),
        "youtube_id": video_id,
    }
    resolved["youtube_id"] = video_id
    resolved["id"] = video_id
    resolved["source"] = "preview"
    resolved["source_title"] = str(best.get("title") or item.get("title") or "")
    resolved["source_artist"] = str(best.get("channel") or best.get("uploader") or "")
    resolved["recommendation_identity"] = f"music:youtube:{video_id}"
    return _planner_item_from_feed(resolved, pool="related")


def _planner_artist_candidates(seed_artist: str, user_id: str | None, limit: int) -> list[dict]:
    if not seed_artist:
        return []
    try:
        rows = _deezer_artist_top_rows(seed_artist, max(8, limit * 2))
    except Exception as exc:
        logger.info("Listening plan artist pool unavailable for %s: %s", seed_artist, exc)
        return []
    seeds: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
        album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
        title = str(row.get("title_short") or row.get("title") or "").strip()
        artist = str(artist_row.get("name") or seed_artist).strip()
        if not title or not artist:
            continue
        seeds.append({
            "id": f"deezer:{row.get('id')}",
            "title": title,
            "artist": artist,
            "album": str(album_row.get("title") or ""),
            "duration": int(row.get("duration") or 0),
            "cover": str(album_row.get("cover_medium") or album_row.get("cover") or ""),
            "score": max(0.1, float(row.get("rank") or 0) / 1_000_000),
            "reason": f"More from {seed_artist}.",
            "reason_code": "seed_artist",
            "external_ids": {"deezer_id": str(row.get("id") or "")},
        })
        if len(seeds) >= max(4, limit):
            break
    futures = {
        _PLAN_RESOLVE_EXECUTOR.submit(_planner_resolve_artist_candidate, item, user_id): index
        for index, item in enumerate(seeds)
    }
    done, pending = wait(futures, timeout=8)
    for future in pending:
        future.cancel()
    resolved: list[tuple[int, dict]] = []
    for future in done:
        try:
            item = future.result()
        except Exception:
            item = None
        if item:
            resolved.append((futures[future], item))
    resolved.sort(key=lambda pair: pair[0])
    return [item for _, item in resolved[:limit]]


def _build_music_plan(data: dict) -> tuple[dict, int]:
    """Build one generated queue payload without binding it to a Flask route."""
    from shared.user_context import current_user_id

    intent = str(data.get("intent") or "").strip()
    profile = str(data.get("profile") or "balanced").strip()
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    exclude = data.get("exclude") if isinstance(data.get("exclude"), list) else []
    if intent not in LISTENING_INTENTS:
        return {"error": "intent must be autoplay, radio, or auto_mode"}, 400
    if profile not in AUTO_PROFILES:
        return {"error": "profile must be familiar, balanced, or explore"}, 400
    if not seed:
        return {"error": "seed is required"}, 400
    try:
        limit = min(24, max(1, int(data.get("limit") or 8)))
    except (TypeError, ValueError):
        return {"error": "limit must be an integer"}, 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    track_id = str(seed.get("track_id") or "").strip()
    library_seed = _planner_track_by_id(metadata, track_id) if track_id else None
    if library_seed and getattr(library_seed, "media_kind", None) == "podcast_episode":
        return {"error": "music plans do not accept podcast seeds"}, 400
    seed_title = str(seed.get("title") or getattr(library_seed, "title", "") or "").strip()
    seed_artist = str(seed.get("artist") or getattr(library_seed, "artist", "") or "").strip()
    seed_youtube_id = str(
        seed.get("discovery_youtube_id")
        or seed.get("youtube_id")
        or getattr(library_seed, "youtube_id", "")
        or (seed.get("id") if seed.get("source") == "preview" else "")
        or ""
    ).strip()
    if not validate_youtube_video_id(seed_youtube_id) and library_seed:
        seed_youtube_id = _resolve_seed_yt_id(library_seed)
    if not validate_youtube_video_id(seed_youtube_id) and seed_title and seed_artist:
        try:
            from shared.api.routes.catalog import _resolve_candidates

            best, _ = _resolve_candidates(seed_artist, seed_title, int(seed.get("duration") or 0) or None)
            seed_youtube_id = str(best.get("id") or "")
        except Exception:
            seed_youtube_id = ""
    if (
        not library_seed
        and not validate_youtube_video_id(seed_youtube_id)
        and not (seed_title and seed_artist)
    ):
        return {"error": "seed needs a track id, video id, or title and artist"}, 400

    fav_ids = api["_mod"].favourite_library_ids()
    if intent == "auto_mode":
        session_id = str(data.get("session_id") or "").strip()[:80]
        try:
            segment_index = max(0, int(data.get("segment_index") or 0))
        except (TypeError, ValueError):
            return {"error": "segment_index must be a non-negative integer"}, 400
        context_seed = {
            **seed,
            "track_id": track_id or None,
            "youtube_id": seed_youtube_id or None,
            "discovery_youtube_id": str(seed.get("discovery_youtube_id") or "") or None,
            "source": "library" if library_seed else "preview",
            "title": seed_title,
            "artist": seed_artist,
        }
        context = _planner_context(context_seed, data.get("context"))
        pools, graph_degraded = _build_auto_pools(
            metadata,
            context,
            favourite_ids={str(value) for value in fav_ids},
            user_id=current_user_id(),
        )
        entropy = f"{session_id}:{segment_index}" if session_id else str(uuid.uuid4())
        source_sequence = auto_source_sequence(profile, entropy=entropy)
        items = plan_generated_queue(
            pools,
            intent=intent,
            profile=profile,
            limit=limit,
            exclude=[str(value) for value in exclude[:200] if str(value).strip()],
            entropy=entropy,
            context_artists=[
                str(item.get("artist") or "")
                for item in context
                if str(item.get("artist") or "").strip()
            ],
        )
        items = _canonicalize_generated_items(items, current_user_id())
        return {
            "v": 1,
            "plan_id": str(uuid.uuid4()),
            "intent": intent,
            "profile": profile,
            "seed_identity": seed_youtube_id or track_id or f"{seed_artist}:{seed_title}",
            "session_id": session_id or None,
            "segment_index": segment_index,
            "source_sequence": list(source_sequence),
            "items": items,
            "degraded": len(items) < limit or graph_degraded,
            "pool_counts": {pool: len(pools[pool]) for pool in ("local", "related", "discovery")},
            "generated_at": int(time.time()),
        }, 200

    local: list[dict] = []
    local_error = False
    try:
        local_response = build_music_recommendations(metadata, fav_ids, limit=max(24, limit * 3))
        for item in local_response.get("items") or []:
            candidate = _planner_item_from_feed(item, pool="local")
            if not candidate:
                continue
            local_track = _planner_track_by_id(metadata, str(candidate.get("track_id") or ""))
            if local_track and getattr(local_track, "media_kind", None) == "podcast_episode":
                continue
            local.append(candidate)
    except Exception as exc:
        local_error = True
        logger.info("Listening plan local pool unavailable: %s", exc)

    related: list[dict] = []
    related_error = False
    if validate_youtube_video_id(seed_youtube_id):
        try:
            raw_related = instance_db().get_related_mix(seed_youtube_id)
            if raw_related is None:
                dl = api["get_downloader"](open_browser=False)
                raw_related = dl.downloader.get_related_videos(
                    seed_youtube_id,
                    max_results=max(25, limit * 3),
                    enrich=False,
                )
                instance_db().set_related_mix(seed_youtube_id, raw_related)
            source = intent if intent in {"radio", "auto_mode"} else "autoplay"
            related = [
                candidate
                for row in rank_recommendation_rows(raw_related, source=source)
                if (candidate := _planner_item_from_related(row))
            ]
        except Exception as exc:
            related_error = True
            logger.info("Listening plan related pool unavailable for %s: %s", seed_youtube_id, exc)

    discovery: list[dict] = []
    discovery_error = False
    try:
        feed = _build_discovery_feed_body(max(8, limit), include_external=False)
        discovery = [
            candidate
            for item in feed.get("items") or []
            if (candidate := _planner_item_from_feed(item, pool="discovery"))
            and not candidate.get("track_id")
        ]
    except Exception as exc:
        discovery_error = True
        logger.info("Listening plan discovery pool unavailable: %s", exc)
    items = plan_generated_queue(
        {"local": local, "related": related, "discovery": discovery},
        intent=intent,
        profile=profile,
        limit=limit,
        exclude=[str(value) for value in exclude[:200] if str(value).strip()],
    )
    items = _canonicalize_generated_items(items, current_user_id())
    return {
        "v": 1,
        "plan_id": str(uuid.uuid4()),
        "intent": intent,
        "profile": profile,
        "seed_identity": seed_youtube_id or track_id or f"{seed_artist}:{seed_title}",
        "items": items,
        "degraded": len(items) < limit or local_error or related_error or discovery_error,
        "pool_counts": {
            "local": len(local),
            "related": len(related),
            "discovery": len(discovery),
        },
        "generated_at": int(time.time()),
    }, 200


@discovery_bp.route("/api/discovery/music/plan", methods=["POST"])
@rate_limit("discovery_music_plan", limit=60, window_sec=60)
def discovery_music_plan():
    """Build the final generated queue order for every music continuation."""
    payload, status = _build_music_plan(request.get_json(silent=True) or {})
    return jsonify(payload), status


def _dj_source_path(metadata, item: dict) -> str | None:
    """Where this item's audio already lives locally, if anywhere.

    Candidate evaluation is read-only. Prefetching every preview considered by
    the router made a wider crate expensive and gave already cached songs a
    circular advantage. The browser prefetches only the accepted runway.
    """
    track_id = str(item.get("track_id") or "").strip()
    video_id = str(item.get("youtube_id") or (item.get("id") if item.get("source") == "preview" else "") or "").strip()
    if track_id:
        track = _planner_track_by_id(metadata, track_id)
        return resolve_local_track_path(track) if track else None
    if not validate_youtube_video_id(video_id):
        return None
    from shared import preview_cache

    cached = preview_cache.get_cached(video_id)
    if cached:
        return str(cached[0])
    return None


def _dj_item_analysis(metadata, item: dict, *, schedule: bool = False) -> dict:
    """Features for one route item, without ever blocking on FFmpeg.

    Planning is on the interaction path: a listener nudging the energy control
    must not wait on a decode. Whatever has already been measured is used, the
    rest is queued, and the route is built from a conservative fallback that the
    player is required to treat as such. The refinement endpoint picks up the
    real numbers once they land, before the transition is ever committed.
    """
    duration_hint = float(item.get("duration") or 0)
    identity = analysis_identity(item)
    path = _dj_source_path(metadata, item)
    if not path:
        return _dj_fallback_analysis(duration_hint)
    cached = cached_analysis(path, identity)
    if cached is not None:
        return cached
    if schedule:
        request_analysis(path, identity, duration_hint=duration_hint)
    return _dj_fallback_analysis(duration_hint)


def _dj_fallback_analysis(duration_hint: float) -> dict:
    return analyse_audio("", "", duration_hint=duration_hint)


def _normalise_dj_request(raw: dict) -> dict | None:
    if str(raw.get("kind") or "").strip() == "artist":
        artist_row = raw.get("artist") if isinstance(raw.get("artist"), dict) else {}
        artist_name = str(artist_row.get("name") or raw.get("label") or "").strip()
        if not artist_name:
            return None
        return {
            "kind": "artist",
            "artist_name": artist_name,
            "label": artist_name,
            "request_id": str(raw.get("id") or uuid.uuid4()),
        }
    track = raw.get("track") if isinstance(raw.get("track"), dict) else raw
    is_preview = str(track.get("source") or "") == "preview"
    video_id = str(track.get("youtube_id") or (track.get("id") if is_preview else "") or "").strip()
    track_id = str(track.get("track_id") or (track.get("id") if not is_preview else "") or "").strip()
    title = str(track.get("title") or "").strip()
    artist = str(track.get("artist") or track.get("channel") or "").strip()
    if not title or not artist or (not track_id and not validate_youtube_video_id(video_id)):
        return None
    is_preview = not track_id
    return {
        "kind": "track",
        "label": title,
        "id": video_id if is_preview else track_id,
        "track_id": track_id or None,
        "youtube_id": video_id if is_preview else track.get("youtube_id"),
        "title": title,
        "artist": artist,
        "album": str(track.get("album") or ""),
        "duration": int(track.get("duration") or 0),
        "cover": str(track.get("cover") or track.get("thumbnail") or ""),
        "source": "preview" if is_preview else "library",
        "source_pool": "related",
        "reason": "Requested by the listener",
        "reason_code": "dj_request",
        "recommendation_identity": str(track.get("recommendation_identity") or f"dj-request:{track_id or video_id}"),
        "recommendation_source": "auto_mode",
        "score": 1.0,
        "request_id": str(raw.get("id") or uuid.uuid4()),
    }


def _dj_command_direction(text: str) -> tuple[dict, str | None]:
    """Interpret the small, useful command language locally and predictably."""
    folded = text.casefold()
    patch: dict = {}
    if re.search(r"\b(m[aá]s energ\w*|sube|ca[nñ]a|intens\w*|banger|harder|energ\w*)\b", folded):
        patch["energy"] = 0.7
    elif re.search(r"\b(m[aá]s tranquil|baja|relaja|suave|calm|chill|menos energ)\b", folded):
        patch["energy"] = -0.7
    if re.search(r"\b(conocid|familiar|cl[aá]sic|hits?|popular)\b", folded):
        patch["familiarity"] = 0.7
    elif re.search(r"\b(descubr|nuevo|sorpr[eé]nd|menos conocid|underground)\b", folded):
        patch["familiarity"] = -0.7

    request_match = re.search(
        r"(?:^|\b)(?:pon(?:me)?|mete|quiero|toca|play|escuchar|escucha)\s+(?:algo\s+de\s+|una\s+de\s+|a\s+)?(.+?)(?:\s+(?:por favor|cuando puedas))?[.!?]*$",
        text,
        flags=re.IGNORECASE,
    )
    name = request_match.group(1).strip(" \t,.;:!?\"'") if request_match else None
    if name:
        name = re.split(r"\s+(?:pero|aunque|but|mais|however)\b", name, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    return patch, name or None


@discovery_bp.route("/api/discovery/music/dj-command", methods=["POST"])
@rate_limit("discovery_music_dj_command", limit=60, window_sec=60)
def discovery_music_dj_command():
    """Understand booth commands without an LLM or an external prompt service."""
    data = request.get_json(silent=True) or {}
    text = str(data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    direction, requested_name = _dj_command_direction(text)
    target = None
    if requested_name:
        try:
            rows = _deezer_artist_top_rows(requested_name, 1)
        except Exception:
            rows = []
        artist_row = rows[0].get("artist") if rows and isinstance(rows[0].get("artist"), dict) else {}
        resolved_name = str(artist_row.get("name") or "").strip()
        if resolved_name and resolved_name.casefold() == requested_name.casefold():
            target = {"kind": "artist", "label": resolved_name, "artist": {"name": resolved_name}}
        else:
            target = {"kind": "query", "label": requested_name, "query": requested_name}
    return jsonify({
        "v": 1,
        "understood": bool(direction or target),
        "direction_patch": direction,
        "request": target,
    })


def _music_set_item(raw: dict, *, source_id: str, label: str, weight: float = 1.0) -> dict | None:
    """Turn a browser track into a planner item without consulting taste history."""
    track = dict(raw)
    if track.get("source") == "preview":
        track.setdefault("youtube_id", track.get("id"))
    else:
        track.setdefault("track_id", track.get("id"))
    item = _planner_item_from_feed(track, pool="local" if track.get("source") != "preview" else "related")
    if not item:
        return None
    item.update({
        "source_set_id": source_id,
        "source_set_label": label,
        "source_weight": max(0.05, min(1.0, weight)),
        "lineage": [item["recommendation_identity"]],
        "reason": f"From {label}",
        "reason_code": "music_set_source",
        "recommendation_source": "auto_mode",
    })
    return item


def _auto_set_arc_position(heard_count: int, segment_index: int) -> float:
    """A repeating club-shaped arc, with session-stable phase variation."""
    phases = (0.34, 0.52, 0.74, 0.9, 0.78, 0.58)
    return phases[(heard_count + segment_index) % len(phases)]


def _build_music_set_route(data: dict) -> tuple[dict, int]:
    """Auto v6: conduct accumulating sources without semantic fences.

    Explicit sources and music that actually sounded are the only graph roots.
    Candidates never become roots merely because a previous plan recommended
    them, which prevents self-reinforcing recommendation walks.
    """
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    sources = [row for row in data.get("sources", []) if isinstance(row, dict)]
    if not seed:
        return {"error": "seed is required"}, 400
    raw_heard = data.get("heard") if isinstance(data.get("heard"), list) else []
    if not sources and not raw_heard:
        return {"error": "at least one source or heard track is required"}, 400
    try:
        limit = min(8, max(1, int(data.get("limit") or 8)))
        segment_index = max(0, int(data.get("segment_index") or 0))
    except (TypeError, ValueError):
        return {"error": "limit and segment_index must be numeric"}, 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)
    candidates: list[dict] = []
    degraded = False
    ordered_sources = sorted(
        sources,
        key=lambda row: int(row.get("activation") or 0),
    )
    source_count = max(1, len(ordered_sources))
    for source_index, source in enumerate(ordered_sources):
        source_id = str(source.get("id") or uuid.uuid4())
        label = str(source.get("label") or "Music set").strip()
        # Old sources stay alive while the latest direction dominates. The
        # floor deliberately remains non-zero: decay is not deletion.
        weight = 0.38 + 0.62 * ((source_index + 1) / source_count)
        roots = [
            item for raw in source.get("tracks", [])
            if isinstance(raw, dict)
            and (item := _music_set_item(raw, source_id=source_id, label=label, weight=weight))
        ]
        candidates.extend(roots)
        if not roots:
            continue
        related, graph_degraded = _planner_context_related(metadata, roots[-4:], personalise=False)
        degraded = degraded or graph_degraded
        root_identity = roots[-1]["recommendation_identity"]
        for item in related:
            item.update({
                "source_set_id": source_id,
                "source_set_label": label,
                "source_weight": weight,
                "lineage": [root_identity, item["recommendation_identity"]],
                "reason": f"Reached from {label}",
                "reason_code": "music_set_graph_walk",
                "recommendation_source": "auto_mode",
            })
            item["score"] = float(item.get("score") or 0.5) * weight
        candidates.extend(related)

    heard: set[str] = set()
    heard_roots = []
    for raw in raw_heard[-4:]:
        if not isinstance(raw, dict):
            continue
        normalised = _music_set_item(raw, source_id="heard", label="Heard", weight=0.3)
        if normalised:
            heard.add(str(normalised["recommendation_identity"]))
            heard_roots.append(normalised)
    if heard_roots:
        related, graph_degraded = _planner_context_related(metadata, heard_roots, personalise=False)
        degraded = degraded or graph_degraded
        for item in related:
            item.update({
                "source_set_id": "heard",
                "source_set_label": "Heard",
                "source_weight": 0.3,
                "lineage": ["heard", item["recommendation_identity"]],
                "reason": "Reached from music already heard",
                "reason_code": "heard_context",
                "recommendation_source": "auto_mode",
            })
            item["score"] = float(item.get("score") or 0.5) * 0.3
        candidates.extend(related)
    excluded = {str(value) for value in data.get("exclude", []) if str(value)}
    unique: dict[str, dict] = {}
    for item in candidates:
        identity = str(item.get("recommendation_identity") or item.get("id") or "")
        if not identity or identity in excluded:
            continue
        unique.setdefault(identity, item)
    available = [item for key, item in unique.items() if key not in heard]
    # Exact repeat exclusion is not a semantic fence. It may relax only when
    # the available pool is exhausted.
    if not available:
        available = list(unique.values())

    seed_material = f"{data.get('session_id', '')}:{segment_index}:{','.join(sorted(unique))}"
    entropy = int.from_bytes(hashlib.blake2s(seed_material.encode(), digest_size=8).digest(), "big")
    rng = random.Random(entropy)
    rng.shuffle(available)
    analysed = [(item, _dj_item_analysis(metadata, item)) for item in available]
    measured_energies = sorted(
        float(analysis.get("energy") or 0.5) for _, analysis in analysed if analysis.get("analysed")
    )
    arc = _auto_set_arc_position(len(heard), segment_index)
    if measured_energies:
        target = measured_energies[min(len(measured_energies) - 1, int(arc * len(measured_energies)))]
        analysed.sort(key=lambda pair: abs(float(pair[1].get("energy") or 0.5) - target))

    ordered: list[tuple[dict, dict]] = []
    pool = analysed
    previous = _dj_item_analysis(metadata, seed, schedule=True)
    for item, analysis in pool:
        if len(ordered) >= limit:
            break
        row = dict(item)
        row["analysis"] = analysis
        row["transition"] = plan_transition(previous, analysis, profile="adaptive")
        ordered.append((row, analysis))
        previous = analysis

    route = [row for row, _ in ordered]
    for item in route:
        _dj_item_analysis(metadata, item, schedule=True)
    return {
        "v": 6,
        "plan_id": str(uuid.uuid4()),
        "intent": "auto_mode",
        "profile": "balanced",
        "dj_profile": "adaptive",
        "source_profile": "balanced",
        "seed_identity": str(seed.get("id") or seed.get("youtube_id") or ""),
        "seed_analysis": _dj_item_analysis(metadata, seed, schedule=True),
        "items": route,
        "degraded": degraded or not route,
        "pool_counts": {
            "local": sum(1 for item in unique.values() if item.get("source_pool") == "local"),
            "related": sum(1 for item in unique.values() if item.get("source_pool") == "related"),
            "discovery": 0,
        },
        "generated_at": int(time.time()),
        "session_id": data.get("session_id"),
        "segment_index": segment_index,
        "arc": {"target": arc, "phase": (len(heard) + segment_index) % 6},
    }, 200


@discovery_bp.route("/api/discovery/music/dj-plan", methods=["POST"])
@rate_limit("discovery_music_dj_plan", limit=60, window_sec=60)
def discovery_music_dj_plan():
    """Build a short transition-aware route exclusively for Auto Mode."""
    data = request.get_json(silent=True) or {}
    if isinstance(data.get("sources"), list):
        payload, status = _build_music_set_route(data)
        return jsonify(payload), status
    profile = str(data.get("dj_profile") or "adaptive").strip()
    if profile not in DJ_PROFILES:
        return jsonify({"error": "unsupported dj_profile"}), 400
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    if not seed:
        return jsonify({"error": "seed is required"}), 400
    direction = data.get("direction") if isinstance(data.get("direction"), dict) else {}
    try:
        familiarity = float(direction.get("familiarity") or 0)
        requested_limit = min(8, max(3, int(data.get("limit") or 8)))
    except (TypeError, ValueError):
        return jsonify({"error": "direction and limit must be numeric"}), 400
    source_profile = "familiar" if familiarity >= 0.35 else "explore" if familiarity <= -0.35 else "balanced"
    base, status = _build_music_plan({
        "intent": "auto_mode",
        "profile": source_profile,
        "seed": seed,
        "context": data.get("context") or [],
        "session_id": data.get("session_id"),
        "segment_index": data.get("segment_index"),
        "exclude": data.get("exclude") or [],
        "limit": _AUTO_ROUTER_LIMIT,
    })
    if status != 200:
        return jsonify(base), status

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)
    seed_analysis = _dj_item_analysis(metadata, seed, schedule=True)
    try:
        energy_delta = max(-1.0, min(1.0, float(direction.get("energy") or 0)))
    except (TypeError, ValueError):
        return jsonify({"error": "direction energy must be numeric"}), 400
    desired_energy = max(0.0, min(1.0, float(seed_analysis.get("energy") or 0.5) + energy_delta * 0.35))
    include_terms = [
        str(value).strip().casefold()
        for value in (direction.get("include") if isinstance(direction.get("include"), list) else [])
        if str(value).strip()
    ]
    exclude_terms = [
        str(value).strip().casefold()
        for value in (direction.get("exclude") if isinstance(direction.get("exclude"), list) else [])
        if str(value).strip()
    ]
    candidates = []
    for candidate in base.get("items") or []:
        haystack = f"{candidate.get('artist', '')} {candidate.get('title', '')} {candidate.get('album', '')}".casefold()
        if any(term in haystack for term in exclude_terms):
            continue
        candidate_analysis = _dj_item_analysis(metadata, candidate)
        energy_fit = (
            1 - abs(float(candidate_analysis.get("energy") or 0.5) - desired_energy)
            if candidate_analysis.get("analysed")
            else 0.5
        )
        include_fit = 1.0 if include_terms and any(term in haystack for term in include_terms) else 0.0
        semantic_fit = max(0.0, min(1.0, float(candidate.get("semantic_score") or 0.5)))
        personal_fit = max(0.0, min(1.0, float(candidate.get("personal_score") or 0.5)))
        candidate["score"] = max(
            0.0,
            min(
                1.0,
                semantic_fit * 0.5
                + energy_fit * 0.2
                + personal_fit * 0.15
                + float(candidate.get("score") or 0.5) * 0.05
                + include_fit * 0.1,
            ),
        )
        candidates.append((candidate, candidate_analysis))
    requests = [
        item
        for raw in (data.get("requests") if isinstance(data.get("requests"), list) else [])
        if isinstance(raw, dict) and (item := _normalise_dj_request(raw))
    ]

    route: list[dict] = []
    previous = seed_analysis
    remaining = list(candidates)
    max_items = requested_limit
    request_statuses: list[dict] = []
    for requested in requests:
        if len(route) >= max_items:
            break
        targets: list[dict]
        if requested["kind"] == "artist":
            from shared.user_context import current_user_id

            targets = _planner_artist_candidates(requested["artist_name"], current_user_id(), 8)
            for target in targets:
                target.update({
                    "request_id": requested["request_id"],
                    "reason": f"Requested artist: {requested['artist_name']}",
                    "reason_code": "dj_artist_request",
                })
        else:
            targets = [requested]
        candidate_segments: list[tuple[float, list[dict], dict]] = []
        for target in targets:
            target_analysis = _dj_item_analysis(metadata, target)
            target_segment = route_to_request(
                previous,
                remaining,
                (target, target_analysis),
                profile=profile,
                max_starts=min(5, max_items - len(route)),
            )
            if not target_segment:
                continue
            transition_quality = sum(float(row["transition"]["score"]) for row in target_segment) / len(target_segment)
            position_cost = max(0, len(target_segment) - 1) * 0.025
            candidate_segments.append((
                transition_quality + float(target.get("score") or 0.5) * 0.08 - position_cost,
                target_segment,
                target_analysis,
            ))
        if not candidate_segments:
            request_statuses.append({
                "id": requested["request_id"],
                "kind": requested["kind"],
                "label": requested["label"],
                "status": "failed",
                "eta_tracks": None,
                "scheduled_position": None,
                "failure_code": "unavailable",
            })
            continue
        _, segment, requested_analysis = max(candidate_segments, key=lambda row: row[0])
        route.extend(segment)
        used = {str(item.get("recommendation_identity") or item.get("id")) for item in segment}
        remaining = [
            (item, analysis)
            for item, analysis in remaining
            if str(item.get("recommendation_identity") or item.get("id")) not in used
        ]
        previous = requested_analysis
        eta = next(
            (index + 1 for index, row in enumerate(route) if row.get("request_id") == requested["request_id"]),
            None,
        )
        request_statuses.append({
            "id": requested["request_id"],
            "kind": requested["kind"],
            "label": requested["label"],
            "status": "planned",
            "track_identity": next(
                (row.get("recommendation_identity") for row in route if row.get("request_id") == requested["request_id"]),
                None,
            ),
            "eta_tracks": eta,
            "scheduled_position": eta + 1 if eta is not None else None,
            "preferred_position": 2,
            "max_position": 6,
            "failure_code": None,
        })
    if len(route) < max_items:
        route.extend(order_route(
            previous,
            remaining,
            profile=profile,
            limit=max_items - len(route),
            source_sequence=base.get("source_sequence") or auto_source_sequence(source_profile),
            source_offset=len(route),
        ))

    # Only the accepted route is allowed to schedule local analysis. External
    # previews are fetched by the existing browser runway prefetch, then refined
    # shortly before their handoff.
    for item in route:
        _dj_item_analysis(metadata, item, schedule=True)

    return jsonify({
        **base,
        "v": 4,
        "dj_profile": profile,
        "source_profile": source_profile,
        "seed_analysis": seed_analysis,
        "items": route,
        "requests": request_statuses,
    })


def _dj_place_bridge_pool(metadata, data: dict, occupied: set[str]) -> list[tuple[dict, dict]]:
    """Build one-hop bridges from explicit sources and heard music only."""
    roots = []
    sources = data.get("sources") if isinstance(data.get("sources"), list) else []
    for source in sources:
        if not isinstance(source, dict):
            continue
        tracks = source.get("tracks") if isinstance(source.get("tracks"), list) else []
        for raw in tracks:
            if not isinstance(raw, dict):
                continue
            item = _music_set_item(
                raw,
                source_id=str(source.get("id") or "source"),
                label=str(source.get("label") or "Source"),
            )
            if item:
                roots.append(item)
    heard = data.get("heard") if isinstance(data.get("heard"), list) else []
    for raw in heard[-4:]:
        if not isinstance(raw, dict):
            continue
        item = _music_set_item(raw, source_id="heard", label="Heard", weight=0.3)
        if item:
            roots.append(item)
    if not roots:
        return []
    related, _ = _planner_context_related(metadata, roots[-8:], personalise=False)
    candidates = []
    for item in related:
        identity = str(item.get("recommendation_identity") or item.get("id") or "")
        if not identity or identity in occupied:
            continue
        occupied.add(identity)
        candidates.append((item, _dj_item_analysis(metadata, item)))
        if len(candidates) >= 12:
            break
    return candidates


@discovery_bp.route("/api/discovery/music/dj-place", methods=["POST"])
@rate_limit("discovery_music_dj_place", limit=90, window_sec=60)
def discovery_music_dj_place():
    """Place one song in the current route without rebuilding that route."""
    data = request.get_json(silent=True) or {}
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    raw_track = data.get("track") if isinstance(data.get("track"), dict) else {}
    raw_route = data.get("route") if isinstance(data.get("route"), list) else []
    requested_queue_id = str(data.get("requested_queue_id") or "").strip()
    if not seed or not raw_track or not requested_queue_id:
        return jsonify({"error": "seed, track and requested_queue_id are required"}), 400
    profile = str(data.get("dj_profile") or "adaptive").strip()
    if profile not in DJ_PROFILES:
        return jsonify({"error": "unsupported dj_profile"}), 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)
    target = _music_set_item(raw_track, source_id="route", label="Route")
    if not target:
        return jsonify({"error": "track cannot be placed"}), 400
    target.update({
        "request_id": requested_queue_id,
        "reason": "Placed in route",
        "reason_code": "route_user",
    })
    target_analysis = _dj_item_analysis(metadata, target, schedule=True)

    route: list[tuple[dict, dict]] = []
    occupied = {str(target.get("recommendation_identity") or target.get("id") or "")}
    for raw in raw_route[:16]:
        if not isinstance(raw, dict):
            continue
        item = _music_set_item(raw, source_id="route", label="Route")
        if not item:
            continue
        item["queue_id"] = str(raw.get("queue_id") or "")
        occupied.add(str(item.get("recommendation_identity") or item.get("id") or ""))
        route.append((item, _dj_item_analysis(metadata, item)))

    before_queue_id = str(data.get("before_queue_id") or "").strip()
    fixed_index = next(
        (index for index, (item, _) in enumerate(route) if item.get("queue_id") == before_queue_id),
        None,
    ) if before_queue_id else None
    if before_queue_id and fixed_index is None:
        return jsonify({"error": "before_queue_id is not in the editable route"}), 409
    gap_indexes = [fixed_index] if fixed_index is not None else list(range(len(route) + 1))
    bridge_pool = [] if fixed_index is not None else _dj_place_bridge_pool(metadata, data, occupied)
    seed_analysis = _dj_item_analysis(metadata, seed, schedule=True)

    best = None
    for gap in gap_indexes:
        if gap is None:
            continue
        previous = seed_analysis if gap == 0 else route[gap - 1][1]
        segment = route_to_request(
            previous,
            bridge_pool,
            (target, target_analysis),
            profile=profile,
            max_starts=1 if fixed_index is not None else 3,
        )
        qualities = [float(row["transition"]["score"]) for row in segment]
        following = None
        if gap < len(route):
            following = plan_transition(target_analysis, route[gap][1], profile=profile)
            qualities.append(float(following["score"]))
        score = sum(qualities) / max(1, len(qualities)) - gap * 0.009
        candidate = (score, -gap, gap, segment, following)
        if best is None or candidate[:2] > best[:2]:
            best = candidate

    if best is None:
        return jsonify({"error": "route has no editable gap"}), 409
    _, _, insert_at, segment, following = best
    items = []
    for row in segment:
        placed = dict(row)
        is_target = placed.get("request_id") == requested_queue_id
        placed["route_kind"] = "user" if is_target else "bridge"
        if not is_target:
            placed["owner_queue_id"] = requested_queue_id
        items.append(placed)
        _dj_item_analysis(metadata, placed, schedule=True)
    return jsonify({
        "v": 1,
        "insert_at": insert_at,
        "before_queue_id": route[insert_at][0].get("queue_id") if insert_at < len(route) else None,
        "requested_queue_id": requested_queue_id,
        "items": items,
        "following_transition": following,
        "degraded": not bool(target_analysis.get("analysed")),
    }), 200


_DJ_REPAIR_ROUTE_CAP = 16
_DJ_REPAIR_MAX_BRIDGES = 2
_DJ_REPAIR_STABILITY_BONUS = 0.06


def _dj_repair_anchor(raw: dict) -> dict:
    """A pinned song keeps its slot even when the planner cannot name it.

    Placement is free to skip a reference it cannot read; repair is not. The
    listener put this song where it is, so an unreadable reference becomes an
    opaque anchor with a conservative reading rather than a hole in their route.
    """
    item = _music_set_item(raw, source_id="route", label="Route")
    if item:
        return item
    title = str(raw.get("title") or "Unknown")
    artist = str(raw.get("artist") or "")
    identity = canonical_music_identity(artist, title, channel=artist)
    recommendation_identity = str(raw.get("recommendation_identity") or identity.key)
    return {
        "id": str(raw.get("id") or raw.get("queue_id") or ""),
        "track_id": None,
        "youtube_id": None,
        "title": identity.title,
        "artist": identity.artist,
        "source_title": title,
        "source_artist": artist,
        "playback_source_kind": identity.source_kind,
        "canonical_identity": identity.key,
        "album": str(raw.get("album") or ""),
        "duration": int(raw.get("duration") or 0),
        "cover": str(raw.get("cover") or ""),
        "source": "preview",
        "source_pool": "local",
        "reason": "Placed in route",
        "reason_code": "route_user",
        "recommendation_identity": recommendation_identity,
        "score": 1.0,
        "external_ids": {},
        "source_set_id": "route",
        "source_set_label": "Route",
        "source_weight": 1.0,
        "lineage": [recommendation_identity],
    }


def _dj_repair_identity(item: dict) -> str:
    return str(item.get("recommendation_identity") or item.get("id") or "")


@discovery_bp.route("/api/discovery/music/dj-repair", methods=["POST"])
@rate_limit("discovery_music_dj_repair", limit=30, window_sec=60)
def discovery_music_dj_repair():
    """Rebuild the mix around whatever the listener has done to the route.

    Every song they placed keeps its slot and its order; the material between
    those anchors is re-chosen so each seam mixes. Placement can pin a song or
    bridge into one, never both — `dj-place` drops its bridge pool the moment a
    position is fixed. This does both at once, which is what makes "move things
    around, then press the button" safe.

    Stateless like the rest of the DJ surface: the whole route is posted, and
    the whole repaired route comes back. A diff would force the caller to
    rebuild a transition chain across items it never received, which is exactly
    how a cue ends up belonging to the wrong song.
    """
    data = request.get_json(silent=True) or {}
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    raw_route = data.get("route") if isinstance(data.get("route"), list) else []
    if not seed or not raw_route:
        return jsonify({"error": "seed and route are required"}), 400
    profile = str(data.get("dj_profile") or "adaptive").strip()
    if profile not in DJ_PROFILES:
        return jsonify({"error": "unsupported dj_profile"}), 400
    raw_limit = data.get("limit")
    if raw_limit is not None and not isinstance(raw_limit, int):
        return jsonify({"error": "limit must be an integer"}), 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)

    refs = [raw for raw in raw_route[:_DJ_REPAIR_ROUTE_CAP] if isinstance(raw, dict)]
    parsed: list[tuple[bool, dict, dict]] = []
    for raw in refs:
        pinned = str(raw.get("route_kind") or "generated").strip() == "user"
        item = _dj_repair_anchor(raw) if pinned else _music_set_item(raw, source_id="route", label="Route")
        if not item:
            continue
        item["queue_id"] = str(raw.get("queue_id") or "")
        parsed.append((pinned, item, _dj_item_analysis(metadata, item)))
    if not parsed:
        return jsonify({"error": "route has nothing to repair"}), 400

    anchors = [(item, analysis) for pinned, item, analysis in parsed if pinned]
    spares = [(item, analysis) for pinned, item, analysis in parsed if not pinned]
    # How deep each pin sat, measured in songs before it. Holding only their
    # relative order would let a song the listener dropped at slot nine surface
    # as the very next one — order intact, intent destroyed. Repair re-chooses
    # what fills a gap, never how long the gap is.
    depths: list[int] = []
    run = 0
    for pinned, _, _ in parsed:
        if pinned:
            depths.append(run)
            run = 0
        else:
            run += 1

    # Avoided songs stay out of the filler, but never out of a pin: choosing a
    # song you earlier waved away is a change of mind, and the pin wins.
    occupied = {str(value) for value in (data.get("exclude") or []) if value}
    occupied.update(_dj_repair_identity(item) for item, _ in (*anchors, *spares))
    occupied.discard("")

    # An equal-quality seam should keep the row already on screen. `order_route`
    # weights relevance at 0.20, so this is a tiebreak rather than a thumb on
    # the scale — a genuinely bad seam still loses its slot.
    pool: list[tuple[dict, dict]] = [
        ({**item, "score": min(1.0, float(item.get("score") or 0.5) + _DJ_REPAIR_STABILITY_BONUS)}, analysis)
        for item, analysis in spares
    ]
    pool.extend(_dj_place_bridge_pool(metadata, data, occupied))

    seed_analysis = _dj_item_analysis(metadata, seed, schedule=True)
    target = min(_DJ_REPAIR_ROUTE_CAP, max(len(refs), int(raw_limit or len(refs))))
    built: list[dict] = []
    previous = seed_analysis
    def spend(rows: list[dict]) -> None:
        spent = {_dj_repair_identity(row) for row in rows}
        pool[:] = [row for row in pool if _dj_repair_identity(row[0]) not in spent]

    for position, (anchor_item, anchor_analysis) in enumerate(anchors):
        # Room the anchors still to come have already claimed is not spendable.
        remaining = len(anchors) - position
        fill = order_route(
            previous, pool, profile=profile,
            limit=max(0, min(depths[position], target - len(built) - remaining)),
        )
        for row in fill:
            row["route_kind"] = "generated"
        built.extend(fill)
        spend(fill)
        if fill:
            previous = fill[-1]["analysis"]
        # Bridges may push past the route's original length, and only bridges
        # may. Measuring their room against that length instead meant a route
        # the listener had filled entirely with their own songs — the exact case
        # this endpoint exists for — could never be given a way into them.
        headroom = _DJ_REPAIR_ROUTE_CAP - len(built) - remaining
        segment = route_to_request(
            previous,
            pool,
            (anchor_item, anchor_analysis),
            profile=profile,
            max_starts=1 + max(0, min(_DJ_REPAIR_MAX_BRIDGES, headroom)),
        )
        for row in segment[:-1]:
            row["route_kind"] = "bridge"
            row["owner_queue_id"] = anchor_item.get("queue_id") or ""
        segment[-1]["route_kind"] = "user"
        built.extend(segment)
        spend(segment)
        previous = anchor_analysis

    # Repair re-seams a route, it does not grow one. When the pool runs dry the
    # tail comes back short and the browser's own refill tops it up at the next
    # natural moment; there should not be a second thing that lengthens a route.
    tail = order_route(previous, pool, profile=profile, limit=max(0, target - len(built)))
    for row in tail:
        row["route_kind"] = "generated"
    built.extend(tail)

    for row in built:
        row["queue_id"] = row.get("queue_id") or None
        _dj_item_analysis(metadata, row, schedule=True)

    kept = {row["queue_id"] for row in built if row["queue_id"]}
    return jsonify({
        "v": 1,
        "seed_analysis": seed_analysis,
        "items": built,
        "dropped": [
            queue_id for raw in refs
            if (queue_id := str(raw.get("queue_id") or "")) and queue_id not in kept
        ],
        "degraded": any(not analysis.get("analysed") for _, analysis in anchors),
    }), 200


@discovery_bp.route("/api/discovery/music/dj-transition", methods=["POST"])
@rate_limit("discovery_music_dj_transition", limit=240, window_sec=60)
def discovery_music_dj_transition():
    """Re-plan a single transition against whatever is now measured.

    The route endpoint answers immediately with conservative transitions for
    anything it has not measured yet. This is how those become real ones: the
    player asks again shortly before it commits a handoff, and if the background
    analysis has landed it gets the beatmatched plan instead of the fade. It is
    cache-only by design — it never triggers a decode, so it always returns fast.
    """
    data = request.get_json(silent=True) or {}
    profile = str(data.get("dj_profile") or "adaptive").strip()
    if profile not in DJ_PROFILES:
        return jsonify({"error": "unsupported dj_profile"}), 400
    outgoing = data.get("from") if isinstance(data.get("from"), dict) else None
    incoming = data.get("to") if isinstance(data.get("to"), dict) else None
    if not outgoing or not incoming:
        return jsonify({"error": "from and to are required"}), 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)

    def measured(item: dict) -> tuple[dict, bool]:
        path = _dj_source_path(metadata, item)
        analysis = cached_analysis(path, analysis_identity(item)) if path else None
        if analysis is not None:
            return analysis, True
        if path:
            request_analysis(path, analysis_identity(item), duration_hint=float(item.get("duration") or 0))
        return _dj_fallback_analysis(float(item.get("duration") or 0)), False

    out_analysis, out_ready = measured(outgoing)
    in_analysis, in_ready = measured(incoming)
    return jsonify({
        "transition": plan_transition(out_analysis, in_analysis, profile=profile),
        "analysis": {"from": out_analysis, "to": in_analysis},
        "measured": out_ready and in_ready,
    })
