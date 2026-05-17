"""
Pairing session and paired-device routes.
"""

from __future__ import annotations

import hashlib
import secrets
import string
import uuid
from datetime import datetime, timedelta, timezone

from flask import Blueprint, g, jsonify, request

from shared.database import DatabaseManager
from shared.hardening import (
    SCOPE_ADMIN_CONFIG,
    SCOPE_DOWNLOAD_ADD,
    SCOPE_LIBRARY_READ,
    SCOPE_PLAYBACK_CONTROL,
    get_request_auth_context,
    rate_limit,
    require_scope,
)


pairing_bp = Blueprint("pairing", __name__, url_prefix="")

PAIRING_DEFAULT_SCOPES = [
    SCOPE_LIBRARY_READ,
    SCOPE_PLAYBACK_CONTROL,
]
PAIRING_OPTIONAL_SCOPES = {
    SCOPE_DOWNLOAD_ADD,
}
PAIRING_ALLOWED_SCOPES = set(PAIRING_DEFAULT_SCOPES) | PAIRING_OPTIONAL_SCOPES


def _db() -> DatabaseManager:
    return DatabaseManager()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sqlite_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _session_response(record: dict) -> dict:
    return {
        "session_id": record["id"],
        "status": record["status"],
        "code": record["code"],
        "device_name": record.get("device_name"),
        "device_type": record.get("device_type"),
        "requested_scopes": record.get("requested_scopes") or [],
        "granted_scopes": record.get("granted_scopes") or [],
        "owner_confirmed_at": record.get("owner_confirmed_at"),
        "claimed_at": record.get("claimed_at"),
        "completed_at": record.get("completed_at"),
        "expires_at": record.get("expires_at"),
        "auth_token_id": record.get("auth_token_id"),
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
    }


def _paired_device_response(record: dict) -> dict:
    return {
        "token_id": record["id"],
        "name": record.get("name"),
        "kind": record.get("kind"),
        "device_type": record.get("device_type"),
        "scopes": record.get("scopes") or [],
        "created_at": record.get("created_at"),
        "last_used_at": record.get("last_used_at"),
        "expires_at": record.get("expires_at"),
        "revoked_at": record.get("revoked_at"),
    }


def _requested_scopes_from_body(data: dict) -> list[str]:
    requested = data.get("scopes")
    if not isinstance(requested, list):
        return list(PAIRING_DEFAULT_SCOPES)
    scopes = [scope for scope in requested if scope in PAIRING_ALLOWED_SCOPES]
    if SCOPE_LIBRARY_READ not in scopes:
        scopes.append(SCOPE_LIBRARY_READ)
    if SCOPE_PLAYBACK_CONTROL not in scopes:
        scopes.append(SCOPE_PLAYBACK_CONTROL)
    return sorted(set(scopes))


def _generate_pairing_code(length: int = 8) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def require_pairing_scope(*required_scopes: str):
    def decorator(fn):
        def wrapped(*args, **kwargs):
            context = get_request_auth_context(allow_trusted_network=False)
            if not context:
                return jsonify({"error": "Pairing token required"}), 401
            granted = set(context.get("scopes") or [])
            if context.get("kind") not in {"paired_device", "owner"}:
                return jsonify({"error": "Paired device token required"}), 403
            if context.get("kind") != "owner" and not set(required_scopes).issubset(granted):
                return jsonify({"error": "Insufficient token scope", "required_scopes": list(required_scopes)}), 403
            g.paired_token = context.get("record") or {}
            return fn(*args, **kwargs)

        wrapped.__name__ = fn.__name__
        return wrapped

    return decorator


@pairing_bp.route("/api/pairing/sessions", methods=["GET"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_list", limit=60, window_sec=60)
def list_pairing_sessions():
    records = [_session_response(record) for record in _db().list_pairing_sessions()]
    return jsonify({"sessions": records})


@pairing_bp.route("/api/pairing/sessions", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_create", limit=20, window_sec=60)
def create_pairing_session():
    data = request.get_json(silent=True) or {}
    requested_scopes = _requested_scopes_from_body(data)
    expires_in_sec = data.get("expires_in_sec")
    try:
        ttl_sec = int(expires_in_sec) if expires_in_sec is not None else 300
    except (TypeError, ValueError):
        return jsonify({"error": "expires_in_sec must be an integer"}), 400
    ttl_sec = max(30, min(ttl_sec, 1800))

    session_id = str(uuid.uuid4())
    code = _generate_pairing_code()
    expires_at = _sqlite_ts(_utc_now() + timedelta(seconds=ttl_sec))
    record = _db().create_pairing_session(
        session_id,
        code=code,
        requested_scopes=requested_scopes,
        granted_scopes=requested_scopes,
        expires_at=expires_at,
    )
    return jsonify(_session_response(record)), 201


@pairing_bp.route("/api/pairing/sessions/claim", methods=["POST"])
@rate_limit("pairing_sessions_claim", limit=20, window_sec=60)
def claim_pairing_session():
    data = request.get_json(silent=True) or {}
    code = str(data.get("code") or "").strip().upper()
    device_name = str(data.get("device_name") or "").strip()
    device_type = str(data.get("device_type") or "phone").strip() or "phone"
    if not code:
        return jsonify({"error": "code is required"}), 400
    if not device_name:
        return jsonify({"error": "device_name is required"}), 400

    session = _db().get_pairing_session_by_code(code)
    if not session:
        return jsonify({"error": "Invalid or expired pairing code"}), 404
    if session["status"] != "pending":
        return jsonify({"error": "Pairing code is no longer available"}), 409

    claimed = _db().claim_pairing_session(
        session["id"],
        device_name=device_name,
        device_type=device_type,
    )
    if not claimed:
        return jsonify({"error": "Pairing code is no longer available"}), 409
    return jsonify(_session_response(claimed)), 200


@pairing_bp.route("/api/pairing/sessions/<session_id>/confirm", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_confirm", limit=20, window_sec=60)
def confirm_pairing_session(session_id: str):
    session = _db().get_pairing_session(session_id)
    if not session:
        return jsonify({"error": "Pairing session not found"}), 404
    if session["status"] != "claimed":
        return jsonify({"error": "Pairing session is not ready to confirm"}), 409

    token = secrets.token_urlsafe(32)
    token_id = str(uuid.uuid4())
    record = _db().create_auth_token(
        token_id,
        _hash_token(token),
        kind="paired_device",
        scopes=session.get("granted_scopes") or list(PAIRING_DEFAULT_SCOPES),
        name=session.get("device_name") or "Paired device",
        device_type=session.get("device_type") or "phone",
    )
    completed = _db().confirm_pairing_session(session_id, auth_token_id=token_id)
    if not completed:
        _db().revoke_auth_token(token_id)
        return jsonify({"error": "Pairing session could not be confirmed"}), 409
    return jsonify({
        "token": token,
        "paired_device": _paired_device_response(record),
        "session": _session_response(completed),
    }), 201


@pairing_bp.route("/api/pairing/sessions/<session_id>/cancel", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_cancel", limit=20, window_sec=60)
def cancel_pairing_session(session_id: str):
    session = _db().cancel_pairing_session(session_id)
    if not session:
        return jsonify({"error": "Pairing session not found or already closed"}), 404
    return jsonify(_session_response(session)), 200


@pairing_bp.route("/api/paired-devices", methods=["GET"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("paired_devices_list", limit=60, window_sec=60)
def list_paired_devices():
    tokens = [
        _paired_device_response(record)
        for record in _db().list_auth_tokens(kind="paired_device")
        if record.get("revoked_at") is None
    ]
    return jsonify({"devices": tokens})


@pairing_bp.route("/api/paired-devices/<token_id>/revoke", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("paired_devices_revoke", limit=20, window_sec=60)
def revoke_paired_device(token_id: str):
    record = _db().get_auth_token(token_id)
    if not record or record.get("kind") != "paired_device":
        return jsonify({"error": "Paired device not found"}), 404
    if record.get("revoked_at") is None:
        _db().revoke_auth_token(token_id)
        record = _db().get_auth_token(token_id) or record
    return jsonify(_paired_device_response(record)), 200


@pairing_bp.route("/api/pairing/verify", methods=["GET"])
@require_pairing_scope(SCOPE_LIBRARY_READ)
@rate_limit("pairing_verify", limit=60, window_sec=60)
def verify_paired_device():
    return jsonify({"valid": True, "token": g.paired_token})
