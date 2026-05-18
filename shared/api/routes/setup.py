"""
First-run / setup helpers: music library folder (persisted + live runtime update).
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from flask import Blueprint, jsonify, request

from shared.hardening import SCOPE_ADMIN_CONFIG, rate_limit, require_scope
from shared.runtime import (
    configure_runtime,
    get_config_dir,
    get_runtime_config,
    load_persisted_music_dir,
    runtime_with_overrides,
    save_persisted_music_dir,
)
from shared.security import is_safe_path

setup_bp = Blueprint("setup", __name__, url_prefix="")


def _env_music_dir_active() -> bool:
    return bool((os.environ.get("SOUNDSIBLE_MUSIC_DIR") or "").strip())


def _effective_source() -> str:
    if _env_music_dir_active():
        return "env"
    if load_persisted_music_dir(get_config_dir()) is not None:
        return "persisted"
    return "default"


def _resolve_music_dir(raw: str) -> Path:
    text = (raw or "").strip()
    if not text:
        raise ValueError("music_dir is required")
    path = Path(text).expanduser().resolve()
    if not is_safe_path(str(path), is_trusted=False):
        raise ValueError("Path is not allowed for the music library")
    if path.exists() and not path.is_dir():
        raise ValueError("Path exists and is not a directory")
    path.mkdir(parents=True, exist_ok=True)
    return path


@setup_bp.route("/api/setup/music-dir", methods=["GET"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("setup_music_dir_get", limit=60, window_sec=60)
def get_music_dir_setting():
    runtime = get_runtime_config()
    cfg = get_config_dir()
    persisted = load_persisted_music_dir(cfg)
    return jsonify(
        {
            "music_dir": str(runtime.music_dir),
            "persisted_path": str(persisted) if persisted is not None else None,
            "effective_source": _effective_source(),
            "env_override": _env_music_dir_active(),
        }
    )


@setup_bp.route("/api/setup/music-dir", methods=["POST"])
@require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=True)
@rate_limit("setup_music_dir_post", limit=20, window_sec=60)
def post_music_dir_setting():
    from shared.telemetry import emit

    data = request.json or {}
    raw = data.get("music_dir") or data.get("path")
    try:
        resolved = _resolve_music_dir(str(raw))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    cfg_dir = get_config_dir()
    save_persisted_music_dir(cfg_dir, resolved)
    runtime = runtime_with_overrides(music_dir=resolved)
    configure_runtime(runtime)

    try:
        from shared.desktop_runtime import write_runtime_state

        if runtime.owner_token_file:
            write_runtime_state(
                runtime,
                version=os.getenv("SOUNDSIBLE_VERSION", "0.0.0-dev"),
            )
    except Exception:
        pass

    emit(
        "setup",
        {
            "v": 1,
            "event": "setup_music_dir_saved",
            "ts": int(time.time()),
            "env_override": _env_music_dir_active(),
        },
    )

    return jsonify(
        {
            "status": "updated",
            "music_dir": str(resolved),
            "effective_source": _effective_source(),
            "env_override": _env_music_dir_active(),
        }
    )
