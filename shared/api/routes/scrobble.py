"""Scrobbling settings: which services an account reports its plays to.

Nothing here records a play. Plays are found in the playback state clients
already publish (``PUT /api/playback/state``) and in OpenSubsonic ``scrobble``
calls; these routes only connect, pause and disconnect the services they go to.

A service token is accepted here and never returned: the status says who an
account is connected as, not with what.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from shared.hardening import rate_limit, request_is_admin_user, require_instance_admin
from shared.scrobble import SERVICES, ScrobbleError, get_scrobble_service
from shared.user_context import current_user_id

scrobble_bp = Blueprint("scrobble", __name__, url_prefix="")


def _status(user_id: str):
    return jsonify(get_scrobble_service().status(user_id, admin=request_is_admin_user()))


def _for_account(action):
    """Run ``action(service, user_id)`` for the caller and answer with the new status."""
    user_id = current_user_id()
    if not user_id:
        return jsonify({"error": "Not authenticated"}), 401
    try:
        action(get_scrobble_service(), user_id)
    except ScrobbleError as error:
        return jsonify({"error": error.code}), error.status
    return _status(user_id)


@scrobble_bp.route("/api/scrobble", methods=["GET"])
@rate_limit("scrobble_status", limit=120, window_sec=60)
def scrobble_status():
    return _for_account(lambda service, user_id: None)


@scrobble_bp.route("/api/scrobble/listenbrainz", methods=["PUT"])
@rate_limit("scrobble_connect", limit=10, window_sec=60)
def scrobble_connect_listenbrainz():
    data = request.get_json(silent=True) or {}
    admin = request_is_admin_user()
    return _for_account(
        lambda service, user_id: service.connect_listenbrainz(
            user_id, data.get("token"), data.get("server"), admin=admin
        )
    )


@scrobble_bp.route("/api/scrobble/maloja", methods=["PUT"])
@rate_limit("scrobble_connect", limit=10, window_sec=60)
def scrobble_connect_maloja():
    data = request.get_json(silent=True) or {}
    admin = request_is_admin_user()
    return _for_account(
        lambda service, user_id: service.connect_maloja(user_id, data.get("server"), data.get("token"), admin=admin)
    )


@scrobble_bp.route("/api/scrobble/lastfm/authorize", methods=["POST"])
@rate_limit("scrobble_connect", limit=10, window_sec=60)
def scrobble_lastfm_authorize():
    """Begin connecting Last.fm; the answer carries the page to open."""
    user_id = current_user_id()
    if not user_id:
        return jsonify({"error": "Not authenticated"}), 401
    try:
        url = get_scrobble_service().lastfm_authorize(user_id)
    except ScrobbleError as error:
        return jsonify({"error": error.code}), error.status
    return jsonify({"url": url})


@scrobble_bp.route("/api/scrobble/lastfm/complete", methods=["POST"])
@rate_limit("scrobble_lastfm_complete", limit=60, window_sec=60)
def scrobble_lastfm_complete():
    return _for_account(lambda service, user_id: service.lastfm_complete(user_id))


@scrobble_bp.route("/api/scrobble/lastfm/app", methods=["PUT"])
@require_instance_admin()
@rate_limit("scrobble_lastfm_app", limit=10, window_sec=60)
def scrobble_lastfm_app_set():
    """The Last.fm API account every listener on this instance connects through."""
    data = request.get_json(silent=True) or {}
    return _for_account(lambda service, user_id: service.set_lastfm_app(data.get("api_key"), data.get("api_secret")))


@scrobble_bp.route("/api/scrobble/lastfm/app", methods=["DELETE"])
@require_instance_admin()
@rate_limit("scrobble_lastfm_app", limit=10, window_sec=60)
def scrobble_lastfm_app_clear():
    return _for_account(lambda service, user_id: service.clear_lastfm_app())


def _known(service_name: str):
    if service_name not in SERVICES:
        return jsonify({"error": "unknown_service"}), 404
    return None


@scrobble_bp.route("/api/scrobble/<service_name>", methods=["PATCH"])
@rate_limit("scrobble_update", limit=60, window_sec=60)
def scrobble_update(service_name: str):
    """Pause or resume one service without disconnecting it."""
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get("enabled"), bool):
        return jsonify({"error": "enabled must be boolean"}), 400
    return _known(service_name) or _for_account(
        lambda service, user_id: service.set_enabled(user_id, service_name, data["enabled"])
    )


@scrobble_bp.route("/api/scrobble/<service_name>", methods=["DELETE"])
@rate_limit("scrobble_update", limit=60, window_sec=60)
def scrobble_disconnect(service_name: str):
    """Forget the token and drop whatever was still waiting to be sent there."""
    return _known(service_name) or _for_account(lambda service, user_id: service.disconnect(user_id, service_name))


@scrobble_bp.route("/api/scrobble/<service_name>/retry", methods=["POST"])
@rate_limit("scrobble_retry", limit=20, window_sec=60)
def scrobble_retry(service_name: str):
    return _known(service_name) or _for_account(lambda service, user_id: service.retry_now(user_id, service_name))

