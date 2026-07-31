from __future__ import annotations

import os
from pathlib import Path

from dotenv import set_key
from flask import Blueprint, jsonify, request

from shared.hardening import rate_limit, require_instance_admin
from shared.lossless import get_lossless_service
from shared.lossless.providers import JamendoProvider
from shared.lossless.service import lossless_enabled

lossless_bp = Blueprint("lossless", __name__, url_prefix="")


@lossless_bp.route("/api/lossless/status", methods=["GET"])
@require_instance_admin()
@rate_limit("lossless_status", limit=60, window_sec=60)
def lossless_status():
    return jsonify(get_lossless_service().status())


@lossless_bp.route("/api/lossless/config", methods=["PATCH"])
@require_instance_admin()
@rate_limit("lossless_config", limit=20, window_sec=60)
def lossless_config():
    data = request.get_json(silent=True) or {}
    enabled = data.get("enabled")
    jamendo_client_id = data.get("jamendo_client_id")
    if enabled is None and jamendo_client_id is None:
        return jsonify({"error": "enabled or jamendo_client_id is required"}), 400
    if enabled is not None and not isinstance(enabled, bool):
        return jsonify({"error": "enabled must be a boolean"}), 400
    if jamendo_client_id is not None and not isinstance(jamendo_client_id, str):
        return jsonify({"error": "jamendo_client_id must be a string"}), 400
    if isinstance(jamendo_client_id, str) and len(jamendo_client_id.strip()) > 200:
        return jsonify({"error": "jamendo_client_id is too long"}), 400

    env_path = Path(__file__).resolve().parents[3] / "odst_tool" / ".env"
    env_path.parent.mkdir(parents=True, exist_ok=True)
    if not env_path.exists():
        env_path.touch()

    service = get_lossless_service()
    if enabled is not None:
        value = "true" if enabled else "false"
        set_key(str(env_path), "SOUNDSIBLE_LOSSLESS_UPGRADES", value)
        os.environ["SOUNDSIBLE_LOSSLESS_UPGRADES"] = value
        service.wake()
    if jamendo_client_id is not None:
        value = jamendo_client_id.strip()
        if value:
            try:
                if not JamendoProvider(client_id=value).validate():
                    return jsonify({"error": "Jamendo rejected this Client ID"}), 400
            except Exception:
                return jsonify({"error": "Jamendo could not validate this Client ID"}), 502
        set_key(str(env_path), "JAMENDO_CLIENT_ID", value)
        os.environ["JAMENDO_CLIENT_ID"] = value
        service.reload_providers()
    snapshot = service.status()
    return jsonify({
        "status": "updated",
        "enabled": lossless_enabled(),
        "jamendo_configured": any(
            row.get("name") == "jamendo" and row.get("available")
            for row in snapshot.get("providers", [])
        ),
    })


@lossless_bp.route("/api/lossless/run", methods=["POST"])
@require_instance_admin()
@rate_limit("lossless_run", limit=20, window_sec=60)
def lossless_run():
    """Start (or restart) an explicit run, idle gate and daily cap suspended."""
    data = request.get_json(silent=True) or {}
    recheck = bool(data.get("recheck"))
    service = get_lossless_service()
    requeued = service.start_manual(recheck=recheck)
    return jsonify({"status": "started", "requeued": requeued, **service.status()})


@lossless_bp.route("/api/lossless/pause", methods=["POST"])
@require_instance_admin()
@rate_limit("lossless_run", limit=20, window_sec=60)
def lossless_pause():
    service = get_lossless_service()
    changed = service.pause_manual()
    return jsonify({"status": "paused" if changed else "unchanged", **service.status()})


@lossless_bp.route("/api/lossless/resume", methods=["POST"])
@require_instance_admin()
@rate_limit("lossless_run", limit=20, window_sec=60)
def lossless_resume():
    service = get_lossless_service()
    changed = service.resume_manual()
    return jsonify({"status": "running" if changed else "unchanged", **service.status()})


@lossless_bp.route("/api/lossless/cancel", methods=["POST"])
@require_instance_admin()
@rate_limit("lossless_run", limit=20, window_sec=60)
def lossless_cancel():
    service = get_lossless_service()
    changed = service.cancel_manual()
    return jsonify({"status": "cancelled" if changed else "unchanged", **service.status()})
