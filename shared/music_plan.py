"""The `/api/discovery/music/plan` queue: a seed's candidates, ranked.

`feed_body` and `resolve_seed_youtube_id` come from the discovery routes that
own the feed and the seed graph; this module never imports a route.
"""

from __future__ import annotations

import logging
import time
import uuid


from shared import catalog_resolution
from shared.database import instance_db
from shared.discovery_intelligence import (
    build_music_recommendations,
    rank_recommendation_rows,
)
from shared.listening_planner import (
    AUTO_PROFILES,
    LISTENING_INTENTS,
    auto_source_sequence,
    plan_generated_queue,
)
from shared.url_utils import validate_youtube_video_id

from shared import music_candidates

logger = logging.getLogger(__name__)

def build_music_plan(data: dict, *, feed_body, resolve_seed_youtube_id) -> tuple[dict, int]:
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

    api = music_candidates.engine_api()
    lib = api["get_library"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    track_id = str(seed.get("track_id") or "").strip()
    library_seed = music_candidates.track_by_id(metadata, track_id) if track_id else None
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
        seed_youtube_id = resolve_seed_youtube_id(library_seed)
    if not validate_youtube_video_id(seed_youtube_id) and seed_title and seed_artist:
        try:
            best, _ = catalog_resolution.resolve_candidates(
                music_candidates.engine_api()["get_downloader"], seed_artist, seed_title, int(seed.get("duration") or 0) or None
            )
            seed_youtube_id = str(best.get("id") or "")
        except Exception:
            seed_youtube_id = ""
    if (
        not library_seed
        and not validate_youtube_video_id(seed_youtube_id)
        and not (seed_title and seed_artist)
    ):
        return {"error": "seed needs a track id, video id, or title and artist"}, 400

    fav_ids = api["favourite_library_ids"]()
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
        context = music_candidates.planner_context(context_seed, data.get("context"))
        pools, graph_degraded = music_candidates.build_auto_pools(
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
        items = music_candidates.annotate_plan_loudness(metadata, music_candidates.canonicalize_generated_items(items, current_user_id()))
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
            candidate = music_candidates.item_from_feed(item, pool="local")
            if not candidate:
                continue
            local_track = music_candidates.track_by_id(metadata, str(candidate.get("track_id") or ""))
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
                if (candidate := music_candidates.item_from_related(row))
            ]
        except Exception as exc:
            related_error = True
            logger.info("Listening plan related pool unavailable for %s: %s", seed_youtube_id, exc)

    discovery: list[dict] = []
    discovery_error = False
    try:
        feed = feed_body(max(8, limit), include_external=False)
        discovery = [
            candidate
            for item in feed.get("items") or []
            if (candidate := music_candidates.item_from_feed(item, pool="discovery"))
            and not candidate.get("track_id")
        ]
    except Exception as exc:
        discovery_error = True
        logger.info("Listening plan discovery pool unavailable: %s", exc)
    items = plan_generated_queue(
        {
            "local": local,
            "related": music_candidates.reconcile_library_sources(metadata, related),
            "discovery": music_candidates.reconcile_library_sources(metadata, discovery),
        },
        intent=intent,
        profile=profile,
        limit=limit,
        exclude=[str(value) for value in exclude[:200] if str(value).strip()],
    )
    items = music_candidates.annotate_plan_loudness(metadata, music_candidates.canonicalize_generated_items(items, current_user_id()))
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
