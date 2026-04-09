"""
Player and app config routes.
"""

import json
from pathlib import Path

from flask import Blueprint, request, jsonify

from shared.constants import DEFAULT_CONFIG_DIR
from shared.models import PlayerConfig
from shared.hardening import require_admin, rate_limit

config_bp = Blueprint("config", __name__, url_prefix="")


def _get_api():
    from shared.api import get_core
    return {"get_core": get_core}


@config_bp.route("/api/config", methods=["GET"])
@require_admin(allow_trusted_network=True)
@rate_limit("config_get", limit=60, window_sec=60)
def get_config():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    if lib.config:
        return jsonify(lib.config.to_dict())
    return jsonify({"error": "Config not found"}), 404


@config_bp.route("/api/config", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("config_update", limit=30, window_sec=60)
def update_config():
    api = _get_api()
    data = request.json or {}
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        try:
            with open(config_path, "r") as f:
                existing = json.load(f)
            for k, v in data.items():
                if v is not None:
                    existing[k] = v
            data = existing
        except Exception:
            pass
    try:
        config = PlayerConfig.from_dict(data)
        with open(config_path, "w") as f:
            f.write(config.to_json())
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    import shared.api as api_mod
    api_mod.library_manager = None
    api_mod.get_core()
    return jsonify({"status": "updated"})
