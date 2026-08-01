"""Local Station bridge to the public Soundsible Community service."""

from __future__ import annotations

import os
from urllib.parse import urlparse

import requests
from flask import Blueprint, jsonify, request

from shared.community_identity import load_or_create_identity, signed_request
from shared.hardening import current_user, current_user_id_from_request, rate_limit

community_bp = Blueprint("community", __name__, url_prefix="")


def community_url() -> str:
    return (os.getenv("SOUNDSIBLE_COMMUNITY_URL") or "").strip().rstrip("/")


def _safe_error(response: requests.Response) -> tuple[dict, int]:
    try:
        payload = response.json()
    except Exception:
        payload = {"error": "Community service unavailable"}
    return payload if isinstance(payload, dict) else {"error": "Community request failed"}, response.status_code


def _remote(method: str, path: str, body: dict | None = None):
    base = community_url()
    if not base:
        return jsonify({"error": "Community is not configured", "code": "community_disabled"}), 503
    user_id = current_user_id_from_request()
    profile = current_user()
    if not user_id or not profile:
        return jsonify({"error": "Authentication required"}), 401

    payload = dict(body or {})
    payload["profile"] = {
        "display_name": profile.get("display_name") or profile.get("username") or "DJ",
        "avatar_color": profile.get("avatar_color"),
    }
    encoded, headers = signed_request(user_id, method, path, payload)
    try:
        response = requests.request(
            method,
            f"{base}{path}",
            data=encoded,
            headers=headers,
            timeout=(4, 12),
        )
    except requests.RequestException:
        return jsonify({"error": "Community service unavailable", "code": "community_unreachable"}), 502
    if not response.ok:
        payload, status = _safe_error(response)
        return jsonify(payload), status
    return jsonify(response.json()), response.status_code


@community_bp.get("/api/community/config")
@rate_limit("community_config", limit=120, window_sec=60)
def config():
    base = community_url()
    identity = None
    user_id = current_user_id_from_request()
    if base and user_id:
        public = load_or_create_identity(user_id)
        identity = {"community_id": public["community_id"]}
    return jsonify({
        "enabled": bool(base),
        "api_url": base or None,
        "identity": identity,
    })


@community_bp.post("/api/community/sessions")
@rate_limit("community_create", limit=12, window_sec=60)
def create_session():
    data = request.get_json(silent=True) or {}
    return _remote("POST", "/v1/sessions", {"title": str(data.get("title") or "")})


@community_bp.post("/api/community/sessions/<session_id>/resume")
@rate_limit("community_resume", limit=30, window_sec=60)
def resume_session(session_id: str):
    return _remote("POST", f"/v1/sessions/{session_id}/resume")


@community_bp.patch("/api/community/sessions/<session_id>")
@rate_limit("community_update", limit=30, window_sec=60)
def update_session(session_id: str):
    data = request.get_json(silent=True) or {}
    return _remote("PATCH", f"/v1/sessions/{session_id}", {"title": str(data.get("title") or "")})


@community_bp.delete("/api/community/sessions/<session_id>")
@rate_limit("community_end", limit=30, window_sec=60)
def end_session(session_id: str):
    return _remote("DELETE", f"/v1/sessions/{session_id}")


@community_bp.get("/api/community/open")
@rate_limit("community_open", limit=60, window_sec=60)
def open_community():
    """A constrained redirect target for native/open-in-browser affordances."""
    base = community_url()
    if not base:
        return jsonify({"error": "Community is not configured"}), 503
    parsed = urlparse(base)
    if parsed.scheme != "https" or not parsed.netloc:
        return jsonify({"error": "Community URL must use HTTPS"}), 503
    return jsonify({"url": base})
