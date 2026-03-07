"""
Downloader queue, YouTube search, discover, and downloader config routes.
"""

import hashlib
import json
import logging
import random
from pathlib import Path

from flask import Blueprint, request, jsonify

from shared.url_utils import validate_youtube_video_id

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
    api = _get_api()
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"results": []})
    limit = min(20, max(1, request.args.get("limit", 10, type=int)))
    source = (request.args.get("source") or "ytmusic").strip().lower()
    use_ytmusic = source == "ytmusic"
    try:
        dl = api["get_downloader"](open_browser=False)
        results = dl.downloader.search_youtube(q, max_results=limit, use_ytmusic=use_ytmusic)
        results = [r for r in results if (r.get("title") or "").strip() and (r.get("title") or "").strip() != "Unknown"]
        return jsonify({"results": results})
    except Exception as e:
        logger.warning("API: YouTube search error: %s", e)
        return jsonify({"results": [], "error": str(e)}), 500


def _get_resolve_executor():
    from shared.api import _get_resolve_executor as _get
    return _get()


@downloader_bp.route("/api/discover/recommendations", methods=["POST"])
def discover_recommendations():
    api = _get_api()
    try:
        data = request.json or {}
        limit = min(30, max(1, data.get("limit", 20)))
        lib, _, _ = api["get_core"]()
        if not lib.metadata:
            lib.sync_library()
        library_tracks = lib.metadata.tracks or []
        seed_ids = []
        for t in library_tracks:
            yt_id = getattr(t, "youtube_id", None) or (t.to_dict() if hasattr(t, "to_dict") else {}).get("youtube_id")
            if yt_id and isinstance(yt_id, str) and validate_youtube_video_id(yt_id):
                seed_ids.append(yt_id)
        if not seed_ids:
            return jsonify({"results": [], "reason": "no_seeds"}), 200
        seed_id = random.choice(seed_ids)
        request_limit = min(100, limit + 20)
        try:
            executor = _get_resolve_executor()
            from shared.api import _warm_downloader, _discover_recommendations_worker
            warm_future = executor.submit(_warm_downloader)
            warm_future.result(timeout=10)
        except Exception:
            pass
        try:
            executor = _get_resolve_executor()
            from shared.api import _discover_recommendations_worker
            future = executor.submit(_discover_recommendations_worker, seed_id, request_limit)
            out_results = future.result(timeout=45)
        except Exception as e:
            logger.warning("[Discover] executor failed: %s", e)
            out_results = []
        results = (out_results or [])[:limit]
        payload = {"results": results}
        if not results and seed_ids:
            payload["reason"] = "no_results"
        return jsonify(payload)
    except Exception as e:
        logger.warning("API: Discover recommendations error: %s", e)
        import traceback
        traceback.print_exc()
        return jsonify({"results": [], "reason": "error", "error": str(e)}), 500


@downloader_bp.route("/api/downloader/queue", methods=["POST"])
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
def remove_from_downloader_queue(item_id):
    api = _get_api()
    api["queue_manager_dl"].remove_item(item_id)
    return jsonify({"status": "removed"})


@downloader_bp.route("/api/downloader/queue", methods=["DELETE"])
def clear_downloader_queue():
    api = _get_api()
    api["queue_manager_dl"].clear_queue()
    return jsonify({"status": "cleared"})


@downloader_bp.route("/api/downloader/start", methods=["POST"])
def trigger_downloader():
    import threading
    api = _get_api()
    if not api["queue_manager_dl"].is_processing:
        logger.info("API: [Queue] Start download requested, starting background processor.")
        threading.Thread(target=api["process_queue_background"], daemon=True).start()
        return jsonify({"status": "started"})
    return jsonify({"status": "already_running"})


@downloader_bp.route("/api/downloader/optimize", methods=["POST"])
def trigger_downloader_optimize():
    import threading
    from shared.api import run_optimization_task
    dry_run = request.json.get("dry_run", True)
    threading.Thread(target=run_optimization_task, args=(dry_run,), daemon=True).start()
    return jsonify({"status": "started"})


@downloader_bp.route("/api/downloader/sync", methods=["POST"])
def trigger_downloader_sync():
    import threading
    from shared.api import run_sync_task
    threading.Thread(target=run_sync_task, daemon=True).start()
    return jsonify({"status": "started"})


@downloader_bp.route("/api/download", methods=["POST"])
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
    env_path = Path("odst_tool/.env")
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
def update_downloader_config():
    import os
    api = _get_api()
    if not api["is_trusted_network"](request.remote_addr):
        return jsonify({"error": "Admin actions restricted to Home Network / Tailscale"}), 403
    data = request.json
    env_path = Path("odst_tool/.env")
    from dotenv import set_key, dotenv_values
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
            # Keep in-memory app config in sync so GET config and get_downloader() see the new path immediately
            if key == "output_dir":
                from shared.app_config import set_output_dir as set_app_output_dir
                set_app_output_dir(val)
                # So desktop player finds path regardless of cwd: write to config dir (same place player reads)
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
