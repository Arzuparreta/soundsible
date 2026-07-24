"""
Login, session, and account management routes.

`/api/auth/*` is what the player calls to find out who it is talking as;
`/api/users/*` is the admin surface for creating and retiring accounts.
"""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify, make_response, request

from shared.hardening import (
    current_user,
    current_user_id_from_request,
    rate_limit,
    require_instance_admin,
)
from shared.users import (
    ROLE_ADMIN,
    ROLE_MEMBER,
    SESSION_COOKIE_NAME,
    SESSION_TTL_DAYS,
    UserError,
    authenticate,
    create_invite,
    create_session,
    create_user,
    delete_user,
    get_user,
    instance_requires_login,
    list_invites,
    list_users,
    peek_invite,
    redeem_invite,
    revoke_invite,
    revoke_session_token,
    revoke_user_sessions,
    set_disabled,
    set_password,
    sole_passwordless_user,
    update_user,
    verify_password,
)

logger = logging.getLogger(__name__)

auth_bp = Blueprint("auth", __name__, url_prefix="")


def _set_session_cookie(response, token: str):
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=SESSION_TTL_DAYS * 24 * 3600,
        httponly=True,
        samesite="Lax",
        # Only pin to HTTPS when the request actually arrived over it — most
        # instances are plain HTTP on a LAN or Tailscale address.
        secure=bool(request.is_secure),
        path="/",
    )
    return response


def _invite_url(token: str) -> str:
    """Shareable link for an invitation.

    Prefers the address the admin is already using — on a Tailscale-only
    instance that is the tailnet address, which is the one the family can
    actually reach. Falls back to the engine's own view of its LAN address.
    """
    origin = (request.host_url or "").rstrip("/")
    if not origin:
        from shared.api.routes.pairing import _base_urls

        base = _base_urls()
        origin = (base.get("suggested_base_url") or base.get("loopback_base_url") or "").rstrip("/")
    return f"{origin}/player/#/invite/{token}"


def _auth_state() -> dict:
    return {
        "requires_login": instance_requires_login(),
        "user": current_user(),
    }


@auth_bp.route("/api/auth/state", methods=["GET"])
@rate_limit("auth_state", limit=120, window_sec=60)
def auth_state():
    """Public: tells the player whether to show a login screen."""
    return jsonify(_auth_state())


@auth_bp.route("/api/auth/me", methods=["GET"])
@rate_limit("auth_me", limit=120, window_sec=60)
def auth_me():
    user = current_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    return jsonify({"user": user, "requires_login": instance_requires_login()})


@auth_bp.route("/api/auth/login", methods=["POST"])
@rate_limit("auth_login", limit=10, window_sec=60)
def auth_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")

    if not username:
        # No username supplied is the passwordless single-account case.
        sole = sole_passwordless_user()
        if sole:
            token, _ = create_session(sole["id"], device_name=data.get("device_name"))
            return _set_session_cookie(make_response(jsonify({"user": sole})), token)
        return jsonify({"error": "Username is required"}), 400

    user = authenticate(username, password)
    if not user:
        logger.info("auth: failed login for %r from %s", username, request.remote_addr)
        return jsonify({"error": "Wrong username or password"}), 401

    token, _ = create_session(user["id"], device_name=data.get("device_name"))
    return _set_session_cookie(make_response(jsonify({"user": user})), token)


@auth_bp.route("/api/auth/logout", methods=["POST"])
@rate_limit("auth_logout", limit=30, window_sec=60)
def auth_logout():
    token = (request.cookies.get(SESSION_COOKIE_NAME) or "").strip()
    if token:
        revoke_session_token(token)
    response = make_response(jsonify({"status": "ok"}))
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return response


@auth_bp.route("/api/auth/profile", methods=["POST"])
@rate_limit("auth_profile", limit=20, window_sec=60)
def auth_update_profile():
    """Change your own name — display name and/or the username you log in with.

    Self-service, so no admin scope: it only ever touches the caller's own
    account. (The migrated account is named "owner"; nobody should be stuck
    with that.)
    """
    user_id = current_user_id_from_request()
    if not user_id:
        return jsonify({"error": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    try:
        user = update_user(
            user_id,
            display_name=data.get("display_name"),
            username=data.get("username"),
        )
    except UserError as e:
        return jsonify({"error": str(e)}), 400
    if user is None:
        return jsonify({"error": "Account not found"}), 404
    return jsonify({"user": user})


@auth_bp.route("/api/auth/password", methods=["POST"])
@rate_limit("auth_password", limit=10, window_sec=60)
def auth_change_password():
    """Change your own password. Requires the current one once you have one."""
    user_id = current_user_id_from_request()
    if not user_id:
        return jsonify({"error": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    me = get_user(user_id)
    if me and me["has_password"] and not verify_password(user_id, str(data.get("current_password") or "")):
        return jsonify({"error": "Current password is wrong"}), 403

    try:
        set_password(user_id, str(data.get("new_password") or ""), revoke_sessions=False)
    except UserError as e:
        return jsonify({"error": str(e)}), 400

    # The password just changed; hand this browser a fresh session and drop the rest.
    revoke_user_sessions(user_id)
    token, _ = create_session(user_id, device_name="Soundsible session")
    return _set_session_cookie(make_response(jsonify({"status": "ok", "user": get_user(user_id)})), token)


# ---------------------------------------------------------------------------
# Account management (admin only)
# ---------------------------------------------------------------------------


@auth_bp.route("/api/users", methods=["GET"])
@require_instance_admin()
@rate_limit("users_list", limit=60, window_sec=60)
def users_list():
    return jsonify({"users": list_users(), "requires_login": instance_requires_login()})


@auth_bp.route("/api/users", methods=["POST"])
@require_instance_admin()
@rate_limit("users_create", limit=20, window_sec=60)
def users_create():
    data = request.get_json(silent=True) or {}
    role = str(data.get("role") or ROLE_MEMBER)

    # Adding a second account turns the login screen on for everyone, so the
    # admin cannot be left passwordless and locked into an open instance.
    admin_id = current_user_id_from_request()
    admin = get_user(admin_id) if admin_id else None
    if admin and not admin["has_password"]:
        return jsonify({
            "error": "Set a password on your own account before adding people.",
            "code": "admin_password_required",
        }), 409

    try:
        user = create_user(
            str(data.get("username") or ""),
            password=data.get("password") or None,
            display_name=data.get("display_name"),
            role=role if role in (ROLE_ADMIN, ROLE_MEMBER) else ROLE_MEMBER,
            avatar_color=data.get("avatar_color"),
        )
    except UserError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"user": user, "requires_login": instance_requires_login()}), 201


@auth_bp.route("/api/users/<user_id>", methods=["PATCH"])
@require_instance_admin()
@rate_limit("users_update", limit=30, window_sec=60)
def users_update(user_id: str):
    data = request.get_json(silent=True) or {}
    try:
        if "disabled" in data:
            user = set_disabled(user_id, bool(data["disabled"]))
            if user is None:
                return jsonify({"error": "User not found"}), 404
        user = update_user(
            user_id,
            display_name=data.get("display_name"),
            avatar_color=data.get("avatar_color"),
            role=data.get("role"),
            username=data.get("username"),
        )
    except UserError as e:
        return jsonify({"error": str(e)}), 400
    if user is None:
        return jsonify({"error": "User not found"}), 404
    return jsonify({"user": user})


@auth_bp.route("/api/users/<user_id>/password", methods=["POST"])
@require_instance_admin()
@rate_limit("users_set_password", limit=20, window_sec=60)
def users_set_password(user_id: str):
    data = request.get_json(silent=True) or {}
    password = data.get("password")
    try:
        ok = set_password(user_id, str(password) if password is not None else None)
    except UserError as e:
        return jsonify({"error": str(e)}), 400
    if not ok:
        return jsonify({"error": "User not found"}), 404
    return jsonify({"status": "ok", "user": get_user(user_id), "requires_login": instance_requires_login()})


@auth_bp.route("/api/users/<user_id>/sessions", methods=["DELETE"])
@require_instance_admin()
@rate_limit("users_revoke_sessions", limit=30, window_sec=60)
def users_revoke_sessions(user_id: str):
    if not get_user(user_id):
        return jsonify({"error": "User not found"}), 404
    return jsonify({"status": "ok", "revoked": revoke_user_sessions(user_id)})


# ---------------------------------------------------------------------------
# Invitations
#
# The redemption endpoints are public by necessity — the person using them has
# no account yet. They reveal nothing about the instance: an invalid token and
# an expired one look the same, and a valid one only echoes back the display
# name the admin typed.
# ---------------------------------------------------------------------------


@auth_bp.route("/api/invites", methods=["GET"])
@require_instance_admin()
@rate_limit("invites_list", limit=60, window_sec=60)
def invites_list():
    return jsonify({"invites": list_invites()})


@auth_bp.route("/api/invites", methods=["POST"])
@require_instance_admin()
@rate_limit("invites_create", limit=20, window_sec=60)
def invites_create():
    data = request.get_json(silent=True) or {}

    admin_id = current_user_id_from_request()
    admin = get_user(admin_id) if admin_id else None
    if admin and not admin["has_password"]:
        return jsonify({
            "error": "Set a password on your own account before inviting people.",
            "code": "admin_password_required",
        }), 409

    role = str(data.get("role") or ROLE_MEMBER)
    try:
        token, invite = create_invite(
            role=role if role in (ROLE_ADMIN, ROLE_MEMBER) else ROLE_MEMBER,
            created_by=admin_id,
        )
    except UserError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"invite": invite, "token": token, "url": _invite_url(token)}), 201


@auth_bp.route("/api/invites/<invite_id>", methods=["DELETE"])
@require_instance_admin()
@rate_limit("invites_revoke", limit=20, window_sec=60)
def invites_revoke(invite_id: str):
    if not revoke_invite(invite_id):
        return jsonify({"error": "Invitation not found"}), 404
    return jsonify({"status": "ok"})


@auth_bp.route("/api/invites/<token>/preview", methods=["GET"])
@rate_limit("invites_peek", limit=30, window_sec=60)
def invites_peek(token: str):
    invite = peek_invite(token)
    if not invite:
        return jsonify({"valid": False}), 404
    return jsonify({"valid": True})


@auth_bp.route("/api/invites/<token>/accept", methods=["POST"])
@rate_limit("invites_accept", limit=10, window_sec=60)
def invites_accept(token: str):
    data = request.get_json(silent=True) or {}
    try:
        user = redeem_invite(
            token,
            username=str(data.get("username") or ""),
            password=str(data.get("password") or ""),
        )
    except UserError as e:
        return jsonify({"error": str(e)}), 400

    session_token, _ = create_session(user["id"], device_name=data.get("device_name"))
    logger.info("auth: invitation redeemed by %r", user["username"])
    return _set_session_cookie(make_response(jsonify({"user": user})), session_token), 201


@auth_bp.route("/api/users/<user_id>", methods=["DELETE"])
@require_instance_admin()
@rate_limit("users_delete", limit=10, window_sec=60)
def users_delete(user_id: str):
    if user_id == current_user_id_from_request():
        return jsonify({"error": "You cannot delete the account you are using."}), 400
    try:
        deleted = delete_user(user_id)
    except UserError as e:
        return jsonify({"error": str(e)}), 400
    if not deleted:
        return jsonify({"error": "User not found"}), 404
    return jsonify({"status": "ok", "requires_login": instance_requires_login()})
