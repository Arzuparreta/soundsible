"""
Player and app config routes.
"""

import json

from flask import Blueprint, request, jsonify

from shared.models import PlayerConfig
from shared.hardening import rate_limit, require_instance_admin
from shared.runtime import get_config_dir

config_bp = Blueprint("config", __name__, url_prefix="")


def _get_api():
    from shared.api import get_core
    return {"get_core": get_core}


@config_bp.route("/api/config", methods=["GET"])
@require_instance_admin()
@rate_limit("config_get", limit=60, window_sec=60)
def get_config():
    api = _get_api()
    lib, _, _ = api["get_core"]()
    if lib.config:
        return jsonify(lib.config.to_dict())
    return jsonify({"error": "Config not found"}), 404


@config_bp.route("/api/config", methods=["POST"])
@require_instance_admin()
@rate_limit("config_update", limit=30, window_sec=60)
def update_config():
    data = request.json or {}
    config_path = get_config_dir() / "config.json"
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
    # Storage backend changed: every account's library manager holds a provider
    # built from this config, so drop them all and let them rebuild on demand.
    import shared.api as api_mod
    api_mod.reset_user_cores()
    return jsonify({"status": "updated"})


# The desktop shell paints its own first-run, loading and error screens, in its
# own origin (tauri://localhost) and before the engine exists — so it can read
# neither the player's localStorage nor this API when it needs the answer. What
# it can read is this file: shell and engine resolve the same config directory,
# and the shell already loads music_dir.json from it the same way.
#
# The player posts the whole colour table, not just its own colour, so the shell
# never holds a second copy of the palette and a new theme reaches it for free.
APPEARANCE_FILENAME = "theme.json"


@config_bp.route("/api/desktop/appearance", methods=["GET"])
@require_instance_admin()
@rate_limit("desktop_appearance_get", limit=60, window_sec=60)
def get_desktop_appearance():
    path = get_config_dir() / APPEARANCE_FILENAME
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return jsonify(json.load(handle))
    except (OSError, ValueError):
        return jsonify({"theme": None, "colors": {}})


@config_bp.route("/api/desktop/appearance", methods=["PUT"])
@require_instance_admin()
@rate_limit("desktop_appearance_put", limit=60, window_sec=60)
def update_desktop_appearance():
    data = request.json or {}
    theme = data.get("theme")
    colors = data.get("colors")
    if not isinstance(theme, str) or not theme:
        return jsonify({"error": "theme must be a non-empty string"}), 400
    if not isinstance(colors, dict) or not all(
        isinstance(name, str) and isinstance(value, str) for name, value in colors.items()
    ):
        return jsonify({"error": "colors must map theme names to colours"}), 400

    path = get_config_dir() / APPEARANCE_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"theme": theme, "colors": colors}, handle)
    return jsonify({"status": "updated"})
