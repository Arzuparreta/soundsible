"""
Deezer read-only proxy: browsers cannot call api.deezer.com directly (no CORS).
Station forwards allowlisted GET paths to Deezer and returns JSON unchanged.
"""

from __future__ import annotations

import logging
import re

import requests
from flask import Blueprint, Response, jsonify, request

from shared.hardening import rate_limit

logger = logging.getLogger(__name__)

discovery_bp = Blueprint("discovery", __name__, url_prefix="")

_DEEZER_HOST = "https://api.deezer.com"
_ALLOWED_PATH = re.compile(
    r"^(playlist/\d+|chart|search|track/\d+|artist/\d+/top)$"
)


@discovery_bp.route("/api/discovery/deezer/<path:deezer_path>", methods=["GET"])
@rate_limit("discovery_deezer", limit=120, window_sec=60)
def deezer_proxy(deezer_path: str):
    if not _ALLOWED_PATH.fullmatch(deezer_path):
        return jsonify({"error": "Unsupported Deezer path"}), 400
    upstream = f"{_DEEZER_HOST}/{deezer_path}"
    try:
        resp = requests.get(
            upstream,
            params=request.args,
            timeout=20,
            headers={"User-Agent": "SoundsibleDiscovery/1.0"},
        )
    except requests.RequestException as exc:
        logger.warning("Deezer proxy request failed: %s", exc)
        return jsonify({"error": "Deezer unreachable"}), 502

    ct = resp.headers.get("Content-Type", "application/json")
    return Response(resp.content, status=resp.status_code, content_type=ct)
