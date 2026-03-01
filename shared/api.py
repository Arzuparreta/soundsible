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
from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME, DEFAULT_CACHE_DIR
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
import re
import time
import hashlib
import ipaddress
import tempfile
from typing import Optional, Any
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
def normalize_youtube_url(url: str) -> str:
    """
    Normalize YouTube/YouTube Music URL to a single-video URL (no list=, index=, etc.).
    Address-bar links often include list= and cause wrong/failed downloads; Share → Copy link is correct.
    """
    if not url or not isinstance(url, str):
        return url
    url = url.strip()
    if "youtube.com" not in url and "youtu.be" not in url:
        return url
    try:
        parsed = urlparse(url)
        if "youtu.be" in parsed.netloc:
            video_id = (parsed.path or "").strip("/").split("?")[0].split("/")[0]
            if video_id:
                return f"https://www.youtube.com/watch?v={video_id}"
            return url
        q = parse_qs(parsed.query)
        video_id = (q.get("v") or [None])[0]
        if not video_id:
            return url
        # Keep only v= and optionally si=; drop list, index, and all other params
        new_query = {"v": video_id}
        if "si" in q and q["si"]:
            new_query["si"] = q["si"][0]
        return urlunparse((parsed.scheme or "https", parsed.netloc or "www.youtube.com", parsed.path, "", urlencode(new_query), ""))
    except Exception:
        return url


def extract_youtube_video_id(url: str) -> Optional[str]:
    """Extract YouTube video id from youtube.com/youtu.be/music.youtube.com URLs."""
    if not url:
        return None
    try:
        parsed = urlparse(url.strip())
        host = (parsed.netloc or "").lower()
        if "youtu.be" in host:
            vid = (parsed.path or "").strip("/").split("/")[0]
            return vid or None
        if "youtube.com" in host:
            q = parse_qs(parsed.query)
            vid = (q.get("v") or [None])[0]
            return vid or None
    except Exception:
        return None
    return None


def parse_intake_item(item: dict) -> tuple[dict | None, str | None]:
    """Validate and normalize intake schema for /api/downloader/queue."""
    if not isinstance(item, dict):
        return None, "Item must be an object"

    source_type = (item.get("source_type") or item.get("type") or "").strip() or None
    song_str = (item.get("song_str") or "").strip()
    metadata_evidence = item.get("metadata_evidence") if isinstance(item.get("metadata_evidence"), dict) else None
    output_dir = item.get("output_dir")
    if item.get("spotify_data") or (song_str and "spotify.com" in song_str):
        return None, "Spotify links are not supported"

    if source_type in {"youtube_url", "ytmusic_search", "youtube_search"}:
        normalized = normalize_youtube_url(song_str)
        video_id = extract_youtube_video_id(normalized or song_str)
        if not normalized or ("youtube.com" not in normalized and "youtu.be" not in normalized) or not video_id:
            return None, "Invalid or unsupported YouTube URL"
        if source_type in ("ytmusic_search", "youtube_search"):
            evidence_video_id = (metadata_evidence or {}).get("video_id")
            if not evidence_video_id:
                return None, f"{source_type} requires metadata_evidence.video_id"
            # title/channel may be empty from search; backend can use video title
        return {
            "source_type": source_type,
            "song_str": normalized,
            "output_dir": output_dir,
            "metadata_evidence": metadata_evidence,
            "video_id": (metadata_evidence or {}).get("video_id") or video_id,
        }, None

    if song_str:
        if "youtube.com" in song_str or "youtu.be" in song_str:
            normalized = normalize_youtube_url(song_str)
            if not extract_youtube_video_id(normalized):
                return None, "Playlist-only or invalid YouTube URL (missing v=)"
            return {
                "source_type": "youtube_url",
                "song_str": normalized,
                "output_dir": output_dir,
                "metadata_evidence": metadata_evidence,
            }, None
        return {
            "source_type": "manual",
            "song_str": song_str,
            "output_dir": output_dir,
            "metadata_evidence": metadata_evidence,
        }, None

    return None, "Missing source_type/song_str"

def is_trusted_network(remote_addr):
    """
    Automatically trusts Local, LAN, and Tailscale networks.
    Provides 'Zero-Friction' access for friends and family on the network.
    """
    try:
        ip = ipaddress.ip_address(remote_addr)
        # Trust if it's Private (LAN/WiFi) or Loopback (Localhost)
        # 100.x.x.x (Tailscale) is explicitly caught by is_private in many versions, 
        # but we check it specifically for reliability.
        is_tailscale = remote_addr.startswith('100.')
        return ip.is_private or ip.is_loopback or is_tailscale
    except:
        return False

def is_safe_path(file_path, is_trusted=False):
    """
    Ensures the Station Engine only serves files from approved music or cache folders.
    If is_trusted is True (LAN/Tailscale), all paths are allowed for maximum flexibility.
    """
    if is_trusted:
        return True
        
    try:
        # Lexical normalization for public-facing security check
        target = os.path.normpath(os.path.abspath(os.path.expanduser(file_path)))
        
        # Approved Roots for public access
        from odst_tool.config import DEFAULT_OUTPUT_DIR
        allowed_roots = [
            os.path.normpath(os.path.abspath(os.path.expanduser(DEFAULT_CONFIG_DIR))),
            os.path.normpath(os.path.abspath(os.path.expanduser(DEFAULT_CACHE_DIR))),
            os.path.normpath(os.path.abspath(os.path.expanduser(str(DEFAULT_OUTPUT_DIR)))),
            os.path.normpath(os.path.abspath(tempfile.gettempdir())),
            os.path.normpath(os.path.abspath(os.path.expanduser("~")))
        ]
        
        for root in allowed_roots:
            try:
                # Use commonpath to verify target is within root
                if os.path.commonpath([target, root]) == root:
                    return True
            except: continue
                
    except Exception as e:
        print(f"SECURITY: Error validating path {file_path}: {e}")
        
    return False

def resolve_local_track_path(track):
    """
    Resolve a local audio path for a track.
    Priority:
    1) track.local_path (if present)
    2) OUTPUT_DIR/tracks/{track.id}.{track.format}
    3) OUTPUT_DIR/tracks/{track.file_hash}.{track.format}
    """
    candidates = []

    local_path = getattr(track, 'local_path', None)
    if local_path:
        candidates.append(local_path)

    track_id = getattr(track, 'id', None)
    file_hash = getattr(track, 'file_hash', None)
    track_format = (getattr(track, 'format', None) or 'mp3').strip('.')

    try:
        from dotenv import dotenv_values
        env_path = Path('odst_tool/.env')
        env_vars = dotenv_values(env_path) if env_path.exists() else {}
        output_dir = env_vars.get("OUTPUT_DIR") or os.getenv("OUTPUT_DIR")
        if output_dir:
            tracks_dir = Path(output_dir).expanduser().absolute() / "tracks"
            if track_id:
                candidates.append(str(tracks_dir / f"{track_id}.{track_format}"))
            if file_hash and file_hash != track_id:
                candidates.append(str(tracks_dir / f"{file_hash}.{track_format}"))
    except Exception:
        pass

    for candidate in candidates:
        try:
            if candidate and os.path.exists(candidate):
                return candidate
        except Exception:
            continue
    return None

class LibraryFileWatcher(FileSystemEventHandler):
    """Watches library.json for changes and triggers SocketIO updates."""
    def __init__(self, lib_manager):
        self.lib_manager = lib_manager
        self.last_sync = 0

    def on_modified(self, event):
        if event.src_path.endswith(LIBRARY_METADATA_FILENAME):
            # Debounce: avoid double-triggering
            now = time.time()
            if now - self.last_sync < 2:
                return
            self.last_sync = now
            
            print(f"API: Detected external change to {LIBRARY_METADATA_FILENAME}. Refreshing...")
            # Refresh memory
            self.lib_manager.refresh_if_stale()
            # Broadcast to all clients
            socketio.emit('library_updated')

class DownloadQueueManager:
    """Manages the download queue for the Station Engine."""
    def __init__(self, storage_path=None):
        if storage_path is None:
            storage_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "download_queue.json"
        self.storage_path = Path(storage_path)
        
        # Non-persistence: Wipe previous queue on reboot
        if self.storage_path.exists():
            try: self.storage_path.unlink()
            except: pass
            
        self.queue = []
        self.lock = threading.RLock() # Use Re-entrant lock to prevent deadlocks
        self.is_processing = False
        self.log_buffer = [] # Memory buffer for logs
        self.max_logs = 50

    def add_log(self, msg):
        log_entry = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        with self.lock:
            self.log_buffer.append(log_entry)
            if len(self.log_buffer) > self.max_logs:
                self.log_buffer.pop(0)
        print(f"API: [Queue] {msg}")
        socketio.emit('downloader_log', {'data': msg})

    def _load(self):
        if self.storage_path.exists():
            try:
                with open(self.storage_path, 'r') as f:
                    data = json.load(f)
                    return data if isinstance(data, list) else []
            except Exception as e:
                print(f"API: Error loading download queue: {e}")
        return []

    def save(self):
        try:
            # Ensure directory exists
            self.storage_path.parent.mkdir(parents=True, exist_ok=True)
            with self.lock:
                with open(self.storage_path, 'w') as f:
                    json.dump(self.queue, f, indent=2)
        except Exception as e:
            print(f"API: Error saving download queue: {e}")

    def add(self, item):
        with self.lock:
            # Ensure item is a dict
            if not isinstance(item, dict):
                item = {"song_str": str(item)}
                
            item['id'] = item.get('id', str(uuid.uuid4()))
            item['status'] = 'pending'
            # Robust UTC ISO format for compatibility across Python versions
            item['added_at'] = datetime.utcnow().isoformat() + "Z"
            self.queue.append(item)
            
        self.save()
        return item

    def get_pending(self):
        with self.lock:
            return [i for i in self.queue if i['status'] == 'pending']

    def update_status(self, item_id, status, error=None):
        do_save = False
        with self.lock:
            for item in self.queue:
                if item['id'] == item_id:
                    item['status'] = status
                    if error: item['error'] = error
                    do_save = True
                    break
        if do_save:
            self.save()

    def remove_item(self, item_id):
        with self.lock:
            self.queue = [i for i in self.queue if i['id'] != item_id]
        self.save()

    def clear_queue(self):
        with self.lock:
            # Clear everything except currently downloading
            self.queue = [i for i in self.queue if i['status'] == 'downloading']
        self.save()

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
    except:
        # Fallback to a simple socket test if psutil fails or isn't installed
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip not in endpoints: endpoints.append(ip)
            s.close()
        except: pass
        
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
WEB_UI_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'ui_web')
REPO_ROOT = os.path.dirname(WEB_UI_PATH)
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
queue_manager_dl = DownloadQueueManager()
api_observer = None  # Store Observer reference for cleanup in daemon mode

def get_core():
    global library_manager, playback_engine, queue_manager, favourites_manager
    if not library_manager:
        print("API: Initializing Library Manager...")
        library_manager = LibraryManager()
        # Ensure we have metadata loaded from local cache at minimum
        if not library_manager.metadata:
            print("API: No metadata in memory, checking cache...")
            cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
            library_manager._load_from_cache(cache_path)
            
        print("API: Initializing Queue, Playback Engine and Favourites...", flush=True)
        queue_manager = QueueManager()
        favourites_manager = FavouritesManager()
        # API server runs headless; web player uses browser for playback. Skip MPV to avoid blocking on display/audio.
        playback_engine = None
    return library_manager, playback_engine, queue_manager

def get_downloader(output_dir=None, open_browser=False, log_callback=None):
    global downloader_service

    def _log(msg):
        print(f"API: {msg}")
        if log_callback:
            log_callback(msg)

    # 1. Determine the target output directory (outside lock)
    from dotenv import dotenv_values
    env_path = Path('odst_tool/.env')
    env_vars = dotenv_values(env_path) if env_path.exists() else {}
    target_dir = output_dir or env_vars.get("OUTPUT_DIR") or os.getenv("OUTPUT_DIR")
    if not target_dir:
        from odst_tool.config import DEFAULT_OUTPUT_DIR
        target_dir = str(DEFAULT_OUTPUT_DIR)
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
                    # Update ODST internal record
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
                    
                    shared_track = Track.from_dict(track.to_dict())
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
                            print(f"API: Pre-cache cover failed: {e}")
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
                print(f"API Downloader Error: {e}")
                import traceback
                traceback.print_exc()
                queue_manager_dl.update_status(item_id, 'failed', error=str(e))
                with app.app_context():
                    socketio.emit('downloader_update', {'id': item_id, 'status': 'failed', 'error': str(e)})
                queue_manager_dl.add_log(f"❌ Failed: {song_str or item_id} - {e}")

    except Exception as e:
        print(f"CRITICAL: Downloader background thread crashed: {e}")
        import traceback
        traceback.print_exc()
    finally:
        queue_manager_dl.is_processing = False

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

# --- Library Endpoints ---

@app.route('/api/library', methods=['GET'])
def get_library():
    lib, _, _ = get_core()
    # Auto-refresh if disk manifest changed (e.g. by GTK app)
    lib.refresh_if_stale()
    
    if not lib.metadata:
        lib.sync_library()
    
    if lib.metadata:
        return jsonify(json.loads(lib.metadata.to_json()))
    return jsonify({"error": "Library not loaded"}), 404

@app.route('/api/library/sync', methods=['POST'])
def sync_library():
    lib, _, _ = get_core()
    success = lib.sync_library()
    if success:
        socketio.emit('library_updated')
    return jsonify({"status": "success" if success else "failed"})

@app.route('/api/library/tracks/<track_id>', methods=['DELETE'])
def delete_track_from_library(track_id):
    # SECURITY: Only allow deletions from trusted networks
    if not is_trusted_network(request.remote_addr):
        return jsonify({"error": "Deletions restricted to Home Network / Tailscale"}), 403

    lib, _, _ = get_core()
    
    # Resolve track
    track = None
    if lib.metadata:
        track = lib.metadata.get_track_by_id(track_id)
    
    if not track:
        # DB Fallback
        db_tracks = lib.db.get_all_tracks()
        track = next((t for t in db_tracks if t.id == track_id), None)
        
    if not track:
        return jsonify({"error": "Track not found"}), 404
        
    print(f"API: Deleting track {track.title} ({track_id})...")
    success = lib.delete_track(track)
    
    if success:
        socketio.emit('library_updated')
        return jsonify({"status": "success"})
    else:
        return jsonify({"error": "Deletion failed"}), 500

@app.route('/api/library/search', methods=['GET'])
def search_library():
    lib, _, _ = get_core()
    query = request.args.get('q', '').lower()
    
    # Use high-performance DB search
    results = lib.search(query)
    return jsonify([t.to_dict() for t in results[:50]])

# --- Metadata Endpoints ---

@app.route('/api/metadata/search', methods=['GET'])
def search_metadata_external():
    """Search external services (iTunes) for metadata and covers."""
    query = request.args.get('q', '')
    if not query:
        return jsonify([])
    
    results = search_itunes(query, limit=10)
    return jsonify(results)

@app.route('/api/library/tracks/<track_id>/metadata', methods=['POST'])
def update_track_metadata(track_id):
    """Update track metadata and re-upload if needed."""
    if not is_trusted_network(request.remote_addr):
        return jsonify({"error": "Admin actions restricted to Home Network / Tailscale"}), 403

    lib, _, _ = get_core()
    data = request.json
    
    track = lib.metadata.get_track_by_id(track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
        
    # Optional cover art from URL
    cover_url = data.get('cover_url')
    cover_path = None
    
    if cover_url:
        print(f"API: Downloading cover from {cover_url}...")
        img_data = download_image(cover_url)
        if img_data:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                tmp.write(img_data)
                cover_path = tmp.name
                
    # Check if clearing cover
    clear_cover = data.get('clear_cover', False)
    
    # Prepare metadata dict for LibraryManager.update_track
    new_meta = {
        'title': data.get('title', track.title),
        'artist': data.get('artist', track.artist),
        'album': data.get('album', track.album),
        'album_artist': data.get('album_artist', track.album_artist)
    }
    
    success = lib.update_track(track, new_meta, cover_path if not clear_cover else None)
    
    if cover_path and os.path.exists(cover_path):
        os.remove(cover_path)
    
    # Update cover_source and metadata_modified_by_user after update
    if success:
        updated_track = lib.metadata.get_track_by_id(track_id)
        if updated_track:
            updated_track.metadata_modified_by_user = True
            if clear_cover:
                updated_track.cover_source = "none"
            elif cover_url:
                # Determine cover source from URL or default to manual
                if "youtube.com" in cover_url or "youtu.be" in cover_url:
                    updated_track.cover_source = "youtube"
                else:
                    updated_track.cover_source = "manual"
            lib._save_metadata()
        
    if success:
        socketio.emit('library_updated')
        return jsonify({"status": "success"})
    else:
        return jsonify({"error": "Failed to update track"}), 500

@app.route('/api/library/tracks/<track_id>/cover', methods=['POST'])
def upload_track_cover(track_id):
    """Upload a custom cover art file for a track."""
    if not is_trusted_network(request.remote_addr):
        return jsonify({"error": "Admin actions restricted to Home Network / Tailscale"}), 403

    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400
        
    lib, _, _ = get_core()
    track = lib.metadata.get_track_by_id(track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
        
    # Save to temp file
    with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1]) as tmp:
        file.save(tmp.name)
        cover_path = tmp.name
        
    # We only update cover, keep other metadata same
    success = lib.update_track(track, {}, cover_path)
    
    if os.path.exists(cover_path):
        os.remove(cover_path)
    
    # Update cover_source and metadata_modified_by_user after update
    if success:
        updated_track = lib.metadata.get_track_by_id(track_id)
        if updated_track:
            updated_track.cover_source = "manual"
            updated_track.metadata_modified_by_user = True
            lib._save_metadata()
        
    if success:
        socketio.emit('library_updated')
        return jsonify({"status": "success"})
    else:
        return jsonify({"error": "Failed to update cover"}), 500

@app.route('/api/library/tracks/<track_id>/cover/from-track', methods=['POST'])
def copy_track_cover(track_id):
    """Copy cover art from another track in the library."""
    if not is_trusted_network(request.remote_addr):
        return jsonify({"error": "Admin actions restricted to Home Network / Tailscale"}), 403

    lib, _, _ = get_core()
    data = request.json or {}
    source_track_id = data.get('source_track_id')
    
    if not source_track_id:
        return jsonify({"error": "source_track_id required"}), 400
    
    track = lib.metadata.get_track_by_id(track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    
    source_track = lib.metadata.get_track_by_id(source_track_id)
    if not source_track:
        return jsonify({"error": "Source track not found"}), 404
    
    # Extract cover from source track
    source_local_path = resolve_local_track_path(source_track)
    if not source_local_path:
        return jsonify({"error": "Source track file not found"}), 404
    
    try:
        from setup_tool.audio import AudioProcessor
        cover_data = AudioProcessor.extract_cover_art(source_local_path)
        if not cover_data:
            return jsonify({"error": "No cover art found in source track"}), 404
        
        # Save to temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp:
            tmp.write(cover_data)
            cover_path = tmp.name
        
        # Update track with copied cover
        success = lib.update_track(track, {}, cover_path)
        
        if os.path.exists(cover_path):
            os.remove(cover_path)
        
        # Update cover_source and metadata_modified_by_user
        if success:
            updated_track = lib.metadata.get_track_by_id(track_id)
            if updated_track:
                updated_track.cover_source = "manual"  # Using cover from library
                updated_track.metadata_modified_by_user = True
                lib._save_metadata()
        
        if success:
            socketio.emit('library_updated')
            return jsonify({"status": "success"})
        else:
            return jsonify({"error": "Failed to update cover"}), 500
    except Exception as e:
        return jsonify({"error": f"Failed to copy cover: {str(e)}"}), 500

@app.route('/api/library/tracks/<track_id>/cover/none', methods=['POST'])
def clear_track_cover(track_id):
    """Remove cover art from a track."""
    if not is_trusted_network(request.remote_addr):
        return jsonify({"error": "Admin actions restricted to Home Network / Tailscale"}), 403

    lib, _, _ = get_core()
    track = lib.metadata.get_track_by_id(track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    
    # Use update_track_metadata with clear_cover flag
    # Create a minimal 1x1 transparent PNG as placeholder
    try:
        from PIL import Image
        placeholder = Image.new('RGBA', (1, 1), (0, 0, 0, 0))
        with tempfile.NamedTemporaryFile(delete=False, suffix='.png') as tmp:
            placeholder.save(tmp.name, 'PNG')
            placeholder_path = tmp.name
        
        success = lib.update_track(track, {}, placeholder_path)
        
        if os.path.exists(placeholder_path):
            os.remove(placeholder_path)
        
        # Update cover_source and metadata_modified_by_user
        if success:
            updated_track = lib.metadata.get_track_by_id(track_id)
            if updated_track:
                updated_track.cover_source = "none"
                updated_track.metadata_modified_by_user = True
                lib._save_metadata()
        
        if success:
            socketio.emit('library_updated')
            return jsonify({"status": "success"})
        else:
            return jsonify({"error": "Failed to clear cover"}), 500
    except ImportError:
        # PIL not available, just update metadata
        updated_track = lib.metadata.get_track_by_id(track_id)
        if updated_track:
            updated_track.cover_source = "none"
            updated_track.metadata_modified_by_user = True
            lib._save_metadata()
            socketio.emit('library_updated')
            return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": f"Failed to clear cover: {str(e)}"}), 500


# --- Favourites Endpoints ---

@app.route('/api/library/favourites', methods=['GET'])
def get_favourites():
    get_core() # Ensure initialized
    return jsonify(favourites_manager.get_all())

@app.route('/api/library/favourites/toggle', methods=['POST'])
def toggle_favourite():
    get_core() # Ensure initialized
    data = request.json
    track_id = data.get('track_id')
    if not track_id:
        return jsonify({"error": "No track_id provided"}), 400
        
    is_fav = favourites_manager.toggle(track_id)
    return jsonify({"status": "success", "is_favourite": is_fav})


# --- Playlist Endpoints ---

def _ensure_lib_metadata():
    """Ensure library and metadata are loaded; return (lib, metadata) or (None, None)."""
    lib, _, _ = get_core()
    if not lib.metadata:
        lib.sync_library()
    return lib, lib.metadata if lib else None


@app.route('/api/library/playlists', methods=['POST'])
def create_playlist():
    """Create a new empty playlist."""
    lib, metadata = _ensure_lib_metadata()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.json or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    if name in metadata.playlists:
        return jsonify({"error": "Playlist already exists"}), 409
    metadata.create_playlist(name)
    lib._save_metadata()
    socketio.emit('library_updated')
    return jsonify({"status": "success", "playlists": metadata.playlists})


@app.route('/api/library/playlists', methods=['PATCH'])
def reorder_playlists():
    """Set playlist order. Body: { \"order\": [\"name1\", \"name2\", ...] }."""
    lib, metadata = _ensure_lib_metadata()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.json or {}
    order = data.get('order')
    if not isinstance(order, list):
        return jsonify({"error": "order must be a list of playlist names"}), 400
    metadata.reorder_playlists(order)
    lib._save_metadata()
    socketio.emit('library_updated')
    return jsonify({"status": "success", "playlists": metadata.playlists})


@app.route('/api/library/playlists/<path:name>/tracks', methods=['POST'])
def add_track_to_playlist(name):
    from urllib.parse import unquote
    name = unquote(name)
    lib, metadata = _ensure_lib_metadata()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    data = request.json or {}
    track_id = data.get('track_id')
    if not track_id:
        return jsonify({"error": "track_id is required"}), 400
    if not metadata.add_to_playlist(name, track_id):
        return jsonify({"error": "Add to playlist failed"}), 500
    lib._save_metadata()
    socketio.emit('library_updated')
    return jsonify({"status": "success", "playlists": metadata.playlists})


@app.route('/api/library/playlists/<path:name>/tracks/<track_id>', methods=['DELETE'])
def remove_track_from_playlist(name, track_id):
    from urllib.parse import unquote
    name = unquote(name)
    lib, metadata = _ensure_lib_metadata()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    if not metadata.remove_from_playlist(name, track_id):
        return jsonify({"error": "Remove from playlist failed"}), 500
    lib._save_metadata()
    socketio.emit('library_updated')
    return jsonify({"status": "success", "playlists": metadata.playlists})


@app.route('/api/library/playlists/<path:name>', methods=['PATCH'])
def update_playlist(name):
    """Rename playlist or set track order. Body: { \"name\": \"newName\" } or { \"track_ids\": [\"id1\", ...] }."""
    from urllib.parse import unquote
    name = unquote(name)
    lib, metadata = _ensure_lib_metadata()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    data = request.json or {}
    if 'name' in data:
        new_name = (data.get('name') or '').strip()
        if not new_name:
            return jsonify({"error": "name cannot be empty"}), 400
        if not metadata.rename_playlist(name, new_name):
            return jsonify({"error": "Rename failed (new name may already exist)"}), 409
        name = new_name
    if 'track_ids' in data:
        track_ids = data.get('track_ids')
        if not isinstance(track_ids, list):
            return jsonify({"error": "track_ids must be a list"}), 400
        metadata.set_playlist_tracks(name, list(track_ids))
    lib._save_metadata()
    socketio.emit('library_updated')
    return jsonify({"status": "success", "playlists": metadata.playlists})


@app.route('/api/library/playlists/<path:name>', methods=['DELETE'])
def delete_playlist(name):
    from urllib.parse import unquote
    name = unquote(name)
    lib, metadata = _ensure_lib_metadata()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if not metadata.delete_playlist(name):
        return jsonify({"error": "Playlist not found"}), 404
    lib._save_metadata()
    socketio.emit('library_updated')
    return jsonify({"status": "success", "playlists": metadata.playlists})


# --- Playback Endpoints ---

@app.route('/api/static/stream/<track_id>', methods=['GET'])
def stream_local_track(track_id):
    """Serve a local audio file with path resolution and range support."""
    print(f"DEBUG: [Stream] Request for ID: {track_id}")
    lib, _, _ = get_core()
    
    # 1. Try to find track in Memory Metadata first (faster and more reliable for PWA)
    track = None
    if lib.metadata:
        track = lib.metadata.get_track_by_id(track_id)
        
    # 2. Try DB fallback
    if not track:
        # Check all tracks in DB
        db_tracks = lib.db.get_all_tracks()
        track = next((t for t in db_tracks if t.id == track_id), None)
        
    if not track:
        print(f"DEBUG: [Stream] ❌ Track {track_id} not found in metadata")
        return jsonify({"error": "Track not found"}), 404
        
    # Path Resolution Logic
    raw_path = getattr(track, 'local_path', None)
    if not raw_path and lib.cache:
        raw_path = lib.cache.get_cached_path(track_id)
        
    if not raw_path:
        print(f"DEBUG: [Stream] ❌ No path known for {track_id}")
        return jsonify({"error": "No path registered"}), 404

    # Convert relative to absolute if needed
    path = os.path.expanduser(raw_path)
    if not os.path.isabs(path):
        # Try relative to home first, then relative to project
        alt_path = os.path.join(os.path.expanduser("~"), path)
        if os.path.exists(alt_path):
            path = alt_path
        else:
            path = os.path.abspath(os.path.join(os.getcwd(), raw_path))

    if not os.path.exists(path):
        print(f"DEBUG: [Stream] ❌ File NOT found at: {path}")
        return jsonify({"error": f"File not found: {path}"}), 404
        
    # SECURITY: Path Jail Check with Smart Trust
    is_trusted = is_trusted_network(request.remote_addr)
    if not is_safe_path(path, is_trusted=is_trusted):
        print(f"SECURITY: [Stream] ❌ Blocked unauthorized path access: {path}")
        return jsonify({"error": "Unauthorized path access"}), 403

    print(f"DEBUG: [Stream] ✅ Serving: {path}")
    
    ext = os.path.splitext(path)[1].lower().replace('.', '')
    mimetypes = {'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'flac': 'audio/flac', 'ogg': 'audio/ogg', 'wav': 'audio/wav'}
    
    try:
        response = send_file(path, mimetype=mimetypes.get(ext, 'audio/mpeg'), conditional=True)
        # Ensure Range headers are allowed for cross-origin
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Methods', 'GET, OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Range')
        response.headers.add('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
        return response
    except Exception as e:
        print(f"DEBUG: [Stream] ❌ Error: {e}")
        return jsonify({"error": str(e)}), 500


def _validate_youtube_video_id(video_id: str) -> bool:
    """Allow only safe YouTube video id (11 chars, alphanumeric + -_)."""
    if not video_id or len(video_id) != 11:
        return False
    return all(c.isalnum() or c in '-_' for c in video_id)


# Rate limit for preview stream: per-IP, 30 requests per 60 seconds
_preview_stream_timestamps: dict = {}
_preview_stream_lock = threading.Lock()
PREVIEW_STREAM_LIMIT = 30
PREVIEW_STREAM_WINDOW_SEC = 60


def _preview_stream_rate_limit(ip: str) -> bool:
    """Return True if request is allowed, False if rate limited."""
    now = time.time()
    with _preview_stream_lock:
        timestamps = _preview_stream_timestamps.get(ip, [])
        timestamps = [t for t in timestamps if now - t < PREVIEW_STREAM_WINDOW_SEC]
        if len(timestamps) >= PREVIEW_STREAM_LIMIT:
            return False
        timestamps.append(now)
        _preview_stream_timestamps[ip] = timestamps
    return True


# Preview playback: stream bytes through our server so the client can play (same-origin; no CORS).
# Direct googlevideo.com URLs are cross-origin and blocked by the browser for playback.
@app.route('/api/preview/stream/<video_id>', methods=['GET'])
def preview_stream_proxy(video_id):
    """Stream YouTube audio through the server so the client can play it (avoids CORS). Supports Range for seek and forwards Content-Length/Content-Range for duration."""
    if not _validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    if not _preview_stream_rate_limit(request.remote_addr or 'unknown'):
        return jsonify({"error": "Too many requests"}), 429
    try:
        dl = get_downloader(open_browser=False)
        stream_url = dl.downloader.get_stream_url(video_id)
        if not stream_url:
            return jsonify({"error": "Preview unavailable"}), 502
        range_header = request.headers.get("Range")
        req_headers = {"Range": range_header} if range_header else {}
        resp = requests.get(stream_url, stream=True, headers=req_headers, timeout=90)
        resp.raise_for_status()
        status_code = resp.status_code
        content_length = resp.headers.get("Content-Length")
        content_range = resp.headers.get("Content-Range")
        response_headers = {"Content-Type": "audio/mpeg"}
        if content_range:
            response_headers["Content-Range"] = content_range
        if content_length:
            response_headers["Content-Length"] = content_length

        def iter_chunks():
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk

        return Response(
            stream_with_context(iter_chunks()),
            status=status_code,
            headers=response_headers,
            mimetype="audio/mpeg",
            direct_passthrough=True,
        )
    except Exception as e:
        print(f"API: [Preview stream] Error for {video_id}: {e}")
        return jsonify({"error": "Preview unavailable"}), 502


@app.route('/api/preview/stream-url/<video_id>', methods=['GET'])
def get_preview_stream_url(video_id):
    """Return direct YouTube audio stream URL (kept for compatibility; client should use /stream/ for playback)."""
    if not _validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    if not _preview_stream_rate_limit(request.remote_addr or 'unknown'):
        return jsonify({"error": "Too many requests"}), 429
    try:
        dl = get_downloader(open_browser=False)
        url = dl.downloader.get_stream_url(video_id)
        if not url:
            return jsonify({"error": "Stream URL unavailable"}), 404
        return jsonify({"url": url})
    except Exception as e:
        print(f"API: [Preview stream-url] Error for {video_id}: {e}")
        return jsonify({"error": "Preview unavailable"}), 502


@app.route('/api/preview/cover/<video_id>', methods=['GET'])
def preview_cover_redirect(video_id):
    """Redirect to YouTube thumbnail for preview cover (optional; frontend may use thumbnail URL directly)."""
    if not _validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    from flask import redirect
    return redirect(f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg", code=302)


@app.route('/api/static/cover/<track_id>', methods=['GET'])
def get_track_cover(track_id):
    """Serve album cover art. If missing: extract from file."""
    lib, _, _ = get_core()
    track = lib.metadata.get_track_by_id(track_id) if lib.metadata else None
    if not track and lib.db:
        track = next((t for t in lib.db.get_all_tracks() if t.id == track_id), None)
    if not track:
        return jsonify({"error": "Track not found"}), 404

    path = lib.get_cover_url(track)
    local_track_path = resolve_local_track_path(track) if not path else None
    if not path:
        try:
            from setup_tool.audio import AudioProcessor
            covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
            os.makedirs(covers_dir, exist_ok=True)
            cover_path = os.path.join(covers_dir, f"{track.id}.jpg")
            if not os.path.exists(cover_path):
                cover_data = None
                if local_track_path and not str(local_track_path).startswith("http"):
                    cover_data = AudioProcessor.extract_cover_art(local_track_path)
                if cover_data:
                    with open(cover_path, "wb") as f:
                        f.write(cover_data)
            if os.path.exists(cover_path):
                path = cover_path
        except Exception as e:
            print(f"[Cover] Failed for {track_id}: {e}")

    if path and os.path.exists(path):
        is_trusted = is_trusted_network(request.remote_addr)
        if not is_safe_path(path, is_trusted=is_trusted):
            return jsonify({"error": "Unauthorized path"}), 403
        return send_file(path, mimetype="image/jpeg")

    placeholder = os.path.join(WEB_UI_PATH, "assets/icons/icon-192.png")
    if os.path.exists(placeholder):
        return send_file(placeholder, mimetype="image/png")
    return jsonify({"error": "Cover not ready"}), 404

# --- Playback Endpoints ---

@app.route('/api/playback/queue', methods=['GET'])
def get_playback_queue():
    _, _, queue = get_core()
    return jsonify({
        "tracks": [t.to_dict() for t in queue.get_all()],
        "repeat_mode": queue.get_repeat_mode()
    })

@app.route('/api/playback/shuffle', methods=['POST'])
def shuffle_playback_queue():
    _, _, queue = get_core()
    queue.shuffle()
    return jsonify({"status": "success"})

@app.route('/api/playback/repeat', methods=['POST'])
def set_playback_repeat():
    _, _, queue = get_core()
    data = request.json
    mode = data.get('mode', 'off')  # off, all, one, once
    queue.set_repeat_mode(mode)
    return jsonify({"status": "success", "mode": mode})

@app.route('/api/playback/queue', methods=['POST'])
def add_to_playback_queue():
    _, _, queue = get_core()
    data = request.json
    track_id = data.get('track_id')
    
    lib, _, _ = get_core()
    track = lib.metadata.get_track_by_id(track_id)
    if track:
        queue.add(track)
        return jsonify({"status": "success", "size": queue.size()})
    return jsonify({"error": "Track not found"}), 404

@app.route('/api/playback/queue/<int:index>', methods=['DELETE'])
def remove_from_playback_queue(index):
    _, _, queue = get_core()
    if queue.remove(index):
        return jsonify({"status": "success"})
    return jsonify({"error": "Index out of range"}), 400

@app.route('/api/playback/queue/track/<track_id>', methods=['DELETE'])
def remove_track_id_from_playback_queue(track_id):
    _, _, queue = get_core()
    # Find all instances of this track in queue and remove them
    tracks = queue.get_all()
    indices_to_remove = [i for i, t in enumerate(tracks) if t.id == track_id]
    
    if not indices_to_remove:
        return jsonify({"error": "Track not in queue"}), 404
        
    # Remove from back to front to keep indices valid
    for index in reversed(indices_to_remove):
        queue.remove(index)
        
    return jsonify({"status": "success", "removed_count": len(indices_to_remove)})

@app.route('/api/playback/queue/move', methods=['POST'])
def move_in_playback_queue():
    _, _, queue = get_core()
    data = request.json
    from_index = data.get('from_index')
    to_index = data.get('to_index')
    
    if from_index is not None and to_index is not None:
        if queue.move(from_index, to_index):
            return jsonify({"status": "success"})
    return jsonify({"error": "Invalid indices"}), 400

@app.route('/api/playback/queue', methods=['DELETE'])
def clear_playback_queue():
    _, _, queue = get_core()
    queue.clear()
    return jsonify({"status": "success"})

@app.route('/api/playback/next', methods=['GET'])
def get_next_from_queue():
    """Pop and return the next track from the queue."""
    _, _, queue = get_core()
    track = queue.get_next()
    if track:
        return jsonify(track.to_dict())
    return jsonify(None)

@app.route('/api/playback/play', methods=['POST'])
def play_track():
    lib, engine, _ = get_core()
    data = request.json
    track_id = data.get('track_id')
    
    track = lib.metadata.get_track_by_id(track_id)
    if track and engine:
        # Hybrid resolution (local -> cache -> cloud)
        url = lib.get_track_url(track)
        engine.play(url, track)
        return jsonify({"status": "playing", "track": track.title, "source": "local" if url == track.local_path else "remote"})
    return jsonify({"error": "Track not found or engine not ready"}), 404

@app.route('/api/playback/toggle', methods=['POST'])
def toggle_playback():
    _, engine, _ = get_core()
    if engine:
        engine.pause()
        return jsonify({"status": "toggled", "is_playing": engine.is_playing})
    return jsonify({"error": "Engine not ready"}), 500


@app.route('/api/playback/state', methods=['GET'])
def playback_get_state():
    """Return last playback state for this scope; optional exclude_device to prefer another device's state."""
    scope = get_scope_from_request()
    exclude_device = request.args.get('exclude_device') or None
    state = get_playback_state(scope, exclude_device_id=exclude_device)
    if not state:
        return '', 204
    return jsonify(state)


@app.route('/api/playback/state', methods=['PUT'])
def playback_put_state():
    """Persist playback state and update active devices (scoped)."""
    scope = get_scope_from_request()
    data = request.json or {}
    put_playback_state(scope, data)
    return jsonify({"status": "ok"})


@app.route('/api/playback/notify-stop', methods=['POST'])
def playback_notify_stop():
    """Notify the given device (in this scope) to stop playback. Emits playback_stop_requested via Socket.IO."""
    scope = get_scope_from_request()
    data = request.json or {}
    device_id = data.get('device_id')
    if not device_id:
        return jsonify({"error": "device_id required"}), 400
    room = f"playback:{scope}:{device_id}"
    socketio.emit('playback_stop_requested', {}, room=room)
    return jsonify({"status": "sent"})


# --- Downloader Endpoints ---

@app.route('/api/downloader/youtube/search', methods=['GET'])
def youtube_search():
    """YouTube Music or normal YouTube search: plain-text query, returns list of minimal entries (id, title, duration, thumbnail, webpage_url, channel)."""
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({"results": []})
    limit = min(20, max(1, request.args.get('limit', 10, type=int)))
    source = (request.args.get('source') or 'ytmusic').strip().lower()
    use_ytmusic = (source == 'ytmusic')
    try:
        dl = get_downloader(open_browser=False)
        results = dl.downloader.search_youtube(q, max_results=limit, use_ytmusic=use_ytmusic)
        # Hide entries that have no real title (yt-dlp sometimes returns id but no title; we use "Unknown" for resolve but don't show in search)
        results = [r for r in results if (r.get("title") or "").strip() and (r.get("title") or "").strip() != "Unknown"]
        return jsonify({"results": results})
    except Exception as e:
        print(f"API: YouTube search error: {e}")
        return jsonify({"results": [], "error": str(e)}), 500

LIBRARY_SEED_CAP = 50

# --- Discover: keep this path fast and non-blocking ---
# Do NOT call get_downloader() here: we only need Last.fm raw results (resolve=False). Downloader init holds a
# global lock and does yt-dlp setup; calling it here would block the request thread and freeze the whole server.
# Use DISCOVER_SEED_CAP so we do at most ~12 Last.fm requests (5 concurrent) and return in a few seconds.
DISCOVER_SEED_CAP = 12

# Async resolve: avoid blocking the request thread with yt-dlp (15–40s). Jobs run in a thread pool.
_resolve_jobs: dict = {}
_resolve_jobs_lock = threading.Lock()
_resolve_job_ttl_sec = 300
_resolve_executor = None

def _get_resolve_executor():
    global _resolve_executor
    if _resolve_executor is None:
        from concurrent.futures import ThreadPoolExecutor
        _resolve_executor = ThreadPoolExecutor(max_workers=3)
    return _resolve_executor

def _resolve_worker(job_id: str, artist: str, title: str):
    """Run in thread: get_downloader + search. Use first search result; no playability check. Updates job in _resolve_jobs."""
    result = None
    error = None
    try:
        dl = get_downloader(open_browser=False)
        query = f"{artist} {title}".strip()
        results = dl.downloader.search_youtube(query, max_results=5, use_ytmusic=True)
        if not results:
            results = dl.downloader.search_youtube(query, max_results=5, use_ytmusic=False)
        if not results:
            error = "Resolution failed"
        else:
            entry = None
            for candidate in results:
                video_id = candidate.get("id")
                if video_id and _validate_youtube_video_id(str(video_id)):
                    entry = candidate
                    break
            if not entry:
                error = "No video found"
            else:
                video_id = entry.get("id")
                yt_thumb = entry.get("thumbnail") or (f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg" if video_id else "")
                result = {
                    "id": video_id,
                    "title": entry.get("title") or title,
                    "duration": entry.get("duration") or 0,
                    "thumbnail": yt_thumb,
                    "cover_url": yt_thumb,
                    "webpage_url": entry.get("webpage_url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else ""),
                    "channel": entry.get("channel") or "",
                    "artist": artist or entry.get("channel") or ""
                }
    except Exception as e:
        print(f"API: Discover resolve worker error: {e}")
        error = "Resolution failed"
    with _resolve_jobs_lock:
        if job_id in _resolve_jobs:
            _resolve_jobs[job_id]["status"] = "completed" if result else "failed"
            _resolve_jobs[job_id]["result"] = result
            _resolve_jobs[job_id]["error"] = error
            _resolve_jobs[job_id]["finished_at"] = time.time()


@app.route('/api/discover/recommendations', methods=['POST'])
def discover_recommendations():
    """Return raw Last.fm recommendations only (no YouTube resolve). Fast path: no get_downloader(), capped seeds.
    Body: seed_track_ids (list, optional), limit (optional, default 20), exclude_ids (list, optional).
    Resolve to YouTube happens on demand via /api/discover/resolve when the user clicks play/add."""
    try:
        data = request.json or {}
        seed_ids = data.get("seed_track_ids")
        if seed_ids is not None and not isinstance(seed_ids, list):
            seed_ids = []
        exclude_ids = data.get("exclude_ids")
        if not isinstance(exclude_ids, list):
            exclude_ids = []
        limit = min(30, max(1, data.get("limit", 20)))

        lib, _, _ = get_core()
        if not lib.metadata:
            lib.sync_library()
        library_tracks = [t.to_dict() for t in (lib.metadata.tracks or [])]
        track_by_id = {t["id"]: t for t in library_tracks}

        # 1. Build seeds: explicit list or from library (shuffle so refresh gets different seeds)
        seeds = []
        if seed_ids:
            for tid in seed_ids[:10]:
                t = track_by_id.get(str(tid))
                if t and t.get("artist") is not None and t.get("title") is not None:
                    seeds.append({"artist": t["artist"], "title": t["title"]})
        else:
            shuffled = list(library_tracks)
            random.shuffle(shuffled)
            for t in shuffled:
                if len(seeds) >= DISCOVER_SEED_CAP:
                    break
                if t.get("artist") is not None and t.get("title") is not None:
                    seeds.append({"artist": t["artist"], "title": t["title"]})
        if not seeds:
            return jsonify({"results": [], "reason": "no_seeds"}), 200

        # 2. Raw from Last.fm only (no get_downloader; resolve happens on click via /api/discover/resolve)
        from recommendations.service import RecommendationsService
        from recommendations.providers import LastFmRecommendationProvider
        from recommendations.providers.base import Seed
        from recommendations.util import raw_stable_id, raw_to_dict
        from dotenv import dotenv_values

        seed_objs = [Seed(artist=s["artist"], title=s["title"]) for s in seeds]
        random.shuffle(seed_objs)
        _ODST_ENV_PATH = Path(__file__).resolve().parent.parent / "odst_tool" / ".env"
        _env_vars = dotenv_values(_ODST_ENV_PATH) if _ODST_ENV_PATH.exists() else {}
        lastfm_key = os.getenv("LASTFM_API_KEY") or _env_vars.get("LASTFM_API_KEY")
        lastfm_provider = LastFmRecommendationProvider(lastfm_key, None)
        svc = RecommendationsService(lastfm_provider, None)  # downloader=None: resolve=False, do not init ODST here
        request_limit = min(100, limit + 20)
        raw_list, reason = svc.get_recommendations(
            seed_objs, limit=request_limit, library_tracks=library_tracks, resolve=False
        )
        if reason and not raw_list:
            return jsonify({"results": [], "reason": reason}), 200

        # 3. Convert to dicts with stable id; filter by client-sent exclude_ids only
        exclude_set = {str(x) for x in exclude_ids if x}
        results = []
        for r in raw_list:
            artist = r.get("artist") or getattr(r, "artist", "") or ""
            title = r.get("title") or getattr(r, "title", "") or ""
            sid = raw_stable_id(artist, title)
            if sid in exclude_set:
                continue
            d = raw_to_dict(r, sid)
            results.append(d)

        out_results = results[:limit]
        return jsonify({"results": out_results})
    except Exception as e:
        print(f"API: Discover recommendations error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"results": [], "reason": "error", "error": str(e)}), 500


@app.route('/api/discover/cover', methods=['POST'])
def discover_cover():
    """Fetch only cover (thumbnail) for a recommendation via yt-dlp. No audio download.
    Body: { artist, title }. Returns { thumbnail: "url" } or 404 if not found."""
    try:
        data = request.json or {}
        artist = (data.get("artist") or "").strip()
        title = (data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "Missing title"}), 400
        dl = get_downloader(open_browser=False)
        thumbnail = dl.downloader.get_cover_for_query(artist, title)
        if not thumbnail:
            return jsonify({"error": "No cover found"}), 404
        return jsonify({"thumbnail": thumbnail})
    except Exception as e:
        print(f"API: Discover cover error: {e}")
        return jsonify({"error": str(e)}), 500


def _resolve_job_key(artist: str, title: str) -> str:
    return f"{ (artist or '').strip().lower() }|{ (title or '').strip().lower() }"

@app.route('/api/discover/resolve', methods=['GET', 'POST'])
def discover_resolve():
    """Start async resolve (POST) or health check (GET). Returns 202 + job_id; client polls status."""
    if request.method == 'GET':
        return jsonify({"ok": True, "message": "discover resolve route is registered"}), 200
    try:
        data = request.json or {}
        artist = data.get("artist") or ""
        title = data.get("title") or ""
        if not title:
            return jsonify({"error": "Missing title"}), 400
        key = _resolve_job_key(artist, title)
        now = time.time()
        with _resolve_jobs_lock:
            # Reuse existing job if same (artist, title)
            for jid, job in list(_resolve_jobs.items()):
                if job.get("key") != key:
                    continue
                if job.get("status") == "pending":
                    return jsonify({"job_id": jid, "status": "pending"}), 202
                if job.get("status") == "completed" and job.get("result") and (now - job.get("finished_at", 0)) < _resolve_job_ttl_sec:
                    return jsonify({"job_id": jid, "status": "completed", "result": job["result"]}), 200
                if job.get("status") == "failed" and (now - job.get("finished_at", 0)) < _resolve_job_ttl_sec:
                    return jsonify({"job_id": jid, "status": "failed", "error": job.get("error", "Resolution failed")}), 404
                break
            job_id = uuid.uuid4().hex[:12]
            _resolve_jobs[job_id] = {"key": key, "status": "pending", "result": None, "error": None, "finished_at": None}
        _get_resolve_executor().submit(_resolve_worker, job_id, artist, title)
        return jsonify({"job_id": job_id, "status": "pending"}), 202
    except Exception as e:
        print(f"API: Discover resolve error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/discover/resolve/status/<job_id>', methods=['GET'])
def discover_resolve_status(job_id):
    """Poll for async resolve result. Returns status (pending|completed|failed) and result or error."""
    if not job_id:
        return jsonify({"error": "Missing job_id"}), 400
    now = time.time()
    with _resolve_jobs_lock:
        # Prune expired jobs to avoid unbounded growth
        for jid in list(_resolve_jobs):
            j = _resolve_jobs[jid]
            if j.get("finished_at") and (now - j["finished_at"]) > _resolve_job_ttl_sec:
                del _resolve_jobs[jid]
        job = _resolve_jobs.get(job_id)
        if not job:
            return jsonify({"status": "failed", "error": "Unknown job"}), 404
        if job.get("finished_at") and (now - job["finished_at"]) > _resolve_job_ttl_sec:
            del _resolve_jobs[job_id]
            return jsonify({"status": "failed", "error": "Expired"}), 404
        status = job.get("status", "pending")
        out = {"job_id": job_id, "status": status}
        if status == "completed" and job.get("result"):
            out["result"] = job["result"]
        if status == "failed":
            out["error"] = job.get("error", "Resolution failed")
        return jsonify(out), 200
@app.route('/api/downloader/queue', methods=['POST'])
def add_to_downloader_queue():
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No JSON data received"}), 400
            
        items = data.get('items', [])
        print(f"API: [Queue] POST received, items={len(items)}")
        added_ids = []
        accepted = []
        rejected = []

        for idx, item in enumerate(items):
            parsed, err = parse_intake_item(item)
            if err:
                print(f"API: [Queue] Rejected item {idx}: {err}")
                rejected.append({"index": idx, "reason": err, "item": item})
                continue
            parsed["intake_source"] = parsed.get("source_type")
            parsed["intake_payload_hash"] = hashlib.sha256(
                json.dumps(parsed, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()
            new_item = queue_manager_dl.add(parsed)
            added_ids.append(new_item['id'])
            accepted.append({"index": idx, "id": new_item["id"], "source_type": parsed.get("source_type")})
        print(f"API: [Queue] Accepted {len(accepted)}, rejected {len(rejected)}")
        status = "queued" if accepted else "error"
        code = 200 if accepted else 400
        return jsonify({"status": status, "ids": added_ids, "accepted": accepted, "rejected": rejected}), code
    except Exception as e:
        print(f"API: Queue Add Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/downloader/queue/status', methods=['GET'])
def get_downloader_status():
    return jsonify({
        "is_processing": queue_manager_dl.is_processing,
        "queue": queue_manager_dl.queue,
        "logs": queue_manager_dl.log_buffer
    })

@app.route('/api/downloader/queue/<item_id>', methods=['DELETE'])
def remove_from_downloader_queue(item_id):
    queue_manager_dl.remove_item(item_id)
    return jsonify({"status": "removed"})

@app.route('/api/downloader/queue', methods=['DELETE'])
def clear_downloader_queue():
    queue_manager_dl.clear_queue()
    return jsonify({"status": "cleared"})

@app.route('/api/downloader/start', methods=['POST'])
def trigger_downloader():
    if not queue_manager_dl.is_processing:
        print("API: [Queue] Start download requested, starting background processor.")
        threading.Thread(target=process_queue_background, daemon=True).start()
        return jsonify({"status": "started"})
    return jsonify({"status": "already_running"})

# --- Station Engine Admin Endpoints (Parity with Original ODST) ---

@app.route('/api/downloader/optimize', methods=['POST'])
def trigger_downloader_optimize():
    dry_run = request.json.get('dry_run', True)
    threading.Thread(target=run_optimization_task, args=(dry_run,), daemon=True).start()
    return jsonify({"status": "started"})

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

@app.route('/api/downloader/sync', methods=['POST'])
def trigger_downloader_sync():
    threading.Thread(target=run_sync_task, daemon=True).start()
    return jsonify({"status": "started"})

def run_sync_task():
    try:
        dl = get_downloader(log_callback=queue_manager_dl.add_log)
        if not dl.cloud.is_configured():
            queue_manager_dl.add_log("❌ Cloud Sync not configured. Add R2/S3 keys in Settings.")
            return
            
        queue_manager_dl.add_log("--- Starting Cloud Sync ---")
        def cb(msg): queue_manager_dl.add_log(f"☁️ {msg}")
        
        # Ensure library is current
        dl.library = dl._load_library()
        result = dl.cloud.sync_library(dl.library, progress_callback=cb)
        
        if 'error' in result:
            queue_manager_dl.add_log(f"❌ Sync Error: {result['error']}")
        else:
            queue_manager_dl.add_log(f"✅ Sync Complete!")
            queue_manager_dl.add_log(f"   Uploaded: {result.get('uploaded', 0)}, Merged: {result.get('merged', 0)}")
            queue_manager_dl.add_log(f"   Total Remote: {result.get('total_remote', 0)}")
    except Exception as e:
        queue_manager_dl.add_log(f"❌ Critical Sync Error: {e}")

# Legacy fallback (to be removed once UI is updated)
@app.route('/api/download', methods=['POST'])
def start_download_legacy():
    data = request.json
    url = data.get('url')
    if url:
        queue_manager_dl.add({'song_str': url})
        if not queue_manager_dl.is_processing:
            threading.Thread(target=process_queue_background, daemon=True).start()
        return jsonify({"status": "started"})
    return jsonify({"error": "No URL provided"}), 400

# --- Config Endpoints ---

@app.route('/api/downloader/config', methods=['GET'])
def get_downloader_config():
    # SECURITY: Only show secrets to trusted local/Tailscale networks
    is_trusted = is_trusted_network(request.remote_addr)
    
    # Read from environment / .env
    from dotenv import dotenv_values
    env_path = Path('odst_tool/.env')
    env_vars = {}
    if env_path.exists():
        env_vars = dotenv_values(env_path)
    
    # Masking secrets
    def mask(s):
        if not s: return ""
        if len(s) <= 8: return "****"
        return f"{s[:4]}...{s[-4:]}****"

    auto_update = (env_vars.get("YTDLP_AUTO_UPDATE", os.getenv("YTDLP_AUTO_UPDATE", "false")) or "false").strip().lower() in ("true", "1")
    config = {
        "output_dir": env_vars.get("OUTPUT_DIR", os.getenv("OUTPUT_DIR", str(Path.home() / "Music" / "Soundsible"))),
        "quality": env_vars.get("DEFAULT_QUALITY", os.getenv("DEFAULT_QUALITY", "high")),
        "r2_account_id": env_vars.get("R2_ACCOUNT_ID", os.getenv("R2_ACCOUNT_ID", "")),
        "r2_access_key": mask(env_vars.get("R2_ACCESS_KEY_ID", os.getenv("R2_ACCESS_KEY_ID", ""))),
        "r2_secret_key": mask(env_vars.get("R2_SECRET_ACCESS_KEY", os.getenv("R2_SECRET_ACCESS_KEY", ""))),
        "r2_bucket": env_vars.get("R2_BUCKET_NAME", os.getenv("R2_BUCKET_NAME", "")),
        "lastfm_api_key": mask(env_vars.get("LASTFM_API_KEY", os.getenv("LASTFM_API_KEY", ""))),
        "auto_update_ytdlp": auto_update,
    }
    
    # If not on a trusted network, strip ALL sensitive info (even masked ones)
    if not is_trusted:
        sensitive_keys = ["r2_account_id", "r2_access_key", "r2_secret_key", "r2_bucket", "lastfm_api_key"]
        for key in sensitive_keys: config[key] = "HIDDEN (Connect to Tailscale/LAN to view)"

    return jsonify(config)

@app.route('/api/downloader/config', methods=['POST'])
def update_downloader_config():
    # SECURITY: Only allow changes from trusted local/Tailscale networks
    if not is_trusted_network(request.remote_addr):
        return jsonify({"error": "Admin actions restricted to Home Network / Tailscale"}), 403

    data = request.json
    env_path = Path('odst_tool/.env')
    
    from dotenv import set_key, dotenv_values
    if not env_path.exists():
        env_path.touch()
        
    current_vars = dotenv_values(env_path)
    
    # Mapping keys
    key_map = {
        "output_dir": "OUTPUT_DIR",
        "quality": "DEFAULT_QUALITY",
        "r2_account_id": "R2_ACCOUNT_ID",
        "r2_access_key": "R2_ACCESS_KEY_ID",
        "r2_secret_key": "R2_SECRET_ACCESS_KEY",
        "r2_bucket": "R2_BUCKET_NAME",
        "lastfm_api_key": "LASTFM_API_KEY",
        "auto_update_ytdlp": "YTDLP_AUTO_UPDATE",
    }

    for key, env_key in key_map.items():
        val = data.get(key)
        if val is not None:
            # Check if it's a masked value
            if isinstance(val, str) and val.endswith("****"):
                continue  # Skip updating this one
            if key == "auto_update_ytdlp":
                val = "true" if (val is True or (isinstance(val, str) and val.strip().lower() in ("true", "1"))) else "false"
            set_key(str(env_path), env_key, str(val))
            os.environ[env_key] = str(val)
            
    # Restart downloader to pick up changes
    global downloader_service
    downloader_service = None
    
    return jsonify({"status": "updated"})

@app.route('/api/config', methods=['GET'])
def get_config():
    lib, _, _ = get_core()
    if lib.config:
        return jsonify(lib.config.to_dict())
    return jsonify({"error": "Config not found"}), 404

@app.route('/api/config', methods=['POST'])
def update_config():
    data = request.json or {}
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)

    # Merge with existing config so partial updates preserve credentials
    if config_path.exists():
        try:
            with open(config_path, 'r') as f:
                existing = json.load(f)
            for k, v in data.items():
                if v is not None:
                    existing[k] = v
            data = existing
        except Exception:
            pass

    try:
        config = PlayerConfig.from_dict(data)
        with open(config_path, 'w') as f:
            f.write(config.to_json())
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    # Reload core
    global library_manager
    library_manager = None
    get_core()

    return jsonify({"status": "updated"})

# --- Server Management ---

def start_api(port=5005, debug=False):
    global api_observer
    print(f"--- Soundsible API Boot Sequence ---")
    print(f"Target Port: {port}")
    print(f"CWD: {os.getcwd()}")
    print("For full startup (sync + watcher) use: python run.py --daemon")

    _defer_ytdlp_thread = False
    _run_ytdlp_update = None

    try:
        lib, _, _ = get_core()
        print("API: Core services initialized successfully.", flush=True)

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
                        root = Path(__file__).resolve().parent.parent
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
                            print("API: yt-dlp auto-update completed.")
                        else:
                            print(f"API: yt-dlp auto-update failed: {result.stderr or result.stdout or 'unknown'}")
                    except Exception as e:
                        print(f"API: yt-dlp auto-update error: {e}")
                _defer_ytdlp_thread = True
        except Exception:
            pass

        # Start Library File Watcher
        config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
        config_dir.mkdir(parents=True, exist_ok=True)

        event_handler = LibraryFileWatcher(lib)
        api_observer = Observer()
        api_observer.schedule(event_handler, str(config_dir), recursive=False)
        api_observer.start()
        print(f"API: Library File Watcher started on {config_dir}", flush=True)

    except Exception as e:
        print(f"FATAL: Core initialization failed: {e}")
        import traceback
        traceback.print_exc()

    # Diagnose: ensure discover routes are registered (helps debug 404 on resolve)
    try:
        from flask import url_for
        rules = [r.rule for r in app.url_map.iter_rules() if 'discover' in r.rule]
        print(f"API: Discover routes registered: {rules}")
    except Exception as e:
        print(f"API: Could not list routes: {e}")

    # Access Summary
    print("\n" + "="*40)
    print("       SOUNDSIBLE ONLINE")
    print("="*40)
    print(f"Local:  http://localhost:{port}/player/")
    
    endpoints = get_active_endpoints()
    for ip in endpoints:
        print(f"Remote: http://{ip}:{port}/player/")
    print("="*40 + "\n")

    try:
        import gevent
        print("API: gevent active — concurrent request handling enabled")
    except ImportError:
        print("API: gevent not installed — single-threaded (long requests may block others)")
    print(f"API: Starting SocketIO server on 0.0.0.0:{port}...", flush=True)

    from shared.daemon_launcher import MSG_KEEP_TERMINAL_OPEN
    _terminal_msg = MSG_KEEP_TERMINAL_OPEN
    print("", flush=True)
    print("\033[1m" + f"API: {_terminal_msg}" + "\033[0m", flush=True)
    if _defer_ytdlp_thread and _run_ytdlp_update:
        threading.Thread(target=_run_ytdlp_update, daemon=True).start()
    sys.stdout.flush()
    sys.stderr.flush()
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)

if __name__ == '__main__':
    start_api()
