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
    plan_transition,
)
from shared.hardening import rate_limit
from shared.providers import deezer

from shared import music_candidates, music_plan
from shared.dj import planning as dj_planning
from .discovery_bp import discovery_bp
from .discovery_feed import _build_discovery_feed_body, _deezer_artist_top_rows
from .discovery_graph import _resolve_seed_yt_id
from shared.dj.session import scoped as _dj_scoped
from shared import work
logger = logging.getLogger(__name__)


def _owns_analysis_work() -> bool:
    # Explicit work clients schedule their analysis through dj-work.
    return not request.headers.get("X-Soundsible-Work")


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
        payload, status = dj_planning.build_music_set_route(data, schedule=_owns_analysis_work())
        return jsonify(payload), status
    payload, status = dj_planning.build_legacy_route(
        data, build_plan=_build_music_plan, artist_candidates=_planner_artist_candidates,
        schedule=_owns_analysis_work(),
    )
    return jsonify(payload), status


@discovery_bp.route("/api/discovery/music/dj-place", methods=["POST"])
@rate_limit("discovery_music_dj_place", limit=90, window_sec=60)
@_dj_scoped
def discovery_music_dj_place():
    """Place songs in the current route without rebuilding existing occurrences."""
    data = request.get_json(silent=True) or {}
    requests = data.get("requests")
    if requests is None:
        body, status = dj_planning.place_one(data, schedule=_owns_analysis_work())
        return jsonify(body), status
    if not isinstance(requests, list) or not requests:
        return jsonify({"error": "requests must be a non-empty list"}), 400
    ids = [str(row.get("requested_queue_id") or "") for row in requests if isinstance(row, dict)]
    if len(ids) != len(requests) or not all(ids) or len(set(ids)) != len(ids):
        return jsonify({"error": "each request needs a unique requested_queue_id"}), 400
    route = list(data.get("route") or [])
    placements = []
    schedule = _owns_analysis_work()
    for requested in requests:
        result, status = dj_planning.place_one({**data, **requested, "route": route}, schedule=schedule)
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
    body, status = dj_planning.build_repair(data, schedule=_owns_analysis_work())
    return jsonify(body), status


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

    schedule = _owns_analysis_work()
    demand = work.current()
    if demand is not None and schedule:
        interested = getattr(demand, "tracks", {})
        interested.update({analysis_identity(item): dict(item) for item in (outgoing, incoming)})
        demand.tracks = interested

    api = music_candidates.engine_api()
    lib = api["get_library"]()
    metadata = getattr(lib, "metadata", None)

    out_analysis, out_ready = dj_planning.transition_analysis(metadata, outgoing, schedule=schedule)
    in_analysis, in_ready = dj_planning.transition_analysis(metadata, incoming, schedule=schedule)
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
