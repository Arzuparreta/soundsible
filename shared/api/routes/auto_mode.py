"""Auto Mode: what to play next, and how to get there.

Two halves that share a candidate pool. The planner turns a seed into a ranked
queue drawn from the local library, the related-video graph and discovery; the
DJ engine orders those candidates by how well they mix and describes the
transition between each pair.
"""

from __future__ import annotations

import logging
from concurrent.futures import wait

from flask import jsonify, request

from shared.dj_engine import (
    analysis_identity,
    order_route,
    plan_transition,
)
from shared.dj.routes import (
    REPAIR_ROUTE_CAP as _DJ_REPAIR_ROUTE_CAP,
    choose_request_segment,
    repair_route,
)
from shared.hardening import rate_limit
from shared.listening_planner import (
    auto_source_sequence,
)
from shared.providers import deezer

from shared import music_candidates, music_plan
from shared.dj import planning as dj_planning
from .discovery_bp import discovery_bp
from .discovery_feed import _build_discovery_feed_body, _deezer_artist_top_rows
from .discovery_graph import _resolve_seed_yt_id
from shared.dj.session import scoped as _dj_scoped
from shared import work
logger = logging.getLogger(__name__)


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
            "cover": deezer.image(album_row, "cover"),
            "score": max(0.1, float(row.get("rank") or 0) / 1_000_000),
            "reason": f"More from {seed_artist}.",
            "reason_code": "seed_artist",
            "external_ids": {"deezer_id": str(row.get("id") or "")},
            # Catalog metadata: resolving the audio must not swap it for the uploader.
            "artist_is_channel": False,
            "deezer_artist_id": str(artist_row.get("id") or "") or None,
            "deezer_album_id": str(album_row.get("id") or "") or None,
        })
        if len(seeds) >= max(4, limit):
            break
    futures = {
        music_candidates.submit_resolution(music_candidates.resolve_artist_candidate, item, user_id): index
        for index, item in enumerate(seeds)
    }
    done, pending = wait(futures, timeout=8)
    if work.current() is None:
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
    return music_plan.build_music_plan(
        data, feed_body=_build_discovery_feed_body, resolve_seed_youtube_id=_resolve_seed_yt_id)


@discovery_bp.route("/api/discovery/music/plan", methods=["POST"])
@rate_limit("discovery_music_plan", limit=60, window_sec=60)
def discovery_music_plan():
    """Build the final generated queue order for every music continuation."""
    payload, status = _build_music_plan(request.get_json(silent=True) or {})
    return jsonify(payload), status


@discovery_bp.route("/api/discovery/music/dj-plan", methods=["POST"])
@rate_limit("discovery_music_dj_plan", limit=60, window_sec=60)
@_dj_scoped
def discovery_music_dj_plan():
    """Build a short transition-aware route exclusively for Auto Mode."""
    data = request.get_json(silent=True) or {}
    if isinstance(data.get("sources"), list):
        payload, status = dj_planning.build_music_set_route(data)
        return jsonify(payload), status
    # Older clients may still send dj_profile; technique selection is automatic.
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    if not seed:
        return jsonify({"error": "seed is required"}), 400
    try:
        requested_limit = min(8, max(3, int(data.get("limit") or 8)))
    except (TypeError, ValueError):
        return jsonify({"error": "limit must be numeric"}), 400
    source_profile = "balanced"
    base, status = _build_music_plan({
        "intent": "auto_mode",
        "profile": source_profile,
        "seed": seed,
        "context": data.get("context") or [],
        "session_id": data.get("session_id"),
        "segment_index": data.get("segment_index"),
        "exclude": data.get("exclude") or [],
        "limit": music_candidates.AUTO_ROUTER_LIMIT,
    })
    if status != 200:
        return jsonify(base), status

    api = music_candidates.engine_api()
    lib = api["get_library"]()
    metadata = getattr(lib, "metadata", None)
    seed_analysis = dj_planning.item_analysis(metadata, seed, schedule=True)
    candidates = []
    for candidate in base.get("items") or []:
        candidate_analysis = dj_planning.item_analysis(metadata, candidate)
        semantic_fit = max(0.0, min(1.0, float(candidate.get("semantic_score") or 0.5)))
        personal_fit = max(0.0, min(1.0, float(candidate.get("personal_score") or 0.5)))
        candidate["score"] = max(
            0.0,
            min(
                1.0,
                semantic_fit * 0.5
                + personal_fit * 0.15
                + float(candidate.get("score") or 0.5) * 0.05,
            ),
        )
        candidates.append((candidate, candidate_analysis))
    requests = [
        item
        for raw in (data.get("requests") if isinstance(data.get("requests"), list) else [])
        if isinstance(raw, dict) and (item := dj_planning.normalise_request(raw))
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
        measured_targets = [(target, dj_planning.item_analysis(metadata, target)) for target in targets]
        candidate_segment = choose_request_segment(previous, remaining, measured_targets,
                                                   max_starts=min(5, max_items - len(route)))
        if candidate_segment is None:
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
        segment, requested_analysis = candidate_segment
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
            limit=max_items - len(route),
            source_sequence=base.get("source_sequence") or auto_source_sequence(source_profile),
            source_offset=len(route),
        ))

    # Only the accepted route is allowed to schedule local analysis. External
    # previews are fetched by the existing browser runway prefetch, then refined
    # shortly before their handoff.
    for item in route:
        dj_planning.item_analysis(metadata, item, schedule=True)

    return jsonify({
        **base,
        "v": 4,
        "source_profile": source_profile,
        "seed_analysis": dj_planning.analysis_summary(seed_analysis),
        "items": [dj_planning.wire_item(item) for item in route],
        "requests": request_statuses,
    })


@discovery_bp.route("/api/discovery/music/dj-place", methods=["POST"])
@rate_limit("discovery_music_dj_place", limit=90, window_sec=60)
@_dj_scoped
def discovery_music_dj_place():
    """Place songs in the current route without rebuilding existing occurrences."""
    data = request.get_json(silent=True) or {}
    requests = data.get("requests")
    if requests is None:
        body, status = dj_planning.place_one(data)
        return jsonify(body), status
    if not isinstance(requests, list) or not requests:
        return jsonify({"error": "requests must be a non-empty list"}), 400
    ids = [str(row.get("requested_queue_id") or "") for row in requests if isinstance(row, dict)]
    if len(ids) != len(requests) or not all(ids) or len(set(ids)) != len(ids):
        return jsonify({"error": "each request needs a unique requested_queue_id"}), 400
    route = list(data.get("route") or [])
    placements = []
    for requested in requests:
        result, status = dj_planning.place_one({**data, **requested, "route": route})
        if status != 200:
            return jsonify(result), status
        # Give bridge occurrences identities that the browser can reproduce.
        for index, item in enumerate(result["items"]):
            item["queue_id"] = (result["requested_queue_id"] if item["route_kind"] == "user"
                                else f"{result['requested_queue_id']}:bridge:{index}")
        route[result["insert_at"]:result["insert_at"]] = result["items"]
        placements.append(result)
    return jsonify({"placements": placements}), 200


@discovery_bp.route("/api/discovery/music/dj-repair", methods=["POST"])
@rate_limit("discovery_music_dj_repair", limit=30, window_sec=60)
@_dj_scoped
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
    # Older clients may still send dj_profile; technique selection is automatic.
    raw_limit = data.get("limit")
    if raw_limit is not None and not isinstance(raw_limit, int):
        return jsonify({"error": "limit must be an integer"}), 400

    api = music_candidates.engine_api()
    lib = api["get_library"]()
    metadata = getattr(lib, "metadata", None)

    refs = [raw for raw in raw_route[:_DJ_REPAIR_ROUTE_CAP] if isinstance(raw, dict)]
    parsed: list[tuple[bool, dict, dict]] = []
    for raw in refs:
        pinned = str(raw.get("route_kind") or "generated").strip() == "user"
        item = dj_planning.repair_anchor(raw) if pinned else dj_planning.music_set_item(raw, source_id="route", label="Route")
        if not item:
            continue
        item["queue_id"] = str(raw.get("queue_id") or "")
        parsed.append((pinned, item, dj_planning.item_analysis(metadata, item)))
    if not parsed:
        return jsonify({"error": "route has nothing to repair"}), 400

    anchors = [(item, analysis) for pinned, item, analysis in parsed if pinned]
    spares = [(item, analysis) for pinned, item, analysis in parsed if not pinned]
    occupied = dj_planning.occupied_keys(data, [item for item, _ in (*anchors, *spares)])
    extra_pool = dj_planning.place_bridge_pool(metadata, data, occupied)
    seed_analysis = dj_planning.item_analysis(metadata, seed, schedule=True)
    target = min(_DJ_REPAIR_ROUTE_CAP, max(len(refs), int(raw_limit or len(refs))))
    built = repair_route(seed_analysis, parsed, extra_pool, target=target)

    for row in built:
        row["queue_id"] = row.get("queue_id") or None
        dj_planning.item_analysis(metadata, row, schedule=True)

    kept = {row["queue_id"] for row in built if row["queue_id"]}
    return jsonify({
        "v": 1,
        "seed_analysis": dj_planning.analysis_summary(seed_analysis),
        "items": [dj_planning.wire_item(row) for row in built],
        "dropped": [
            queue_id for raw in refs
            if (queue_id := str(raw.get("queue_id") or "")) and queue_id not in kept
        ],
        "degraded": any(not analysis.get("analysed") for _, analysis in anchors),
    }), 200


@discovery_bp.route("/api/discovery/music/dj-transition", methods=["POST"])
@rate_limit("discovery_music_dj_transition", limit=240, window_sec=60)
@_dj_scoped
def discovery_music_dj_transition():
    """Re-plan a single transition against whatever is now measured.

    The route endpoint answers immediately with conservative transitions for
    anything it has not measured yet. This is how those become real ones: the
    player asks again shortly before it commits a handoff, and if the background
    analysis has landed it gets the beatmatched plan instead of the fade. It is
    cache-only by design — it never triggers a decode, so it always returns fast.
    """
    data = request.get_json(silent=True) or {}
    # Older clients may still send dj_profile; technique selection is automatic.
    outgoing = data.get("from") if isinstance(data.get("from"), dict) else None
    incoming = data.get("to") if isinstance(data.get("to"), dict) else None
    if not outgoing or not incoming:
        return jsonify({"error": "from and to are required"}), 400

    demand = work.current()
    if demand is not None and not request.headers.get("X-Soundsible-Work"):
        interested = getattr(demand, "tracks", {})
        interested.update({analysis_identity(item): dict(item) for item in (outgoing, incoming)})
        demand.tracks = interested

    api = music_candidates.engine_api()
    lib = api["get_library"]()
    metadata = getattr(lib, "metadata", None)

    out_analysis, out_ready = dj_planning.transition_analysis(metadata, outgoing)
    in_analysis, in_ready = dj_planning.transition_analysis(metadata, incoming)
    return jsonify({
        "transition": plan_transition(out_analysis, in_analysis),
        "analysis": {"from": dj_planning.analysis_summary(out_analysis), "to": dj_planning.analysis_summary(in_analysis)},
        "measured": out_ready and in_ready,
    })


@discovery_bp.route("/api/discovery/music/dj-work", methods=["POST"])
@rate_limit("discovery_music_dj_work", limit=120, window_sec=60)
@_dj_scoped
def discovery_music_dj_work():
    data = request.get_json(silent=True) or {}
    demand = work.current()
    cancelled = data.get("cancel_request")
    if isinstance(cancelled, str):
        if not work._KEY.fullmatch(cancelled):
            return jsonify({"error": "invalid request id"}), 400
        demand.finish_request(cancelled)
        child = demand.children.pop(cancelled, None)
        if child is not None:
            child.close()
        return jsonify({"cancelled": True})
    if not data.get("active", True):
        demand.close()
        return jsonify({"active": False})
    tracks = data.get("tracks", [])
    if not isinstance(tracks, list) or len(tracks) > 64 or any(not isinstance(item, dict) for item in tracks):
        return jsonify({"error": "invalid runway"}), 400
    api = music_candidates.engine_api()
    lib = api["get_library"]()
    from shared.dj.session import sync
    if sync(tracks, data.get("revision", 0)):
        dj_planning.prepare_cohort(getattr(lib, "metadata", None), tracks)
    return jsonify({"active": True})
