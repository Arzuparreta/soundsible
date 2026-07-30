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
