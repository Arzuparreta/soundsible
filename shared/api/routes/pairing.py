"""
Pairing session and paired-device routes.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from flask import Blueprint, g, jsonify, request

from shared.database import DatabaseManager, instance_db
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
    return instance_db()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sqlite_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _session_response(record: dict) -> dict:
    connect = _pairing_connect_payload(record)
    return {
        "session_id": record["id"],
        "status": record["status"],
        "code": record["code"],
        "device_name": record.get("device_name"),
        "device_type": record.get("device_type"),
        "requested_scopes": record.get("requested_scopes") or [],
        "granted_scopes": record.get("granted_scopes") or [],
        "auto_confirm": bool(record.get("auto_confirm")),
        "display_active": bool(record.get("display_active")),
        "owner_confirmed_at": record.get("owner_confirmed_at"),
        "claimed_at": record.get("claimed_at"),
        "completed_at": record.get("completed_at"),
        "expires_at": record.get("expires_at"),
        "auth_token_id": record.get("auth_token_id"),
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
        "connect": connect,
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


def _base_urls() -> dict:
    from shared.api import get_active_endpoints
    from shared.runtime import get_runtime_config

    runtime = get_runtime_config()
    loopback_base_url = f"http://127.0.0.1:{runtime.port}"
    lan_base_urls: list[str] = []
    if runtime.lan_enabled or runtime.host not in {"127.0.0.1", "localhost"}:
        lan_base_urls = [f"http://{host}:{runtime.port}" for host in get_active_endpoints()]
    suggested_base_url = lan_base_urls[0] if lan_base_urls else None
    return {
        "loopback_base_url": loopback_base_url,
        "lan_base_urls": lan_base_urls,
        "suggested_base_url": suggested_base_url,
        "lan_enabled": runtime.lan_enabled,
    }


def _pairing_connect_payload(record: dict) -> dict:
    base_urls = _base_urls()
    suggested_base_url = base_urls["suggested_base_url"]
    claim_url = f"{suggested_base_url}/api/pairing/sessions/claim" if suggested_base_url else None
    player_url = f"{suggested_base_url}/player/" if suggested_base_url else None
    qr_payload = {
        "type": "soundsible_pairing",
        "version": 1,
        "code": record["code"],
        "claim_url": claim_url,
        "player_url": player_url,
    }
    return {
        **base_urls,
        "claim_path": "/api/pairing/sessions/claim",
        "player_path": "/player/",
        "claim_url": claim_url,
        "player_url": player_url,
        "presentable": bool(suggested_base_url),
        "qr_payload": qr_payload,
        "qr_text": json.dumps(qr_payload, separators=(",", ":")),
    }


def _caller_user_id():
    """Account behind this request. Pairing is per person, never instance-wide."""
    from shared.user_context import current_user_id

    return current_user_id()


def _own_session(session_id: str):
    """Fetch a pairing session only if it belongs to the caller."""
    session = _db().get_pairing_session(session_id)
    if not session:
        return None
    caller = _caller_user_id()
    owner = session.get("user_id")
    # Sessions created before accounts existed have no owner; they stay visible
    # while the instance still has a single account.
    if owner and caller and owner != caller:
        return None
    return session


def _mint_paired_device_token(*, session: dict) -> tuple[str, dict]:
    token = secrets.token_urlsafe(32)
    token_id = str(uuid.uuid4())
    record = _db().create_auth_token(
        token_id,
        _hash_token(token),
        kind="paired_device",
        scopes=session.get("granted_scopes") or list(PAIRING_DEFAULT_SCOPES),
        name=session.get("device_name") or "Paired device",
        device_type=session.get("device_type") or "phone",
        # The phone acts as whoever started the pairing, not as the admin.
        user_id=session.get("user_id"),
    )
    return token, record


def _confirm_session_with_new_token(session_id: str) -> tuple[str, dict, dict] | None:
    session = _db().get_pairing_session(session_id)
    if not session or session["status"] != "claimed":
        return None
    token, record = _mint_paired_device_token(session=session)
    completed = _db().confirm_pairing_session(session_id, auth_token_id=record["id"])
    if not completed:
        _db().revoke_auth_token(record["id"])
        return None
    return token, record, completed


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
    records = [
        _session_response(record)
        for record in _db().list_pairing_sessions(user_id=_caller_user_id())
    ]
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
    auto_confirm = bool(data.get("auto_confirm"))
    display_active = bool(data.get("display_active"))

    session_id = str(uuid.uuid4())
    code = _generate_pairing_code()
    expires_at = _sqlite_ts(_utc_now() + timedelta(seconds=ttl_sec))
    record = _db().create_pairing_session(
        session_id,
        code=code,
        requested_scopes=requested_scopes,
        granted_scopes=requested_scopes,
        expires_at=expires_at,
        auto_confirm=auto_confirm,
        display_active=display_active,
        user_id=_caller_user_id(),
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
    if claimed.get("auto_confirm") and claimed.get("display_active"):
        completed = _confirm_session_with_new_token(claimed["id"])
        if not completed:
            return jsonify({"error": "Pairing session could not be auto-confirmed"}), 409
        token, record, confirmed_session = completed
        return jsonify({
            "token": token,
            "paired_device": _paired_device_response(record),
            "session": _session_response(confirmed_session),
            "auto_confirmed": True,
        }), 201
    return jsonify(_session_response(claimed)), 200


@pairing_bp.route("/api/pairing/sessions/<session_id>/confirm", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_confirm", limit=20, window_sec=60)
def confirm_pairing_session(session_id: str):
    session = _own_session(session_id)
    if not session:
        return jsonify({"error": "Pairing session not found"}), 404
    if session["status"] != "claimed":
        return jsonify({"error": "Pairing session is not ready to confirm"}), 409

    completed = _confirm_session_with_new_token(session_id)
    if not completed:
        return jsonify({"error": "Pairing session could not be confirmed"}), 409
    token, record, confirmed_session = completed
    return jsonify({
        "token": token,
        "paired_device": _paired_device_response(record),
        "session": _session_response(confirmed_session),
    }), 201


@pairing_bp.route("/api/pairing/sessions/<session_id>/display-open", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_display_open", limit=30, window_sec=60)
def display_open_pairing_session(session_id: str):
    if not _own_session(session_id):
        return jsonify({"error": "Pairing session not found or already closed"}), 404
    data = request.get_json(silent=True) or {}
    auto_confirm = data.get("auto_confirm")
    if auto_confirm is not None:
        auto_confirm = bool(auto_confirm)
    session = _db().set_pairing_session_display_state(
        session_id,
        display_active=True,
        auto_confirm=auto_confirm,
    )
    if not session:
        return jsonify({"error": "Pairing session not found or already closed"}), 404
    return jsonify(_session_response(session)), 200


@pairing_bp.route("/api/pairing/sessions/<session_id>/display-close", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_display_close", limit=30, window_sec=60)
def display_close_pairing_session(session_id: str):
    if not _own_session(session_id):
        return jsonify({"error": "Pairing session not found or already closed"}), 404
    session = _db().set_pairing_session_display_state(
        session_id,
        display_active=False,
    )
    if not session:
        return jsonify({"error": "Pairing session not found or already closed"}), 404
    return jsonify(_session_response(session)), 200


@pairing_bp.route("/api/pairing/sessions/<session_id>/cancel", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("pairing_sessions_cancel", limit=20, window_sec=60)
def cancel_pairing_session(session_id: str):
    if not _own_session(session_id):
        return jsonify({"error": "Pairing session not found or already closed"}), 404
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
        for record in _db().list_auth_tokens(kind="paired_device", user_id=_caller_user_id())
        if record.get("revoked_at") is None
    ]
    return jsonify({"devices": tokens})


@pairing_bp.route("/api/paired-devices/<token_id>/revoke", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("paired_devices_revoke", limit=20, window_sec=60)
def revoke_paired_device(token_id: str):
    record = _db().get_auth_token(token_id)
    caller = _caller_user_id()
    if not record or record.get("kind") != "paired_device":
        return jsonify({"error": "Paired device not found"}), 404
    if record.get("user_id") and caller and record["user_id"] != caller:
        # Indistinguishable from a wrong id on purpose: revoking somebody
        # else's phone must not even confirm that it exists.
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
