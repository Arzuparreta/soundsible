"""Smart TV device authorization routes.

A TV on the living-room screen creates a short-lived pending request, shows a
public short code and a QR linking to the station's approval screen, and holds
a high-entropy private redemption handle. A phone signs in on the station,
verifies the matching code and room name, and explicitly approves its own
account. The TV redeems with the private handle to receive an ordinary
revocable session cookie.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from flask import Blueprint, jsonify, make_response, request

from shared import station_addresses
from shared.api.origins import _is_same_origin
from shared.database import DatabaseManager, instance_db
from shared.hardening import (
    current_user_id_from_request,
    rate_limit,
    set_session_cookie,
)
from shared.users import UserError, create_session, get_user

tv_auth_bp = Blueprint("tv_auth", __name__, url_prefix="")

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
CODE_RE = re.compile(r"^[A-HJ-NP-Z2-9]{8}$")
DEFAULT_TV_AUTH_TTL_SEC = 300
MIN_TV_AUTH_TTL_SEC = 60
MAX_TV_AUTH_TTL_SEC = 600
POLL_INTERVAL_MS = 2000


def _db() -> DatabaseManager:
    return instance_db()


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sqlite_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def _format_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def _normalize_code(raw: object) -> str:
    if not isinstance(raw, str):
        return ""
    cleaned = re.sub(r"[\s-]+", "", raw.strip().upper())
    return cleaned if CODE_RE.match(cleaned) else ""


def _clean_device_name(raw: object) -> str:
    if isinstance(raw, str):
        cleaned = " ".join(raw.split()).strip()
        if cleaned:
            return cleaned[:128]
    return "Soundsible · TV"


def _approval_origin() -> str:
    host_origin = (request.host_url or "").rstrip("/")
    if host_origin:
        parsed = urlsplit(host_origin)
        host = (parsed.hostname or "").lower()
        if host not in {"127.0.0.1", "localhost", "::1", "[::1]"}:
            return host_origin
    base = station_addresses.base_urls()
    suggested = (base.get("suggested_base_url") or "").rstrip("/")
    if suggested:
        return suggested
    return host_origin or (base.get("loopback_base_url") or "").rstrip("/")


def _approve_url(formatted_code: str) -> tuple[str, str]:
    approve_path = "/player/#/tv-approve"
    origin = _approval_origin()
    if origin:
        return approve_path, f"{origin}{approve_path}?code={formatted_code}"
    return approve_path, f"{approve_path}?code={formatted_code}"


def _enforce_same_origin_csrf():
    if request.headers.get("X-Soundsible-CSRF") != "1":
        return jsonify({"error": "CSRF check failed", "code": "csrf_required"}), 403
    fetch_site = (request.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if fetch_site and fetch_site not in {"same-origin", "none"}:
        return jsonify({"error": "Cross-site request rejected", "code": "cross_origin_rejected"}), 403
    origin = (request.headers.get("Origin") or "").strip()
    if origin and not _is_same_origin(origin, request.environ):
        return jsonify({"error": "Cross-origin request rejected", "code": "cross_origin_rejected"}), 403
    referer = (request.headers.get("Referer") or "").strip()
    if referer:
        parts = urlsplit(referer)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            return jsonify({"error": "Cross-origin request rejected", "code": "cross_origin_rejected"}), 403
        ref_origin = f"{parts.scheme}://{parts.netloc}"
        if not _is_same_origin(ref_origin, request.environ):
            return jsonify({"error": "Cross-origin request rejected", "code": "cross_origin_rejected"}), 403
    return None


def _require_active_account():
    user_id = current_user_id_from_request()
    if not user_id:
        return None, (jsonify({"error": "Authentication required", "code": "login_required"}), 401)
    user = get_user(user_id)
    if not user or user.get("disabled"):
        return None, (jsonify({"error": "Account is not available", "code": "account_unavailable"}), 401)
    return user, None


@tv_auth_bp.route("/api/tv-auth/requests", methods=["POST"])
@rate_limit("tv_auth_create", limit=15, window_sec=60)
def create_tv_auth_request():
    data = request.get_json(silent=True) or {}
    device_name = _clean_device_name(data.get("device_name"))
    raw_ttl = data.get("expires_in_sec")
    if raw_ttl is None:
        ttl_sec = DEFAULT_TV_AUTH_TTL_SEC
    else:
        try:
            ttl_sec = int(raw_ttl)
        except (TypeError, ValueError):
            return jsonify({"error": "expires_in_sec must be an integer"}), 400
        ttl_sec = max(MIN_TV_AUTH_TTL_SEC, min(ttl_sec, MAX_TV_AUTH_TTL_SEC))

    expires_at = _sqlite_ts(_utc_now() + timedelta(seconds=ttl_sec))
    redemption_handle = secrets.token_urlsafe(32)
    handle_hash = _hash_secret(redemption_handle)

    record = None
    formatted_code = ""
    for _ in range(5):
        raw_code = _generate_code()
        code_hash = _hash_secret(raw_code)
        try:
            record = _db().create_tv_auth_request(
                uuid.uuid4().hex,
                code_hash=code_hash,
                handle_hash=handle_hash,
                device_name=device_name,
                expires_at=expires_at,
            )
            formatted_code = _format_code(raw_code)
            break
        except sqlite3.IntegrityError:
            continue

    if not record or not formatted_code:
        return jsonify({"error": "Could not allocate TV sign-in request"}), 500

    approve_path, approve_url = _approve_url(formatted_code)
    return (
        jsonify(
            {
                "code": formatted_code,
                "redemption_handle": redemption_handle,
                "device_name": record["device_name"],
                "expires_at": record["expires_at"],
                "expires_in_sec": ttl_sec,
                "poll_interval_ms": POLL_INTERVAL_MS,
                "approve_path": approve_path,
                "approve_url": approve_url,
            }
        ),
        201,
    )


@tv_auth_bp.route("/api/tv-auth/status", methods=["POST"])
@rate_limit("tv_auth_status", limit=60, window_sec=60)
def get_tv_auth_status():
    data = request.get_json(silent=True) or {}
    handle = str(data.get("redemption_handle") or "").strip()
    if not handle:
        return jsonify({"error": "redemption_handle is required"}), 400
    record = _db().get_tv_auth_request_by_handle_hash(_hash_secret(handle))
    if not record:
        return jsonify({"error": "Authorization request not found", "code": "not_found"}), 404
    return jsonify(
        {
            "status": record["status"],
            "device_name": record["device_name"],
            "expires_at": record["expires_at"],
        }
    )


@tv_auth_bp.route("/api/tv-auth/redeem", methods=["POST"])
@rate_limit("tv_auth_redeem", limit=20, window_sec=60)
def redeem_tv_auth_request():
    data = request.get_json(silent=True) or {}
    handle = str(data.get("redemption_handle") or "").strip()
    if not handle:
        return jsonify({"error": "redemption_handle is required"}), 400
    handle_hash = _hash_secret(handle)
    db = _db()
    record = db.get_tv_auth_request_by_handle_hash(handle_hash)
    if not record:
        return jsonify({"error": "Authorization request not found", "code": "not_found"}), 404
    status = record["status"]
    if status == "expired":
        return jsonify({"error": "Authorization request expired", "code": "expired"}), 410
    if status == "denied":
        return jsonify({"error": "Authorization request was denied", "code": "denied"}), 409
    if status == "cancelled":
        return jsonify({"error": "Authorization request was cancelled", "code": "cancelled"}), 409
    if status == "redeemed":
        return jsonify({"error": "Authorization request already redeemed", "code": "already_redeemed"}), 409
    if status != "approved":
        return jsonify({"error": "Authorization request is waiting for approval", "code": "pending"}), 409

    consumed = db.consume_tv_auth_request_by_handle_hash(handle_hash)
    if not consumed:
        return jsonify({"error": "Authorization request is no longer available", "code": "already_redeemed"}), 409

    user_id = consumed.get("approved_user_id")
    user = get_user(user_id) if user_id else None
    if not user_id or not user or user.get("disabled"):
        db.mark_tv_auth_cancelled(consumed["id"])
        return jsonify({"error": "Account is not available", "code": "account_unavailable"}), 409

    try:
        token, token_record = create_session(
            user_id,
            device_name=consumed["device_name"],
            device_type="web",
        )
    except UserError:
        db.mark_tv_auth_cancelled(consumed["id"])
        return jsonify({"error": "Account is not available", "code": "account_unavailable"}), 409

    db.attach_tv_auth_token(consumed["id"], token_record["id"])
    body = {"user": user, "device_name": consumed["device_name"]}
    return set_session_cookie(make_response(jsonify(body)), token), 201


@tv_auth_bp.route("/api/tv-auth/cancel", methods=["POST"])
@rate_limit("tv_auth_cancel", limit=30, window_sec=60)
def cancel_tv_auth_request():
    data = request.get_json(silent=True) or {}
    handle = str(data.get("redemption_handle") or "").strip()
    if not handle:
        return jsonify({"error": "redemption_handle is required"}), 400
    handle_hash = _hash_secret(handle)
    db = _db()
    cancelled = db.cancel_tv_auth_request_by_handle_hash(handle_hash)
    if cancelled:
        return jsonify({"status": "cancelled"})
    existing = db.get_tv_auth_request_by_handle_hash(handle_hash)
    if not existing:
        return jsonify({"error": "Authorization request not found", "code": "not_found"}), 404
    return jsonify({"status": existing["status"]})


def _resolve_pending_by_code():
    """Enforce CSRF + same-origin + active account and fetch a code record."""
    csrf_err = _enforce_same_origin_csrf()
    if csrf_err is not None:
        return None, None, None, csrf_err
    user, auth_err = _require_active_account()
    if auth_err is not None:
        return None, None, None, auth_err

    data = request.get_json(silent=True) or {}
    code = _normalize_code(data.get("code"))
    if not code:
        return None, None, None, (jsonify({"error": "Invalid TV code", "code": "not_found"}), 404)

    code_hash = _hash_secret(code)
    record = _db().get_tv_auth_request_by_code_hash(code_hash)
    if not record:
        return None, None, None, (jsonify({"error": "TV code not found", "code": "not_found"}), 404)
    if record["status"] == "expired":
        return None, None, None, (jsonify({"error": "TV code expired", "code": "expired"}), 410)
    if record["status"] != "pending":
        return None, None, None, (jsonify({"error": "TV code is no longer pending", "code": "not_pending"}), 409)
    return user, code, code_hash, record


@tv_auth_bp.route("/api/tv-auth/lookup", methods=["POST"])
@rate_limit("tv_auth_lookup", limit=20, window_sec=60)
def lookup_tv_auth_request():
    _, code, _, result = _resolve_pending_by_code()
    if code is None:
        return result
    return jsonify(
        {
            "code": _format_code(code),
            "device_name": result["device_name"],
            "status": result["status"],
            "expires_at": result["expires_at"],
        }
    )


@tv_auth_bp.route("/api/tv-auth/approve", methods=["POST"])
@rate_limit("tv_auth_decide", limit=20, window_sec=60)
def approve_tv_auth_request():
    user, code, code_hash, result = _resolve_pending_by_code()
    if code is None:
        return result
    approved = _db().approve_tv_auth_request_by_code_hash(code_hash, user_id=user["id"])
    if not approved:
        return jsonify({"error": "TV code is no longer available", "code": "not_pending"}), 409
    return jsonify(
        {
            "status": "approved",
            "device_name": approved["device_name"],
            "user": user,
        }
    )


@tv_auth_bp.route("/api/tv-auth/deny", methods=["POST"])
@rate_limit("tv_auth_decide", limit=20, window_sec=60)
def deny_tv_auth_request():
    _, code, code_hash, result = _resolve_pending_by_code()
    if code is None:
        return result
    denied = _db().deny_tv_auth_request_by_code_hash(code_hash)
    if not denied:
        return jsonify({"error": "TV code is no longer available", "code": "not_pending"}), 409
    return jsonify({"status": "denied"})
