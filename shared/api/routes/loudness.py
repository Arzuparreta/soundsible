"""Loudness measurement: progress, and jumping the queue for what plays next.

The measurements themselves are not served from here — they ride the library
payload the player already fetches (see `annotate_tracks`). These two routes are
the parts that need to be asked for: how far the sweep has got, and "I am about
to play these, please measure them now".
"""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from shared.hardening import rate_limit

logger = logging.getLogger(__name__)

loudness_bp = Blueprint("loudness", __name__, url_prefix="")

#: A queue lookahead, not a bulk import. Anything longer is not something the
#: listener is about to hear, and belongs to the ordinary sweep.
MAX_REQUEST_IDS = 25


@loudness_bp.route("/api/loudness/status", methods=["GET"])
@rate_limit("loudness_status", limit=60, window_sec=60)
def loudness_status():
    from shared.loudness import get_loudness_service

    try:
        return jsonify(get_loudness_service().status())
    except Exception:
        logger.debug("Loudness: status unavailable", exc_info=True)
        return jsonify({"enabled": False, "activity": "unavailable"})


@loudness_bp.route("/api/loudness/request", methods=["POST"])
@rate_limit("loudness_request", limit=60, window_sec=60)
def loudness_request():
    """Measure these tracks ahead of the sweep — the player is nearly there.

    Fire-and-forget by design: the player never waits on this, and a track that
    is not measured in time simply plays at unity gain and is levelled the next
    time round. Nothing here can delay playback.
    """
    data = request.get_json(silent=True) or {}
    ids = data.get("track_ids")
    if not isinstance(ids, list):
        return jsonify({"error": "track_ids must be a list"}), 400
    wanted = [str(i) for i in ids if isinstance(i, (str, int)) and str(i)][:MAX_REQUEST_IDS]
    if not wanted:
        return jsonify({"queued": 0})

    try:
        from shared.loudness import get_loudness_service

        get_loudness_service().request(wanted)
    except Exception:
        logger.debug("Loudness: could not queue priority measurements", exc_info=True)
        return jsonify({"queued": 0})
    return jsonify({"queued": len(wanted)})
