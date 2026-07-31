from __future__ import annotations

import os
from pathlib import Path

from dotenv import set_key
from flask import Blueprint, jsonify, request

from shared.hardening import rate_limit, require_instance_admin
from shared.lossless import get_lossless_service
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
    if not isinstance(enabled, bool):
        return jsonify({"error": "enabled must be a boolean"}), 400

    value = "true" if enabled else "false"
    env_path = Path(__file__).resolve().parents[3] / "odst_tool" / ".env"
    env_path.parent.mkdir(parents=True, exist_ok=True)
    if not env_path.exists():
        env_path.touch()
    set_key(str(env_path), "SOUNDSIBLE_LOSSLESS_UPGRADES", value)
    os.environ["SOUNDSIBLE_LOSSLESS_UPGRADES"] = value

    service = get_lossless_service()
    service.wake()
    return jsonify({"status": "updated", "enabled": lossless_enabled()})


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
