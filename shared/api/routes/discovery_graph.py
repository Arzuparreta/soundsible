"""The YouTube discover graph: expand a seed into related videos, in the background.

`/api/discover/feed` answers from the persistent related-mix cache immediately
and schedules expansion for whatever is missing, streaming the result over
Socket.IO when it lands. Nothing here ever blocks a request on yt-dlp.
"""

from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor

from flask import jsonify, request

from shared.database import instance_db
from shared.discovery_intelligence import rank_recommendation_rows
from shared.hardening import rate_limit

from .discovery_bp import discovery_bp
from .discovery_common import _get_api

logger = logging.getLogger(__name__)

_DISCOVER_MAX_WORKERS = 2
_DISCOVER_RECS_PER_SEED = 25
_WARM_TOP_N = 20

_discover_executor: ThreadPoolExecutor | None = None
# Note: video_id → Future, shared between user requests and warming so the same
# seed is never extracted twice concurrently.
_discover_inflight: dict[str, "Future[None]"] = {}
_discover_inflight_lock = threading.Lock()
_discover_request_seeds: dict[str, set[str]] = {}


def _get_discover_executor() -> ThreadPoolExecutor:
    global _discover_executor
    if _discover_executor is None:
        _discover_executor = ThreadPoolExecutor(
            max_workers=_DISCOVER_MAX_WORKERS, thread_name_prefix="discover-expand"
        )
    return _discover_executor


def _resolve_seed_yt_id(track) -> str:
    """Resolve a library Track to a YouTube video id, using the persistent
    resolution cache. Returns '' if unresolvable."""
    yt = getattr(track, "youtube_id", None)
    if yt and len(str(yt)) == 11:
        return str(yt)
    artist = (getattr(track, "artist", "") or "").strip()
    title = (getattr(track, "title", "") or "").strip()
    if not artist or not title:
        return ""
    db = instance_db()
    cached = db.get_cached_resolution(artist, title)
    if cached and cached.get("id"):
        return str(cached["id"])
    # Note: Cold resolve — candidate search + best_candidate, then cache forever.
    try:
        api = _get_api()
        dl = api["get_downloader"](open_browser=False)
        raw = dl.downloader.search_match_candidates(artist, title, max_results=6)
        if not raw:
            db.set_cached_resolution(artist, title, {
                "id": "", "failure_state": "not_found", "confidence": 0.0,
            })
            return ""
        from shared.resolution_confidence import best_candidate
        best, _score, _reason, _ranked = best_candidate(
            artist, title, getattr(track, "duration", None), raw
        )
        vid = str(best.get("id", "") or "")
        db.set_cached_resolution(artist, title, {
            "id": vid,
            "duration": best.get("duration"),
            "thumbnail": best.get("thumbnail") or "",
            "webpage_url": best.get("webpage_url") or "",
            "channel": best.get("channel") or best.get("uploader") or "",
            "confidence": _score,
            "confidence_reason": _reason,
            "candidates": _ranked,
        })
        return vid
    except Exception as exc:
        logger.debug("discover: seed resolve failed for %s/%s: %s", artist, title, exc)
        return ""


def _expand_seed(
    video_id: str,
    request_id: str | None,
    seed_track_id: str | None,
    user_id: str | None,
) -> None:
    """Extract related-mix for one seed, persist it, and emit socketio if this
    was an async (user-requested) expansion. Errors are logged and swallowed —
    a failed seed just contributes no recs."""
    try:
        from shared.user_context import user_context

        with user_context(user_id):
            api = _get_api()
            dl = api["get_downloader"](open_browser=False)
            results = dl.downloader.get_related_videos(
                video_id, max_results=_DISCOVER_RECS_PER_SEED, enrich=False
            )
            instance_db().set_related_mix(video_id, results)
            if request_id and seed_track_id:
                mod = api["_mod"]
                sio = getattr(mod, "socketio", None)
                if sio is not None:
                    recs = (
                        rank_recommendation_rows(results, source="discover")
                        if user_id
                        else results
                    )
                    sio.emit("discover_seed_ready", {
                        "request_id": request_id,
                        "seed_track_id": seed_track_id,
                        "recs": recs,
                    })
    except Exception as exc:
        logger.debug("discover: expand failed for %s: %s", video_id, exc)
        # Note: Still emit an empty result so the client can mark this seed as
        # done rather than waiting forever.
        if request_id and seed_track_id:
            api = _get_api()
            sio = getattr(api["_mod"], "socketio", None)
            if sio is not None:
                sio.emit("discover_seed_ready", {
                    "request_id": request_id,
                    "seed_track_id": seed_track_id,
                    "recs": [],
                })


def _schedule_expand(video_id: str, request_id: str | None = None, seed_track_id: str | None = None) -> None:
    """Schedule a seed expansion if one isn't already in flight. Dedup is on
    video_id so a warming job and a user request for the same seed share one
    extraction. If an in-flight future exists, the new request_id is registered
    so the existing expansion's completion emits to it too."""
    with _discover_inflight_lock:
        existing = _discover_inflight.get(video_id)
        if existing is not None and not existing.done():
            if request_id and seed_track_id:
                _discover_request_seeds.setdefault(request_id, set()).add(seed_track_id)
            return
        from shared.user_context import current_user_id

        fut = _get_discover_executor().submit(
            _expand_seed,
            video_id,
            request_id,
            seed_track_id,
            current_user_id(),
        )
        _discover_inflight[video_id] = fut
        if request_id and seed_track_id:
            _discover_request_seeds.setdefault(request_id, set()).add(seed_track_id)


def _track_by_id(track_id: str):
    """Look up a track in the loaded library by id. Returns a Track or None."""
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    if not metadata:
        return None
    for t in (metadata.tracks or []):
        if t.id == track_id:
            return t
    return None


@discovery_bp.route("/api/discover/feed", methods=["GET"])
@rate_limit("discover_feed", limit=60, window_sec=60)
def discover_feed():
    """On-demand node feed: resolve seeds, return cache-hit recs immediately,
    schedule async expansion for misses, and stream results via socketio.

    Query params:
      seeds  comma-separated library track ids (the client's weighted sample)
      limit  max recs per seed (default 25)

    Response:
      {request_id, ready: [{seed_track_id, recs}], pending: [seed_track_id]}
    """
    raw = (request.args.get("seeds") or "").strip()
    seed_ids = [s for s in raw.split(",") if s.strip()]
    if not seed_ids:
        return jsonify({"request_id": "", "ready": [], "pending": []}), 400
    seed_ids = seed_ids[:20]  # cap
    limit = min(50, max(1, request.args.get("limit", _DISCOVER_RECS_PER_SEED, type=int)))
    request_id = str(uuid.uuid4())

    db = instance_db()
    ready: list[dict] = []
    pending: list[str] = []

    for tid in seed_ids:
        track = _track_by_id(tid)
        if track is None:
            continue
        vid = _resolve_seed_yt_id(track)
        if not vid:
            continue
        cached = db.get_related_mix(vid)
        if cached is not None:
            ready.append({
                "seed_track_id": tid,
                "recs": rank_recommendation_rows(cached, source="discover")[:limit],
            })
        else:
            pending.append(tid)
            _schedule_expand(vid, request_id=request_id, seed_track_id=tid)

    return jsonify({"request_id": request_id, "ready": ready, "pending": pending})


@discovery_bp.route("/api/discover/warm", methods=["POST"])
@rate_limit("discover_warm", limit=10, window_sec=60)
def discover_warm():
    """Pre-expand seeds into the persistent cache so the user's future Discover
    opens are instant. Fire-and-forget: returns immediately, expansion happens
    on the background pool. Called by the client on library_updated and by the
    server on startup.

    Body: {"seeds": ["trackId", ...]} — optional. If omitted or empty, the
    server auto-selects its top seeds (favourites + most-recent additions)."""
    data = request.get_json(silent=True) or {}
    seed_ids = data.get("seeds") or []
    if seed_ids is not None and not isinstance(seed_ids, list):
        return jsonify({"status": "error", "error": "seeds must be a list"}), 400
    if not seed_ids:
        # Note: Auto-select top seeds from the loaded library.
        warm_discover_top_seeds()
        return jsonify({"status": "scheduled", "warmed": -1})
    seed_ids = [str(s) for s in seed_ids if str(s).strip()][:_WARM_TOP_N]
    video_ids = []
    for tid in seed_ids:
        track = _track_by_id(tid)
        if track is None:
            continue
        vid = _resolve_seed_yt_id(track)
        if vid:
            video_ids.append(vid)

    already_cached = instance_db().get_related_mixes(video_ids)
    warmed = 0
    for vid in video_ids:
        if vid not in already_cached:
            _schedule_expand(vid)
            warmed += 1
    return jsonify({"status": "scheduled", "warmed": warmed})


def warm_discover_seeds(track_ids: list[str]) -> None:
    """Server-side warming entry point (no request context). Used at startup
    and after library sync. Resolves each track, checks the persistent cache,
    and schedules expansion for misses. Never blocks."""
    video_ids = []
    for tid in track_ids[:_WARM_TOP_N]:
        try:
            track = _track_by_id(tid)
            if track is None:
                continue
            vid = _resolve_seed_yt_id(track)
            if vid:
                video_ids.append(vid)
        except Exception as exc:
            logger.debug("discover warm: seed %s failed: %s", tid, exc)

    try:
        already_cached = instance_db().get_related_mixes(video_ids)
    except Exception as exc:
        logger.debug("discover warm: cache lookup failed: %s", exc)
        return
    for vid in video_ids:
        if vid not in already_cached:
            _schedule_expand(vid)


def _top_warm_seed_ids(limit: int = _WARM_TOP_N) -> list[str]:
    """Pick the most-likely seeds: favourites + most-recently-added library
    tracks (non-podcast). This mirrors the client's recency weighting so the
    warm set covers the client's probable picks."""
    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)
    if not metadata or not metadata.tracks:
        return []
    tracks = list(metadata.tracks)
    # Note: Filter out podcasts (no artist/title or marked as podcast).
    tracks = [t for t in tracks if t.artist and t.title]
    mod = api["_mod"]
    fav_ids = set(mod.favourite_library_ids())
    # Note: Favourites first, then newest additions. Favourites are the strongest
    # taste signal; recent additions are the most likely current picks.
    fav_tracks = [t for t in tracks if t.id in fav_ids]
    non_fav = [t for t in tracks if t.id not in fav_ids]
    # Note: metadata.tracks is oldest → newest; reverse for recency.
    non_fav.reverse()
    picked: list[str] = []
    seen: set[str] = set()
    for t in fav_tracks:
        if len(picked) >= limit:
            break
        if t.id not in seen:
            picked.append(t.id)
            seen.add(t.id)
    for t in non_fav:
        if len(picked) >= limit:
            break
        if t.id not in seen:
            picked.append(t.id)
            seen.add(t.id)
    return picked


def warm_discover_top_seeds() -> None:
    """Convenience wrapper: pick the top seeds from the library and warm them.
    Called at startup and on library_updated."""
    try:
        ids = _top_warm_seed_ids()
        if ids:
            warm_discover_seeds(ids)
    except Exception as exc:
        logger.debug("discover warm: top seeds failed: %s", exc)
