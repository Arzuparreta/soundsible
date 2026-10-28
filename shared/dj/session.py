"""HTTP/session demand for DJ analysis and acquisition, never a second cache."""

from __future__ import annotations

from functools import wraps
import hashlib
import json
import uuid

from flask import jsonify, request

from shared import work
from shared.runtime import get_cache_dir


def scoped(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        raw = request.headers.get("X-Soundsible-Work")
        request_scope = None
        parent = None
        try:
            if raw:
                value = json.loads(raw)
                demand = work.owner(value["client"], value["epoch"])
                if request.path.startswith("/api/preview/") and "interests" in value:
                    from shared.url_utils import validate_youtube_video_id

                    ids, revision = value["interests"], value.get("revision")
                    if not isinstance(ids, list) or len(ids) > 64 or type(revision) is not int:
                        raise ValueError("invalid preview interest")
                    if revision >= getattr(demand, "interest_revision", -1):
                        demand.interest_revision = revision
                        demand.preview_keys = {str(vid) for vid in ids if validate_youtube_video_id(str(vid))}
                        demand.retain("preview-download", demand.preview_keys)
                        demand.retain("preview-resolve", demand.preview_keys)
            else:
                # Old clients cannot release explicitly. Their actual DJ calls
                # are a renewable, bounded demand, rather than an endless job.
                data = request.get_json(silent=True) or {}
                session = str(data.get("session_id") or uuid.uuid4().hex)
                demand = work.owner("legacy-" + hashlib.sha256(session.encode()).hexdigest(), 0)
            request_id = request.headers.get("X-Soundsible-Work-Request")
            if request_id:
                if not work._KEY.fullmatch(request_id) or request_id in demand.cancelled_requests:
                    raise work.WorkCancelled()
                child = demand.children.get(request_id)
                if child is None:
                    child = work.Owner((*demand.key, request_id), demand.epoch)
                    child.parent, child.path = demand, request.path
                    child.fingerprint = hashlib.sha256(
                        json.dumps(request.get_json(silent=True), sort_keys=True).encode()
                    ).hexdigest()
                    # An identical retry still needs the pending neighbourhood.
                    # Transfer its interests before retiring the old request;
                    # a changed route cancels the old work immediately.
                    for old_id, old in list(demand.children.items()):
                        if getattr(old, "path", None) == request.path:
                            if getattr(old, "fingerprint", None) == child.fingerprint:
                                with work._lock:
                                    for job in list(old.jobs):
                                        job.add(child)
                            old.close()
                            demand.finish_request(old_id)
                            demand.children.pop(old_id, None)
                    demand.children[request_id] = child
                parent, request_scope = demand, child
                demand = child
            with work.using(demand):
                warming = False
                try:
                    result = fn(*args, **kwargs)
                    if not request.path.endswith("dj-work"):
                        work.check()
                    response = result[0] if isinstance(result, tuple) else result
                    payload = response.get_json(silent=True) if hasattr(response, "get_json") else response
                    warming = isinstance(payload, dict) and payload.get("warming") is True and not payload.get("items")
                    return result
                finally:
                    if request_scope is not None:
                        if warming:
                            # These seeds answer the explicitly advertised retry.
                            # Unused source resolutions have no future consumer.
                            request_scope.retain("planner-resolution", set())
                        else:
                            request_scope.close()
                        parent.finish_request(request_id)
        except work.WorkCancelled:
            return jsonify({"error": "obsolete work", "code": "obsolete_work"}), 409
        except (ValueError, KeyError, TypeError):
            return jsonify({"error": "invalid work owner"}), 400

    return wrapped


def sync(metadata, tracks, revision):
    from shared.api.routes.auto_mode import _dj_prepare_cohort
    from shared.dj.store import analysis_identity

    demand = work.current()
    if demand is None:
        return
    previous = getattr(demand, "route_revision", -1)
    if type(revision) is not int or revision < previous:
        return
    demand.route_revision = revision
    demand.tracks = {analysis_identity(item): dict(item) for item in tracks}
    demand.retain("dj-analysis", set(demand.tracks))
    videos = {str(item.get("youtube_id") or item.get("id") or "") for item in tracks if not item.get("track_id")}
    demand.retain("preview-download", videos)
    demand.retain("preview-resolve", videos)
    _dj_prepare_cohort(metadata, tracks)


def preview_ready(video_id, path):
    """Only DJ sessions still needing these bytes may request analysis."""
    from shared.dj.store import request_analysis

    # The bounded owner registry is the demand index; no library/audio copies.
    with work._lock:
        owners = list(work._owners.values())
    for demand in owners:
        if not demand.active() or demand.key[0] != str(get_cache_dir()):
            continue
        for identity, item in list(getattr(demand, "tracks", {}).items()):
            if not item.get("track_id") and str(item.get("youtube_id") or item.get("id")) == video_id:
                try:
                    with work.using(demand):
                        request_analysis(path, identity, duration_hint=float(item.get("duration") or 0))
                except work.WorkCancelled:
                    continue
