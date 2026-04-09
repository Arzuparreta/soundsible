"""
Downloader queue, YouTube search, discover, and downloader config routes.
"""

import hashlib
import json
import logging
from pathlib import Path

from flask import Blueprint, request, jsonify

from shared.text_utils import sanitize_cli_message
from shared.hardening import require_admin, rate_limit

logger = logging.getLogger(__name__)

downloader_bp = Blueprint("downloader", __name__, url_prefix="")


def _get_api():
    from shared.api import (
        get_core,
        get_downloader,
        queue_manager_dl,
        process_queue_background,
        parse_intake_item,
        is_trusted_network,
        downloader_service,
    )
    return {
        "get_core": get_core,
        "get_downloader": get_downloader,
        "queue_manager_dl": queue_manager_dl,
        "process_queue_background": process_queue_background,
        "parse_intake_item": parse_intake_item,
        "is_trusted_network": is_trusted_network,
        "downloader_service": downloader_service,
    }


@downloader_bp.route("/api/downloader/youtube/search", methods=["GET"])
def youtube_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"results": []})
    limit = min(20, max(1, request.args.get("limit", 10, type=int)))
    source = (request.args.get("source") or "ytmusic").strip().lower()
    # Note: Canonical ytmusic, youtube. support 'music' as legacy alias for ytmusic.
    use_ytmusic = (source in ("ytmusic", "music"))
    try:
        dl = _get_api()["get_downloader"](open_browser=False)
        results = dl.downloader.search_youtube(q, max_results=limit, use_ytmusic=use_ytmusic)
        return jsonify({"results": results})
    except Exception as e:
        logger.warning("API: YouTube search error: %s", e)
        return jsonify({"results": [], "error": sanitize_cli_message(str(e))}), 500


@downloader_bp.route("/api/downloader/youtube/suggest", methods=["GET"])
def youtube_suggest():
    import requests
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"suggestions": []})
    
    url = "http://suggestqueries.google.com/complete/search"
    # Note: Using 'firefox' client ensures we get a pure JSON array instead of JSONP
    params = {
        "client": "firefox",
        "ds": "yt", # Note: 'yt' for general YouTube search suggestions
        "q": q,
        "oe": "utf-8"
    }
    try:
        # Note: This API returns a simple array: ["query", ["suggestion1", "suggestion2", ...], ...]
        resp = requests.get(url, params=params, timeout=2)
        if resp.ok:
            try:
                data = resp.json()
                if isinstance(data, list) and len(data) > 1:
                    return jsonify({"suggestions": data[1]})
            except Exception as json_err:
                logger.warning("API: Suggest JSON parse error: %s (Response: %s)", json_err, resp.text[:100])
        return jsonify({"suggestions": []})
    except Exception as e:
        logger.warning("API: Suggest network/other error: %s", e)
        return jsonify({"suggestions": []})


@downloader_bp.route("/api/downloader/queue", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_queue_add", limit=100, window_sec=60)
def add_to_downloader_queue():
    api = _get_api()
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No JSON data received"}), 400
        items = data.get("items", [])
        added_ids = []
        accepted = []
        rejected = []
        for idx, item in enumerate(items):
            parsed, err = api["parse_intake_item"](item)
            if err:
                rejected.append({"index": idx, "reason": err, "item": item})
                continue
            parsed["intake_source"] = parsed.get("source_type")
            parsed["intake_payload_hash"] = hashlib.sha256(
                json.dumps(parsed, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()
            new_item = api["queue_manager_dl"].add(parsed)
            added_ids.append(new_item["id"])
            accepted.append({"index": idx, "id": new_item["id"], "source_type": parsed.get("source_type")})
        status = "queued" if accepted else "error"
        code = 200 if accepted else 400
        return jsonify({"status": status, "ids": added_ids, "accepted": accepted, "rejected": rejected}), code
    except Exception as e:
        logger.warning("API: Queue Add Error: %s", e)
        return jsonify({"status": "error", "message": str(e)}), 500


@downloader_bp.route("/api/downloader/queue/status", methods=["GET"])
def get_downloader_status():
    api = _get_api()
    q = api["queue_manager_dl"]
    return jsonify({"is_processing": q.is_processing, "queue": q.queue, "logs": q.log_buffer})


@downloader_bp.route("/api/downloader/queue/<item_id>", methods=["DELETE"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_queue_remove", limit=100, window_sec=60)
def remove_from_downloader_queue(item_id):
    api = _get_api()
    api["queue_manager_dl"].remove_item(item_id)
    return jsonify({"status": "removed"})


@downloader_bp.route("/api/downloader/queue", methods=["DELETE"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_queue_clear", limit=30, window_sec=60)
def clear_downloader_queue():
    api = _get_api()
    api["queue_manager_dl"].clear_queue()
    return jsonify({"status": "cleared"})


@downloader_bp.route("/api/downloader/start", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_start", limit=30, window_sec=60)
def trigger_downloader():
    import threading
    api = _get_api()
    if not api["queue_manager_dl"].is_processing:
        logger.info("API: [Queue] Start download requested, starting background processor.")
        threading.Thread(target=api["process_queue_background"], daemon=True).start()
        return jsonify({"status": "started"})
    return jsonify({"status": "already_running"})


@downloader_bp.route("/api/downloader/optimize", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_optimize", limit=10, window_sec=300)
def trigger_downloader_optimize():
    import threading
    from shared.api import run_optimization_task
    dry_run = request.json.get("dry_run", True)
    threading.Thread(target=run_optimization_task, args=(dry_run,), daemon=True).start()
    return jsonify({"status": "started"})


@downloader_bp.route("/api/downloader/sync", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_sync", limit=10, window_sec=300)
def trigger_downloader_sync():
    import threading
    from shared.api import run_sync_task
    threading.Thread(target=run_sync_task, daemon=True).start()
    return jsonify({"status": "started"})


@downloader_bp.route("/api/download", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_legacy_download", limit=60, window_sec=60)
def start_download_legacy():
    import threading
    api = _get_api()
    data = request.json
    url = data.get("url")
    if url:
        api["queue_manager_dl"].add({"song_str": url})
        if not api["queue_manager_dl"].is_processing:
            threading.Thread(target=api["process_queue_background"], daemon=True).start()
        return jsonify({"status": "started"})
    return jsonify({"error": "No URL provided"}), 400


@downloader_bp.route("/api/downloader/config", methods=["GET"])
def get_downloader_config():
    api = _get_api()
    is_trusted = api["is_trusted_network"](request.remote_addr)
    from dotenv import dotenv_values
    # Note: Resolve .env from the project root so config and startup use the same file regardless of CWD.
    env_path = Path(__file__).resolve().parents[3] / "odst_tool" / ".env"
    env_vars = {}
    if env_path.exists():
        env_vars = dotenv_values(env_path)

    def mask(s):
        if not s:
            return ""
        if len(s) <= 8:
            return "****"
        return f"{s[:4]}...{s[-4:]}****"

    auto_update = (env_vars.get("YTDLP_AUTO_UPDATE", "") or "false").strip().lower() in ("true", "1")
    output_dir_fallback = env_vars.get("OUTPUT_DIR", str(Path.home() / "Music" / "Soundsible"))
    dl = api["get_downloader"]()
    config = {
        "output_dir": str(dl.output_dir) if dl else output_dir_fallback,
        "quality": env_vars.get("DEFAULT_QUALITY", "high"),
        "r2_account_id": env_vars.get("R2_ACCOUNT_ID", ""),
        "r2_access_key": mask(env_vars.get("R2_ACCESS_KEY_ID", "")),
        "r2_secret_key": mask(env_vars.get("R2_SECRET_ACCESS_KEY", "")),
        "r2_bucket": env_vars.get("R2_BUCKET_NAME", ""),
        "auto_update_ytdlp": auto_update,
    }
    if not is_trusted:
        for key in ["r2_account_id", "r2_access_key", "r2_secret_key", "r2_bucket"]:
            config[key] = "HIDDEN (Connect to Tailscale/LAN to view)"
    return jsonify(config)


@downloader_bp.route("/api/downloader/config", methods=["POST"])
@require_admin(allow_trusted_network=True)
@rate_limit("downloader_config_update", limit=20, window_sec=60)
def update_downloader_config():
    import os
    api = _get_api()
    data = request.json
    # Note: Keep writer in sync with reader and API startup: always use repo-root-based .env.
    env_path = Path(__file__).resolve().parents[3] / "odst_tool" / ".env"
    from dotenv import set_key, dotenv_values
    # Note: Ensure parent directory exists before touching .env, regardless of CWD
    env_path.parent.mkdir(parents=True, exist_ok=True)
    if not env_path.exists():
        env_path.touch()
    key_map = {
        "output_dir": "OUTPUT_DIR",
        "quality": "DEFAULT_QUALITY",
        "r2_account_id": "R2_ACCOUNT_ID",
        "r2_access_key": "R2_ACCESS_KEY_ID",
        "r2_secret_key": "R2_SECRET_ACCESS_KEY",
        "r2_bucket": "R2_BUCKET_NAME",
        "auto_update_ytdlp": "YTDLP_AUTO_UPDATE",
    }
    for key, env_key in key_map.items():
        val = data.get(key)
        if val is not None:
            if isinstance(val, str) and val.endswith("****"):
                continue
            if key == "auto_update_ytdlp":
                val = "true" if (val is True or (isinstance(val, str) and val.strip().lower() in ("true", "1"))) else "false"
            set_key(str(env_path), env_key, str(val))
            os.environ[env_key] = str(val)
            # Note: Keep in-memory app config in sync so GET config and get_downloader() see the new path immediately
            if key == "output_dir":
                from shared.app_config import set_output_dir as set_app_output_dir
                set_app_output_dir(val)
                # Note: So desktop player finds path regardless of cwd write to config dir (same place player reads)
                try:
                    from shared.constants import DEFAULT_CONFIG_DIR
                    cfg = Path(DEFAULT_CONFIG_DIR).expanduser()
                    cfg.mkdir(parents=True, exist_ok=True)
                    (cfg / "output_dir").write_text(str(val).strip())
                except Exception:
                    pass
    import shared.api as api_mod
    api_mod.downloader_service = None
    return jsonify({"status": "updated"})
