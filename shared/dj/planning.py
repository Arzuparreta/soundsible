"""DJ route requests: what the dj-plan, dj-place and dj-repair routes compute.

Normalising a request, measuring its songs without blocking on a decode,
building a session's route from its sources, and the bridge pool a placement
or repair draws from. The Flask handlers in `shared/api/routes/auto_mode.py`
only parse, call and answer.
"""

from __future__ import annotations

import hashlib
import logging
import random
import time
import uuid

from flask import has_request_context, request

from shared import preview_streams
from shared.dj.timing import fixed_tempo
from shared.dj_engine import (
    analyse_audio,
    analysis_identity,
    cached_analysis,
    order_continuous_route,
    request_analysis,
)
from shared.dj.routes import (
    choose_placement,
)
from shared.dj.contracts import analysis_summary
from shared.dj_pool import ANALYSIS_COHORT_SIZE, add_measured_bridges
from shared.music_identity import canonical_music_identity
from shared.path_resolver import resolve_local_track_path
from shared.url_utils import validate_youtube_video_id

from shared import work
from shared import music_candidates

logger = logging.getLogger(__name__)

def source_path(metadata, item: dict) -> str | None:
    """Where this item's audio already lives locally, if anywhere.

    Looking up analysis is read-only. Only the frozen, cache-independent DJ
    cohort may request speculative acquisition, via `prepare_cohort`.
    """
    track_id = str(item.get("track_id") or "").strip()
    video_id = str(item.get("youtube_id") or (item.get("id") if item.get("source") == "preview" else "") or "").strip()
    if track_id:
        track = music_candidates.track_by_id(metadata, track_id)
        return resolve_local_track_path(track) if track else None
    if not validate_youtube_video_id(video_id):
        return None
    from shared import preview_cache

    cached = preview_cache.get_cached(video_id)
    if cached:
        return str(cached[0])
    return None


def item_analysis(metadata, item: dict, *, schedule: bool = False) -> dict:
    """Features for one route item, without ever blocking on FFmpeg.

    Planning is on the interaction path: a listener adding a source must not
    wait on a decode. Whatever has already been measured is used, the
    rest is queued, and the route is built from a conservative fallback that the
    player is required to treat as such. The refinement endpoint picks up the
    real numbers once they land, before the transition is ever committed.
    """
    duration_hint = float(item.get("duration") or 0)
    identity = analysis_identity(item)
    path = source_path(metadata, item)
    if not path:
        return fallback_analysis(duration_hint)
    cached = cached_analysis(path, identity)
    if cached is not None:
        return cached
    if schedule and (not has_request_context() or not request.headers.get("X-Soundsible-Work")
                     or request.path.endswith(("dj-work", "dj-transition"))):
        request_analysis(path, identity, duration_hint=duration_hint)
    return fallback_analysis(duration_hint)



def transition_analysis(metadata, item: dict) -> tuple[dict, bool]:
    """A song's measured features and True, or the fallback and False.

    A refinement outside a client's own DJ work also queues the measurement.
    """
    path = source_path(metadata, item)
    analysis = cached_analysis(path, analysis_identity(item)) if path else None
    if analysis is not None:
        return analysis, True
    if path and not request.headers.get("X-Soundsible-Work"):
        request_analysis(path, analysis_identity(item), duration_hint=float(item.get("duration") or 0))
    return fallback_analysis(float(item.get("duration") or 0)), False

def prepare_cohort(metadata, items: list[dict]) -> None:
    """Queue a bounded, already chosen cohort; never rank by cache state."""
    from shared import preview_cache

    video_ids = []
    demand = work.current()
    if demand is not None:
        work.check()
        tracks = getattr(demand, "tracks", {})
        tracks.update({analysis_identity(item): {key: item[key] for key in
                       ("id", "track_id", "youtube_id", "source", "duration") if key in item}
                       for item in items})
        demand.tracks = tracks
    for item in items:
        item_analysis(metadata, item, schedule=True)
        if not item.get("track_id"):
            # Acquisition follows the playback upload; discovery_youtube_id
            # belongs to the recommendation graph and can name another upload.
            video_id = str(item.get("youtube_id") or
                           (item.get("id") if item.get("source") == "preview" else "") or "").strip()
            if validate_youtube_video_id(video_id):
                video_ids.append(video_id)
    if not video_ids or preview_cache.cache_limit_bytes() <= 0:
        return
    api = music_candidates.engine_api()

    def refresh(video_id):
        preview_streams.invalidate(video_id)
        return preview_streams.resolve(api["get_downloader"], video_id, skip_fast_path=True)

    preview_cache.request_prefetch(
        video_ids, download=True,
        resolver=lambda video_id: preview_streams.resolve(api["get_downloader"], video_id),
        refresh_resolver=refresh,
    )


def fallback_analysis(duration_hint: float) -> dict:
    return analyse_audio("", "", duration_hint=duration_hint)


def normalise_request(raw: dict) -> dict | None:
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
        "item_id": music_candidates.collection_item_id(video_id, track.get("item_id"), track_id),
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


def music_set_item(raw: dict, *, source_id: str, label: str, weight: float = 1.0) -> dict | None:
    """Turn a browser track into a planner item without consulting taste history."""
    track = dict(raw)
    if track.get("source") == "preview":
        track.setdefault("youtube_id", track.get("id"))
    else:
        track.setdefault("track_id", track.get("id"))
    item = music_candidates.item_from_feed(track, pool="local" if track.get("source") != "preview" else "related")
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


# A song the DJ mixes in and out of. Past this a file is a DJ set, a live
# recording or a whole album in one take: not something to blend between, and
# on a phone a stream of hundreds of megabytes that will not buffer in time.
MAX_SONG_SECONDS = 20 * 60


def song_sized(item: dict) -> bool:
    try:
        duration = float(item.get("duration") or 0)
    except (TypeError, ValueError):
        return True
    return duration <= 0 or duration <= MAX_SONG_SECONDS


def exploration_related(metadata, heard_roots: list[dict]) -> music_candidates.GraphWalk:
    """One hop out of confirmed automatic playback in the current direction."""
    if not heard_roots:
        return music_candidates.GraphWalk([], False, False)
    walk = music_candidates.context_related(metadata, heard_roots, personalise=False)
    related = list(walk.items)
    for item in related:
        item.update({
            "source_set_id": "exploration",
            "source_set_label": "Session",
            "source_weight": 0.3,
            "lineage": ["exploration", item["recommendation_identity"]],
            "reason": "Reached from this DJ session",
            "reason_code": "heard_context",
            "recommendation_source": "auto_mode",
        })
        item["score"] = float(item.get("score") or 0.5) * 0.3
    return walk._replace(items=related)


def build_music_set_route(data: dict) -> tuple[dict, int]:
    """Auto v6: conduct accumulating sources without semantic fences.

    Explicit sources and confirmed automatic playback are the only graph roots.
    Candidates never become roots merely because a previous plan recommended
    them, which prevents self-reinforcing recommendation walks.
    """
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    sources = [row for row in data.get("sources", []) if isinstance(row, dict)]
    raw_heard = data.get("heard") if isinstance(data.get("heard"), list) else []
    if not sources and not raw_heard:
        return {"error": "at least one source or heard track is required"}, 400
    try:
        limit = min(8, max(1, int(data.get("limit") or 8)))
        segment_index = max(0, int(data.get("segment_index") or 0))
    except (TypeError, ValueError):
        return {"error": "limit and segment_index must be numeric"}, 400

    api = music_candidates.engine_api()
    lib = api["get_library"]()
    metadata = getattr(lib, "metadata", None)
    candidates: list[dict] = []
    degraded = False
    warming = False
    cache_hit = cache_miss = 0
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
            and (item := music_set_item(raw, source_id=source_id, label=label, weight=weight))
        ]
        candidates.extend(roots)
        if not roots:
            continue
        walk = music_candidates.context_related(metadata, roots[-4:], personalise=False)
        related = list(walk.items)
        degraded = degraded or walk.degraded
        warming = warming or walk.warming
        cache_hit += walk.cache_hit
        cache_miss += walk.cache_miss
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

    # Exploration is supplied separately from repeat history. Legacy clients
    # have no provenance, so only their non-explicit policy uses heard roots.
    raw_exploration = data.get("exploration")
    if not isinstance(raw_exploration, list):
        raw_exploration = raw_heard if data.get("source_policy") != "explicit" else []
    exploration_roots = [
        item for raw in raw_exploration[-4:] if isinstance(raw, dict)
        and (item := music_set_item(raw, source_id="exploration", label="Session", weight=0.3))
    ]
    exploration_walk = exploration_related(metadata, exploration_roots)
    degraded = degraded or exploration_walk.degraded
    warming = warming or exploration_walk.warming
    cache_hit += exploration_walk.cache_hit
    cache_miss += exploration_walk.cache_miss
    candidates.extend(exploration_walk.items)
    heard_order = [
        item["recommendation_identity"] for raw in raw_heard[-4:]
        if isinstance(raw, dict)
        and (item := music_set_item(raw, source_id="heard", label="Heard"))
    ]
    heard = set(heard_order)
    excluded = {str(value) for value in data.get("exclude", []) if str(value)}
    # The song a route continues from is never a candidate for that route. It
    # reaches the pool as a source root, and the browser names it in the
    # playback namespace (`<video id>`) rather than the planner's
    # (`music:youtube:<video id>`), so matching on one key alone let the seed
    # come back as its own runway — which the browser then dropped as a
    # duplicate and reported as a dry pool.
    if seed:
        excluded |= music_candidates.candidate_keys(seed)
    unique: dict[str, dict] = {}
    seen: set[str] = set()
    for item in candidates:
        keys = music_candidates.candidate_keys(item)
        if not keys or keys & excluded or keys & seen:
            continue
        seen |= keys
        unique[str(item.get("recommendation_identity") or item.get("id") or "")] = item
    # Repeating something the session has already heard beats stopping, but only
    # once the rest has been tried. Relaxing all the way back is what used to
    # hand the listener the track that was already playing.
    recent_heard = set(heard_order[-2:])
    available = [item for key, item in unique.items() if key not in heard]
    if not available:
        available = [item for key, item in unique.items() if key not in recent_heard]
    # Songs before anything song-sized is given up on: a source made only of
    # long recordings still opens rather than going silent.
    available = [item for item in available if song_sized(item)] or available

    seed_material = f"{data.get('session_id', '')}:{segment_index}:{','.join(sorted(unique))}"
    entropy = int.from_bytes(hashlib.blake2s(seed_material.encode(), digest_size=8).digest(), "big")
    rng = random.Random(entropy)
    rng.shuffle(available)
    opening: dict | None = None
    opening_analysis: dict | None = None
    if not seed:
        # An empty session must open *inside the collection the listener just
        # handed to the DJ*, never on a related walk or implicit taste history.
        # Recent sources win; within a source the deterministic shuffle picks.
        roots = [
            item for item in available
            if item.get("reason_code") == "music_set_source"
        ]
        if not roots:
            return {"error": "sources contain no playable opening tracks"}, 400
        roots.sort(key=lambda item: -float(item.get("source_weight") or 0))
        opening = dict(roots[0])
        available = [item for item in available if item is not roots[0]]
        opening_analysis = item_analysis(metadata, opening, schedule=True)
        opening["analysis"] = opening_analysis
        opening.pop("transition", None)
        seed = opening
    # Sources and recommendation walks choose the music. Freeze membership
    # before reading any analysis so measured/local audio cannot displace cold
    # external songs. The DJ only orders this short, cache-independent set.
    cohort = available[:ANALYSIS_COHORT_SIZE]
    # Membership and the possible bridge pool are fixed before *any* cache read.
    # Coverage is observational: it cannot change who gets analysed or selected.
    snapshots = {id(item): item_analysis(metadata, item) for item in available}
    analysed = [(item, snapshots[id(item)]) for item in cohort[:limit]]
    spares = [(item, snapshots[id(item)]) for item in cohort[limit:]]
    previous = opening_analysis or item_analysis(metadata, seed, schedule=True)
    route = add_measured_bridges(previous, order_continuous_route(previous, analysed), spares)
    # Cold alternatives are not revisited after this response. Only actual
    # route members have a consumer for newly acquired bytes/measurements.
    if not has_request_context() or not request.headers.get("X-Soundsible-Work"):
        prepare_cohort(metadata, [seed, *route])
    coverage = {
        "candidates": len(available),
        "analysed": sum(bool(analysis.get("analysed")) for analysis in snapshots.values()),
        "cohort": len(cohort),
        "cohort_analysed": sum(bool(snapshots[id(item)].get("analysed")) for item in cohort),
        "bridges": sum(item.get("route_kind") == "bridge" for item in route),
    }
    # `empty_reason` is the only failure signal the route panel acts on, and
    # "exhausted" is terminal there: it stops the automatic retry and asks the
    # listener to press a button. Reserve it for a neighbourhood we actually
    # finished reading and found nothing in.
    if route:
        empty_reason = None
    elif degraded or warming:
        empty_reason = "temporary_failure"
    else:
        empty_reason = "exhausted"
    logger.info(
        "dj-plan session=%s segment=%d sources=%d candidates=%d unique=%d "
        "excluded=%d heard=%d cache_hit=%d cache_miss=%d warming=%s degraded=%s empty_reason=%s route=%d "
        "analysis_candidates=%d analysis_ready=%d analysis_cohort=%d analysis_cohort_ready=%d bridges=%d",
        data.get("session_id") or "-",
        segment_index,
        len(ordered_sources),
        len(candidates),
        len(unique),
        len(excluded),
        len(heard),
        cache_hit,
        cache_miss,
        warming,
        degraded,
        empty_reason,
        len(route),
        *coverage.values(),
    )
    return {
        "v": 6,
        "analysis_coverage": coverage,
        "plan_id": str(uuid.uuid4()),
        "intent": "auto_mode",
        "profile": "balanced",
        "source_profile": "balanced",
        "seed_identity": str(seed.get("id") or seed.get("youtube_id") or ""),
        "seed_analysis": analysis_summary(previous),
        **({"opening": {**opening, "analysis": analysis_summary(opening_analysis)}} if opening else {}),
        "items": [{**item, "analysis": analysis_summary(item["analysis"])} for item in route],
        "degraded": degraded,
        "warming": warming,
        "retry_after": music_candidates.AUTO_GRAPH_RETRY_AFTER_SEC if warming else None,
        "empty_reason": empty_reason,
        "direction_revision": data.get("direction_revision"),
        "pool_counts": {
            "local": sum(1 for item in unique.values() if item.get("source_pool") == "local"),
            "related": sum(1 for item in unique.values() if item.get("source_pool") == "related"),
            "discovery": 0,
        },
        "generated_at": int(time.time()),
        "session_id": data.get("session_id"),
        "segment_index": segment_index,
    }, 200


def occupied_keys(data: dict, items) -> set[str]:
    """Every key of the songs a bridge must not repeat: the seed, `items`, avoided ones.

    One recording has several identities: `music:track:<id>` from the
    library, `music:youtube:<id>` from the catalogue, its canonical artist and
    title. Comparing one of them let a requested song come back as its own
    bridge — the library copy of «Teardrops (Rules Remix)» before the
    catalogue one, a perfect mix into itself — and the browser showed it twice.
    """
    occupied = {str(value) for value in (data.get("exclude") or []) if value}
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    if seed:
        occupied |= music_candidates.candidate_keys(seed)
        parsed = music_set_item(seed, source_id="route", label="Route")
        if parsed:
            occupied |= music_candidates.candidate_keys(parsed)
    for item in items:
        occupied |= music_candidates.candidate_keys(item)
    return occupied


def place_bridge_pool(metadata, data: dict, occupied: set[str]) -> list[tuple[dict, dict]]:
    """Build one-hop bridges from explicit sources and heard music only."""
    source_roots = []
    sources = data.get("sources") if isinstance(data.get("sources"), list) else []
    for source in sources:
        if not isinstance(source, dict):
            continue
        tracks = source.get("tracks") if isinstance(source.get("tracks"), list) else []
        for raw in tracks:
            if not isinstance(raw, dict):
                continue
            item = music_set_item(
                raw,
                source_id=str(source.get("id") or "source"),
                label=str(source.get("label") or "Source"),
            )
            if item:
                source_roots.append(item)
    heard = data.get("exploration")
    if not isinstance(heard, list):
        heard = data.get("heard", []) if data.get("source_policy") != "explicit" else []
    if not isinstance(heard, list):
        heard = []
    heard_roots = []
    for raw in heard[-4:]:
        if not isinstance(raw, dict):
            continue
        item = music_set_item(raw, source_id="heard", label="Heard", weight=0.3)
        if item:
            heard_roots.append(item)
    def walk(roots: list[dict]) -> list[tuple[dict, dict]]:
        if not roots:
            return []
        related = list(music_candidates.context_related(metadata, roots[-8:], personalise=False).items)
        candidates = []
        for item in related:
            keys = music_candidates.candidate_keys(item)
            if not keys or keys & occupied or not song_sized(item):
                continue
            occupied.update(keys)
            candidates.append((item, item_analysis(metadata, item)))
            if len(candidates) >= 12:
                break
        return candidates

    return walk([*source_roots, *heard_roots])


def place_one(data: dict) -> tuple[dict, int]:
    """Plan one insertion; collection requests reuse the same scoring contract."""
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    raw_track = data.get("track") if isinstance(data.get("track"), dict) else {}
    raw_route = data.get("route") if isinstance(data.get("route"), list) else []
    requested_queue_id = str(data.get("requested_queue_id") or "").strip()
    if not seed or not raw_track or not requested_queue_id:
        return ({"error": "seed, track and requested_queue_id are required"}), 400
    # Older clients may still send dj_profile; technique selection is automatic.

    api = music_candidates.engine_api()
    lib = api["get_library"]()
    metadata = getattr(lib, "metadata", None)
    target = music_set_item(raw_track, source_id="route", label="Route")
    if not target:
        return ({"error": "track cannot be placed"}), 400
    target.update({
        "request_id": requested_queue_id,
        "reason": "Placed in route",
        "reason_code": "route_user",
    })
    target_analysis = item_analysis(metadata, target, schedule=True)

    # A listener-selected seam may sit beyond the automatic analysis horizon.
    # Score only its immediate neighbours, then translate the local insertion
    # back to the full route. Long collections must not invalidate that seam.
    before_queue_id = str(data.get("before_queue_id") or "").strip()
    route_offset = 0
    if before_queue_id:
        raw_index = next((index for index, row in enumerate(raw_route)
                          if isinstance(row, dict) and row.get("queue_id") == before_queue_id), None)
        if raw_index is None:
            return {"error": "before_queue_id is not in the editable route"}, 409
        if raw_index >= 16:
            seed = raw_route[raw_index - 1]
            route_offset = raw_index

    route: list[tuple[dict, dict]] = []
    horizon = raw_route[route_offset:route_offset + (1 if route_offset else 16)]
    for raw in horizon:
        if not isinstance(raw, dict):
            continue
        item = music_set_item(raw, source_id="route", label="Route")
        if not item:
            continue
        item["queue_id"] = str(raw.get("queue_id") or "")
        route.append((item, item_analysis(metadata, item)))
    occupied = occupied_keys(data, [target, *(item for item, _ in route)])

    fixed_index = next(
        (index for index, (item, _) in enumerate(route) if item.get("queue_id") == before_queue_id),
        None,
    ) if before_queue_id else None
    if before_queue_id and fixed_index is None:
        return ({"error": "before_queue_id is not in the editable route"}), 409
    bridge_pool = [] if fixed_index is not None or fixed_tempo() else place_bridge_pool(metadata, data, occupied)
    seed_analysis = item_analysis(metadata, seed, schedule=True)

    placement = choose_placement(seed_analysis, route, (target, target_analysis), bridge_pool,
                                 fixed_index=fixed_index)
    if placement is None:
        return ({"error": "route has no editable gap"}), 409
    insert_at, segment, following = placement
    items = []
    for row in segment:
        placed = dict(row)
        is_target = placed.get("request_id") == requested_queue_id
        placed["route_kind"] = "user" if is_target else "bridge"
        if not is_target:
            placed["owner_queue_id"] = requested_queue_id
        items.append(placed)
        item_analysis(metadata, placed, schedule=True)
    return ({
        "v": 1,
        "insert_at": route_offset + insert_at,
        "before_queue_id": route[insert_at][0].get("queue_id") if insert_at < len(route) else None,
        "requested_queue_id": requested_queue_id,
        "items": items,
        "following_transition": following,
        "degraded": not bool(target_analysis.get("analysed")),
    }), 200


def repair_anchor(raw: dict) -> dict:
    """A pinned song keeps its slot even when the planner cannot name it.

    Placement is free to skip a reference it cannot read; repair is not. The
    listener put this song where it is, so an unreadable reference becomes an
    opaque anchor with a conservative reading rather than a hole in their route.
    """
    item = music_set_item(raw, source_id="route", label="Route")
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
