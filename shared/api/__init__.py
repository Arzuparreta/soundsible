"""
Unified API Server for Soundsible.
Acts as the bridge between the Python core and various frontends (Tauri, Web, PWA).
"""

import os
import sys
import threading
import json
import uuid
import logging
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify, send_file, send_from_directory, Response, stream_with_context
from flask_socketio import SocketIO, emit, join_room
from flask_cors import CORS

logger = logging.getLogger(__name__)

from shared.models import PlayerConfig, Track, LibraryMetadata, StorageProvider
from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME, DEFAULT_CACHE_DIR, STATION_PORT, DEFAULT_OUTPUT_DIR_FALLBACK
from shared.path_resolver import resolve_local_track_path
from shared.app_config import set_output_dir as set_app_output_dir
from shared.playback_state import get_state as get_playback_state, put_state as put_playback_state, get_scope_from_request
from player.library import LibraryManager
from player.engine import PlaybackEngine
from player.queue_manager import QueueManager
from player.favourites_manager import FavouritesManager
from odst_tool.odst_downloader import ODSTDownloader
from odst_tool.cloud_sync import CloudSync
from odst_tool.optimize_library import optimize_library
from setup_tool.uploader import UploadEngine
from setup_tool.provider_factory import StorageProviderFactory
from setup_tool.metadata import search_itunes, download_image
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

import random
import socket
import requests
import time
import hashlib
import tempfile
from typing import Optional, Any

from shared.url_utils import normalize_youtube_url, extract_youtube_video_id, validate_youtube_video_id
from shared.security import is_trusted_network, is_safe_path

from .download_queue import DownloadQueueManager, LibraryFileWatcher, parse_intake_item


def get_active_endpoints():
    """Gather all network-accessible IPv4 addresses for this machine."""
    endpoints = []
    try:
        # Standard socket-based discovery
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        if local_ip and not local_ip.startswith('127.'):
            endpoints.append(local_ip)
            
        # More robust discovery using all interfaces
        import psutil
        for interface, addrs in psutil.net_if_addrs().items():
            # Skip common bridge/virtual interfaces that aren't useful for mobile sync
            if any(skip in interface.lower() for skip in ['docker', 'br-', 'veth', 'lo']):
                continue
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    if ip not in endpoints and not ip.startswith('127.'):
                        endpoints.append(ip)
    except Exception as e:
        logger.debug("get_active_endpoints: primary discovery failed, using fallback: %s", e)
        # Fallback to a simple socket test if psutil fails or isn't installed
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip not in endpoints: endpoints.append(ip)
            s.close()
        except Exception:
            pass

    return endpoints

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="gevent")

# Suppress engineio/socketio INFO logs (e.g. "Invalid session" when browser reconnects with stale sid)
logging.getLogger("engineio").setLevel(logging.WARNING)
logging.getLogger("socketio").setLevel(logging.WARNING)


@socketio.on('playback_register')
def on_playback_register(data):
    """Register this socket for playback stop requests. Join room playback:{scope}:{device_id}."""
    device_id = (data or {}).get('device_id')
    if not device_id:
        return
    scope = get_scope_from_request()
    room = f"playback:{scope}:{device_id}"
    join_room(room, sid=request.sid)


# Path to the new Web UI and repo branding
# __file__ is shared/api/__init__.py; go up to project root
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WEB_UI_PATH = os.path.join(_REPO_ROOT, "ui_web")
REPO_ROOT = _REPO_ROOT
BRANDING_PATH = os.path.join(REPO_ROOT, 'branding')

# Serve Web Player
@app.route('/player/')
def serve_web_player():
    return send_from_directory(WEB_UI_PATH, 'index.html')

@app.route('/player/desktop/')
def serve_web_player_desktop():
    return send_from_directory(WEB_UI_PATH, 'desktop.html')

@app.route('/player/branding/<path:path>')
def serve_branding(path):
    return send_from_directory(BRANDING_PATH, path)

@app.route('/player/<path:path>')
def serve_web_player_assets(path):
    return send_from_directory(WEB_UI_PATH, path)

# Global instances
library_manager = None
playback_engine = None
queue_manager = None
favourites_manager = None
downloader_service = None
_downloader_lock = threading.Lock()  # Prevent concurrent init when many discover/resolve requests hit at once
queue_manager_dl = DownloadQueueManager(socketio=socketio)
api_observer = None  # Store Observer reference for cleanup in daemon mode

def get_core():
    global library_manager, playback_engine, queue_manager, favourites_manager
    if not library_manager:
        logger.info("API: Initializing Library Manager...")
        library_manager = LibraryManager()
        # Ensure we have metadata loaded from local cache at minimum
        if not library_manager.metadata:
            logger.info("API: No metadata in memory, checking cache...")
            cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
            library_manager._load_from_cache(cache_path)
            
        logger.info("API: Initializing Queue, Playback Engine and Favourites...")
        queue_manager = QueueManager()
        favourites_manager = FavouritesManager()
        # API server runs headless; web player uses browser for playback. Skip MPV to avoid blocking on display/audio.
        playback_engine = None
    return library_manager, playback_engine, queue_manager

def get_downloader(output_dir=None, open_browser=False, log_callback=None):
    global downloader_service

    def _log(msg):
        logger.info("API: %s", msg)
        if log_callback:
            log_callback(msg)

    # Load env once (used for quality/cookie_browser below)
    from dotenv import dotenv_values
    _env_path = Path(_REPO_ROOT) / "odst_tool" / ".env"
    env_vars = dotenv_values(_env_path) if _env_path.exists() else {}

    # 1. Determine the target output directory (prefer app_config set at startup)
    from shared.app_config import get_output_dir
    _app_out = get_output_dir()
    if output_dir:
        target_path = Path(output_dir).expanduser().absolute()
    elif _app_out is not None:
        target_path = _app_out
    else:
        target_dir = env_vars.get("OUTPUT_DIR") or os.getenv("OUTPUT_DIR") or DEFAULT_OUTPUT_DIR_FALLBACK
        target_path = Path(target_dir).expanduser().absolute()

    with _downloader_lock:
        should_init = False
        if not downloader_service:
            should_init = True
        elif downloader_service.output_dir != target_path:
            _log(f"Path changed to {target_path}. Re-initializing...")
            should_init = True

        if should_init:
            _log("Downloader: Entering setup...")
            _log(f"Step 1/3: Accessing storage at {target_path}...")
            try:
                target_path.mkdir(parents=True, exist_ok=True)
                _log("Step 1.1: Path is accessible.")
            except Exception as e:
                _log(f"⚠️ Step 1 Warning: NAS/Path issue: {e}")

            _log("Step 2/3: Loading Soundsible core...")
            lib_core, _, _ = get_core()

            _log("Step 3/3: Starting Engine...")
            quality = env_vars.get("DEFAULT_QUALITY", lib_core.config.quality_preference if lib_core.config else "high")
            from odst_tool.config import DEFAULT_WORKERS, DEFAULT_COOKIE_BROWSER
            cookie_browser = env_vars.get("COOKIE_BROWSER") or os.getenv("COOKIE_BROWSER") or DEFAULT_COOKIE_BROWSER
            _log(f"Initializing Downloader (Quality: {quality})...")
            downloader_service = ODSTDownloader(
                target_path, DEFAULT_WORKERS, cookie_browser=cookie_browser, quality=quality
            )
            _log("✅ Downloader Engine Ready.")

    return downloader_service


def process_queue_background():
    global downloader_service, queue_manager_dl
    if queue_manager_dl.is_processing:
        return
        
    queue_manager_dl.is_processing = True
    queue_manager_dl.add_log("Station Engine: Background processor started.")
    
    try:
        while True:
            pending = queue_manager_dl.get_pending()
            if not pending:
                queue_manager_dl.add_log("Station Engine: Queue empty, idling.")
                break
                
            item = pending[0]
            item_id = item['id']
            song_str = item.get('song_str')
            output_dir = item.get('output_dir')
            source_type = item.get('source_type') or 'manual'
            metadata_evidence = item.get('metadata_evidence') if isinstance(item.get('metadata_evidence'), dict) else {}
            
            queue_manager_dl.add_log(f"Preparing: {song_str or item_id}...")
            queue_manager_dl.update_status(item_id, 'downloading')
            with app.app_context():
                socketio.emit('downloader_update', {'id': item_id, 'status': 'downloading'})
            
            try:
                dl = get_downloader(output_dir, log_callback=queue_manager_dl.add_log)
                queue_manager_dl.add_log(f"Processing: {song_str or item_id}...")

                track = None
                if song_str:
                    # Direct URL or simple string (typed intake contract)
                    if source_type in {"youtube_url", "ytmusic_search", "youtube_search"} or "youtube.com" in song_str or "youtu.be" in song_str:
                        song_str = normalize_youtube_url(song_str)
                        queue_manager_dl.add_log(f"Downloading direct YouTube: {song_str}...")
                        runtime_hint = dict(metadata_evidence or {})
                        track = dl.downloader.process_video(song_str, metadata_hint=runtime_hint, source=source_type)
                    else:
                        # Manual search
                        fake_meta = {
                            'title': song_str,
                            'artist': 'Unknown',
                            'album': 'Manual',
                            'duration_sec': 0,
                            'id': f"manual_{uuid.uuid4().hex[:8]}",
                        }
                        if metadata_evidence:
                            fake_meta.update({k: v for k, v in metadata_evidence.items() if v is not None})
                        track = dl.downloader.process_track(fake_meta, source="manual")
                
                if track:
                    # Update ODST internal record (replace by hash if already present)
                    existing = dl.library.get_track_by_hash(track.file_hash)
                    if existing:
                        dl.library.remove_track(existing.id)
                    dl.library.add_track(track)
                    dl.save_library()
                    
                    # Update main Soundsible library core (convert ODST Track to shared Track so sync_from_metadata does not raise)
                    lib, _, _ = get_core()
                    # Ensure we have main library in memory (e.g. if None, load from config cache)
                    cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
                    if not lib.metadata and cache_path.exists():
                        lib._load_from_cache(cache_path)
                    if not lib.metadata:
                        lib.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                    
                    track_dict = track.to_dict()
                    track_dict.pop("local_path", None)
                    shared_track = Track.from_dict(track_dict)
                    if not lib.metadata.get_track_by_id(shared_track.id):
                        lib.metadata.add_track(shared_track)
                    # Pre-cache cover so first request serves it (avoids placeholder until second load)
                    local_track_path = resolve_local_track_path(shared_track)
                    covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
                    os.makedirs(covers_dir, exist_ok=True)
                    cover_path = os.path.join(covers_dir, f"{shared_track.id}.jpg")
                    if not os.path.exists(cover_path):
                        try:
                            from setup_tool.audio import AudioProcessor
                            cover_data = AudioProcessor.extract_cover_art(local_track_path) if local_track_path else None
                            if cover_data:
                                with open(cover_path, 'wb') as f:
                                    f.write(cover_data)
                        except Exception as e:
                            logger.warning("API: Pre-cache cover failed: %s", e)
                    # Persist to DB and library.json (config dir) so API and frontends see the new track
                    lib._save_metadata()
                    # Signal all clients to refresh (app context required when emitting from background thread)
                    with app.app_context():
                        socketio.emit('library_updated')
                        queue_manager_dl.remove_item(item_id)
                        track_dict = track.to_dict()
                        socketio.emit('downloader_update', {'id': item_id, 'status': 'completed', 'track': track_dict})
                    queue_manager_dl.add_log(f"✅ Finished & Cleared: {track.artist} - {track.title}")
                else:
                    raise Exception("Downloader returned no track. Check logs for details.")
                    
            except Exception as e:
                logger.warning("API Downloader Error: %s", e)
                import traceback
                traceback.print_exc()
                queue_manager_dl.update_status(item_id, 'failed', error=str(e))
                with app.app_context():
                    socketio.emit('downloader_update', {'id': item_id, 'status': 'failed', 'error': str(e)})
                queue_manager_dl.add_log(f"❌ Failed: {song_str or item_id} - {e}")

    except Exception as e:
        logger.error("CRITICAL: Downloader background thread crashed: %s", e)
        import traceback
        traceback.print_exc()
    finally:
        queue_manager_dl.is_processing = False


# --- Helpers (used by blueprints) ---
def get_track_by_id(lib, track_id: str) -> Optional[Track]:
    """Resolve track by ID: metadata first, then DB fallback. Single place for consistency."""
    if lib.metadata:
        track = lib.metadata.get_track_by_id(track_id)
        if track:
            return track
    if lib.db:
        return lib.db.get_track(track_id)
    return None


def _mark_track_metadata_updated(lib, track_id: str, cover_source: Optional[str] = None) -> bool:
    """Set track metadata flags, save, and emit library_updated. Returns True if track was found."""
    track = get_track_by_id(lib, track_id)
    if not track:
        return False
    if cover_source is not None:
        track.cover_source = cover_source
    track.metadata_modified_by_user = True
    lib._save_metadata()
    socketio.emit('library_updated')
    return True


def _ensure_lib_metadata():
    """Ensure library and metadata are loaded; return (lib, metadata) or (None, None)."""
    lib, _, _ = get_core()
    if not lib.metadata:
        lib.sync_library()
    return lib, lib.metadata if lib else None


# --- Discover / downloader background helpers (used by downloader blueprint) ---
_resolve_executor = None

def _get_resolve_executor():
    global _resolve_executor
    if _resolve_executor is None:
        from concurrent.futures import ThreadPoolExecutor
        _resolve_executor = ThreadPoolExecutor(max_workers=3)
    return _resolve_executor


def _warm_downloader():
    try:
        get_downloader(open_browser=False)
    except Exception:
        pass


def _discover_recommendations_worker(seed_id: str, limit: int):
    try:
        dl = get_downloader(open_browser=False)
        from recommendations import get_recommendations
        return get_recommendations(
            seed_video_ids=[seed_id],
            limit=limit,
            downloader=dl.downloader,
        )
    except Exception as e:
        logger.warning("[Discover] worker failed for seed %s: %s", seed_id, e)
        import traceback
        traceback.print_exc()
        return []


def run_optimization_task(dry_run):
    try:
        dl = get_downloader(log_callback=queue_manager_dl.add_log)
        mode = "DRY RUN" if dry_run else "LIVE"
        queue_manager_dl.add_log(f"--- Starting Library Optimization ({mode}) ---")
        def cb(msg): queue_manager_dl.add_log(f"🔧 {msg}")
        optimize_library(dl.output_dir, dry_run=dry_run, progress_callback=cb)
        queue_manager_dl.add_log("--- Optimization Finished ---")
    except Exception as e:
        queue_manager_dl.add_log(f"❌ Optimization Error: {e}")


def run_sync_task():
    try:
        dl = get_downloader(log_callback=queue_manager_dl.add_log)
        if not dl.cloud.is_configured():
            queue_manager_dl.add_log("❌ Cloud Sync not configured. Add R2/S3 keys in Settings.")
            return
        queue_manager_dl.add_log("--- Starting Cloud Sync ---")
        def cb(msg): queue_manager_dl.add_log(f"☁️ {msg}")
        dl.library = dl._load_library()
        result = dl.cloud.sync_library(dl.library, progress_callback=cb)
        if 'error' in result:
            queue_manager_dl.add_log(f"❌ Sync Error: {result['error']}")
        else:
            queue_manager_dl.add_log("✅ Sync Complete!")
            queue_manager_dl.add_log(f"   Uploaded: {result.get('uploaded', 0)}, Merged: {result.get('merged', 0)}")
            queue_manager_dl.add_log(f"   Total Remote: {result.get('total_remote', 0)}")
    except Exception as e:
        queue_manager_dl.add_log(f"❌ Critical Sync Error: {e}")


# --- Blueprints ---
from shared.api.routes.library import library_bp
from shared.api.routes.playback import playback_bp
from shared.api.routes.downloader import downloader_bp
from shared.api.routes.config import config_bp
app.register_blueprint(library_bp)
app.register_blueprint(playback_bp)
app.register_blueprint(downloader_bp)
app.register_blueprint(config_bp)


@app.route('/api/health')
def health_check():
    return jsonify({"status": "healthy"})

@app.route('/')
def home():
    return jsonify({
        "status": "online",
        "service": "Soundsible Core API",
        "version": "1.0.0"
    })

# --- Server Management ---

def _resolve_output_dir():
    """Resolve OUTPUT_DIR once at startup (only place that may read odst_tool/.env)."""
    target = os.getenv("OUTPUT_DIR")
    if not target:
        try:
            from dotenv import dotenv_values
            _env_path = Path(_REPO_ROOT) / "odst_tool" / ".env"
            _env = dotenv_values(_env_path) if _env_path.exists() else {}
            target = _env.get("OUTPUT_DIR")
        except Exception:
            pass
    if not target:
        try:
            from odst_tool.config import DEFAULT_OUTPUT_DIR
            target = str(DEFAULT_OUTPUT_DIR)
        except Exception:
            target = DEFAULT_OUTPUT_DIR_FALLBACK
    return Path(target).expanduser().resolve() if target else None


def start_api(port=STATION_PORT, debug=False):
    global api_observer
    logger.info("--- Soundsible API Boot Sequence ---")
    logger.info("Target Port: %s", port)
    logger.info("CWD: %s", os.getcwd())
    logger.info("For full startup (sync + watcher) use: python run.py --daemon")

    # Set app config so path_resolver and security do not depend on odst_tool layout
    _out = _resolve_output_dir()
    if _out:
        set_app_output_dir(_out)
        logger.info("API: Output dir set to %s", _out)

    _defer_ytdlp_thread = False
    _run_ytdlp_update = None

    try:
        lib, _, _ = get_core()
        logger.info("API: Core services initialized successfully.")

        # Optional: auto-update yt-dlp in background if user enabled it (thread started after terminal message)
        try:
            from dotenv import dotenv_values
            _env_path = Path("odst_tool/.env")
            _env = dotenv_values(_env_path) if _env_path.exists() else {}
            _auto = (_env.get("YTDLP_AUTO_UPDATE", os.getenv("YTDLP_AUTO_UPDATE", "false")) or "false").strip().lower() in ("true", "1")
            if _auto:
                def _run_ytdlp_update():
                    import subprocess
                    pip_cmd = None
                    try:
                        root = Path(_REPO_ROOT)
                        if os.name == "nt":
                            pip_exe = root / "venv" / "Scripts" / "pip.exe"
                        else:
                            pip_exe = root / "venv" / "bin" / "pip"
                        if pip_exe.exists():
                            pip_cmd = [str(pip_exe), "install", "-U", "yt-dlp"]
                    except Exception:
                        pass
                    if not pip_cmd:
                        pip_cmd = [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"]
                    try:
                        result = subprocess.run(
                            pip_cmd,
                            capture_output=True,
                            text=True,
                            timeout=120,
                        )
                        if result.returncode == 0:
                            logger.info("API: yt-dlp auto-update completed.")
                        else:
                            logger.warning("API: yt-dlp auto-update failed: %s", result.stderr or result.stdout or 'unknown')
                    except Exception as e:
                        logger.warning("API: yt-dlp auto-update error: %s", e)
                _defer_ytdlp_thread = True
        except Exception:
            pass

        # Start Library File Watcher
        config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
        config_dir.mkdir(parents=True, exist_ok=True)

        event_handler = LibraryFileWatcher(lib, socketio)
        api_observer = Observer()
        api_observer.schedule(event_handler, str(config_dir), recursive=False)
        api_observer.start()
        logger.info("API: Library File Watcher started on %s", config_dir)

    except Exception as e:
        logger.error("FATAL: Core initialization failed: %s", e)
        import traceback
        traceback.print_exc()

    # Diagnose: ensure discover routes are registered (helps debug 404 on resolve)
    try:
        from flask import url_for
        rules = [r.rule for r in app.url_map.iter_rules() if 'discover' in r.rule]
        logger.info("API: Discover routes registered: %s", rules)
    except Exception as e:
        logger.debug("API: Could not list routes: %s", e)

    # Access Summary
    logger.info("\n" + "="*40)
    logger.info("       SOUNDSIBLE ONLINE")
    logger.info("="*40)
    logger.info("Local:  http://localhost:%s/player/", port)
    
    endpoints = get_active_endpoints()
    for ip in endpoints:
        logger.info("Remote: http://%s:%s/player/", ip, port)
    logger.info("="*40 + "\n")

    try:
        import gevent
        logger.info("API: gevent active — concurrent request handling enabled")
    except ImportError:
        logger.info("API: gevent not installed — single-threaded (long requests may block others)")
    logger.info("API: Starting SocketIO server on 0.0.0.0:%s...", port)

    from shared.daemon_launcher import MSG_KEEP_TERMINAL_OPEN
    _terminal_msg = MSG_KEEP_TERMINAL_OPEN
    logger.info("API: %s", _terminal_msg)
    if _defer_ytdlp_thread and _run_ytdlp_update:
        threading.Thread(target=_run_ytdlp_update, daemon=True).start()
    sys.stdout.flush()
    sys.stderr.flush()
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)

if __name__ == '__main__':
    start_api()
