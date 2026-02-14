"""
Unified API Server for Soundsible.
Acts as the bridge between the Python core and various frontends (Tauri, Web, PWA).
"""

import os
import sys
import threading
import json
import uuid
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify, send_file, Response, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS

from shared.models import PlayerConfig, Track, LibraryMetadata, StorageProvider
from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME
from player.library import LibraryManager
from player.engine import PlaybackEngine
from player.queue_manager import QueueManager
from player.favourites_manager import FavouritesManager
from odst_tool.spotify_youtube_dl import SpotifyYouTubeDL
from odst_tool.cloud_sync import CloudSync
from odst_tool.optimize_library import optimize_library
from setup_tool.uploader import UploadEngine
from setup_tool.provider_factory import StorageProviderFactory
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

import socket
import requests
import re
import time

def resolve_spotify_url(url):
    """
    Scrapes the public Spotify page title to get 'Song - Artist'.
    Fallback since API is restricted.
    """
    try:
        # User-Agent is required to get the real page
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        r = requests.get(url, headers=headers, timeout=5)
        if r.status_code == 200:
            # Extract title: <title>Song - Artist | Spotify</title>
            match = re.search(r'<title>(.*?)</title>', r.text)
            if match:
                title_text = match.group(1)
                # Remove suffix
                title_text = title_text.replace(" | Spotify", "").replace(" - song and lyrics by ", " - ")
                return title_text
    except Exception as e:
        print(f"Error resolving URL: {e}")
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
    """Manages the download queue for the Station."""
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
        # Still emit for real-time if socket is alive
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
socketio = SocketIO(app, cors_allowed_origins="*")

# Path to the new Web UI
WEB_UI_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'ui_web')

# Serve Web Player
@app.route('/player/')
def serve_web_player():
    return send_from_directory(WEB_UI_PATH, 'index.html')

@app.route('/player/<path:path>')
def serve_web_player_assets(path):
    return send_from_directory(WEB_UI_PATH, path)

# Global instances
library_manager = None
playback_engine = None
queue_manager = None
favourites_manager = None
downloader_service = None
queue_manager_dl = DownloadQueueManager()

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
            
        print("API: Initializing Queue, Playback Engine and Favourites...")
        queue_manager = QueueManager()
        favourites_manager = FavouritesManager()
        # Note: PlaybackEngine requires an active MPV instance which might need a display.
        # For headless/server mode, we might need to handle this carefully.
        try:
            playback_engine = PlaybackEngine(queue_manager=queue_manager)
        except Exception as e:
            print(f"Warning: Could not initialize playback engine: {e}")
    return library_manager, playback_engine, queue_manager

def get_downloader(output_dir=None, open_browser=False, log_callback=None):
    global downloader_service
    
    def _log(msg):
        print(f"API: {msg}")
        if log_callback:
            log_callback(msg)

    _log("Downloader: Entering setup...")

    # 1. Determine the target output directory
    from dotenv import dotenv_values
    env_path = Path('odst_tool/.env')
    env_vars = dotenv_values(env_path) if env_path.exists() else {}
    
    target_dir = output_dir or env_vars.get("OUTPUT_DIR") or os.getenv("OUTPUT_DIR")
    if not target_dir:
        from odst_tool.config import DEFAULT_OUTPUT_DIR
        target_dir = str(DEFAULT_OUTPUT_DIR)
    
    target_path = Path(target_dir).expanduser().absolute()

    # 2. Check if we need to (re)initialize
    should_init = False
    if not downloader_service:
        should_init = True
    elif downloader_service.output_dir != target_path:
        _log(f"Path changed to {target_path}. Re-initializing...")
        should_init = True

    if should_init:
        _log(f"Step 1/3: Accessing storage at {target_path}...")
        try:
            target_path.mkdir(parents=True, exist_ok=True)
            _log("Step 1.1: Path is accessible.")
        except Exception as e:
            _log(f"⚠️ Step 1 Warning: NAS/Path issue: {e}")

        _log("Step 2/3: Loading Soundsible core...")
        lib_core, _, _ = get_core()
        
        _log("Step 3/3: Loading credentials & Starting Engine...")
        token = env_vars.get("SPOTIFY_ACCESS_TOKEN") or os.getenv("SPOTIFY_ACCESS_TOKEN")
        client_id = env_vars.get("SPOTIFY_CLIENT_ID") or os.getenv("SPOTIFY_CLIENT_ID")
        client_secret = env_vars.get("SPOTIFY_CLIENT_SECRET") or os.getenv("SPOTIFY_CLIENT_SECRET")
        quality = env_vars.get("DEFAULT_QUALITY", lib_core.config.quality_preference if lib_core.config else "high")
        from odst_tool.config import DEFAULT_WORKERS
        
        _log(f"Initializing Downloader (Quality: {quality})...")
        if token:
            _log("   - Mode: Spotify Token")
            downloader_service = SpotifyYouTubeDL(target_path, DEFAULT_WORKERS, access_token=token, quality=quality, open_browser=open_browser)
        elif client_id and client_secret:
            _log("   - Mode: Spotify API Keys")
            downloader_service = SpotifyYouTubeDL(target_path, DEFAULT_WORKERS, skip_auth=False, quality=quality, client_id=client_id, client_secret=client_secret, open_browser=open_browser)
        else:
            _log("   - Mode: Direct Download Only")
            downloader_service = SpotifyYouTubeDL(target_path, DEFAULT_WORKERS, skip_auth=True, quality=quality, open_browser=open_browser)
            
        _log("✅ Downloader Engine Ready.")
        
    return downloader_service

def process_queue_background():
    global downloader_service, queue_manager_dl
    if queue_manager_dl.is_processing:
        return
        
    queue_manager_dl.is_processing = True
    queue_manager_dl.add_log("Station: Background processor started.")
    
    try:
        while True:
            pending = queue_manager_dl.get_pending()
            if not pending:
                queue_manager_dl.add_log("Station: Queue empty, idling.")
                break
                
            item = pending[0]
            item_id = item['id']
            song_str = item.get('song_str')
            spotify_data = item.get('spotify_data')
            output_dir = item.get('output_dir')
            
            queue_manager_dl.add_log(f"Preparing: {song_str or item_id}...")
            queue_manager_dl.update_status(item_id, 'downloading')
            socketio.emit('downloader_update', {'id': item_id, 'status': 'downloading'})
            
            try:
                dl = get_downloader(output_dir, log_callback=queue_manager_dl.add_log)
                queue_manager_dl.add_log(f"Processing: {song_str or item_id}...")
                
                # Resolve Spotify URL if needed
                if song_str and "spotify.com" in song_str:
                    queue_manager_dl.add_log(f"🔎 Resolving Spotify Link...")
                    resolved_name = resolve_spotify_url(song_str)
                    if resolved_name:
                        queue_manager_dl.add_log(f"   Identified as: {resolved_name}")
                        song_str = resolved_name
                    else:
                        queue_manager_dl.add_log(f"⚠️ Could not resolve Spotify link. Trying direct download.")

                # Handle Playlist Fetching
                if spotify_data and spotify_data.get('type') == 'playlist':
                    queue_manager_dl.add_log(f"Fetching tracks for playlist {spotify_data['id']}...")
                    tracks = dl.spotify.get_playlist_tracks(spotify_data['id'])
                    
                    # Add all tracks as new pending items
                    for t in tracks:
                        name = t['name']
                        artist = t['artists'][0]['name']
                        queue_manager_dl.add({
                            'song_str': f"{artist} - {name}",
                            'spotify_data': t,
                            'output_dir': output_dir
                        })
                    
                    queue_manager_dl.update_status(item_id, 'completed')
                    socketio.emit('downloader_update', {'id': item_id, 'status': 'completed'})
                    queue_manager_dl.add_log(f"✅ Queued {len(tracks)} tracks from playlist.")
                    continue # Move to next item in while loop
                
                track = None
                if spotify_data:
                    meta = dl.spotify.extract_track_metadata(spotify_data)
                    track = dl.downloader.process_track(meta)
                elif song_str:
                    # Direct URL or simple string
                    if "youtube.com" in song_str or "youtu.be" in song_str:
                        queue_manager_dl.add_log(f"Downloading direct YouTube: {song_str}...")
                        track = dl.downloader.process_video(song_str)
                    else:
                        # Manual search
                        fake_meta = {
                            'title': song_str,
                            'artist': 'Unknown',
                            'album': 'Manual',
                            'duration_sec': 0,
                            'id': f"manual_{uuid.uuid4().hex[:8]}"
                        }
                        track = dl.downloader.process_track(fake_meta)
                
                if track:
                    # Update ODST internal record
                    dl.library.add_track(track)
                    dl.save_library()
                    
                    # Update main Soundsible library core
                    lib, _, _ = get_core()
                    if lib.metadata:
                        lib.metadata.add_track(track)
                        # Persist to DB and library.json
                        lib._save_metadata()
                        
                        # Signal all clients to refresh
                        socketio.emit('library_updated')
                    
                    # Auto-clear successful items from queue
                    queue_manager_dl.remove_item(item_id)
                    socketio.emit('downloader_update', {'id': item_id, 'status': 'completed', 'track': track.to_dict()})
                    queue_manager_dl.add_log(f"✅ Finished & Cleared: {track.artist} - {track.title}")
                else:
                    raise Exception("Downloader returned no track. Check logs for details.")
                    
            except Exception as e:
                print(f"API Downloader Error: {e}")
                import traceback
                traceback.print_exc()
                queue_manager_dl.update_status(item_id, 'failed', error=str(e))
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

@app.route('/api/static/cover/<track_id>', methods=['GET'])
def get_track_cover(track_id):
    """Serve album cover art, fetching it if missing."""
    print(f"DEBUG: [Cover] Request for ID: {track_id}")
    lib, _, _ = get_core()
    
    # Resolve track
    track = None
    if lib.metadata:
        track = lib.metadata.get_track_by_id(track_id)
    if not track:
        db_tracks = lib.db.get_all_tracks()
        track = next((t for t in db_tracks if t.id == track_id), None)
        
    if not track:
        print(f"DEBUG: [Cover] ❌ Track {track_id} not found")
        return jsonify({"error": "Track not found"}), 404
        
    # Use unified resolver
    path = lib.get_cover_url(track)
    print(f"DEBUG: [Cover] Resolved path: {path}")
    
    if path and os.path.exists(path):
        print(f"DEBUG: [Cover] ✅ Serving file: {path}")
        return send_file(path, mimetype='image/jpeg')
    
    # Return placeholder while fetching
    placeholder = os.path.join(WEB_UI_PATH, 'assets/icons/icon-192.png')
    if os.path.exists(placeholder):
        print(f"DEBUG: [Cover] ⏳ Returning placeholder for {track_id}")
        return send_file(placeholder, mimetype='image/png')
        
    print(f"DEBUG: [Cover] ❌ No cover or placeholder found")
    return jsonify({"error": "Cover not ready"}), 404

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

# --- Downloader Endpoints ---

@app.route('/api/downloader/queue', methods=['POST'])
def add_to_downloader_queue():
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No JSON data received"}), 400
            
        items = data.get('items', [])
        added_ids = []
        
        for item in items:
            new_item = queue_manager_dl.add(item)
            added_ids.append(new_item['id'])
            
        return jsonify({"status": "queued", "ids": added_ids})
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
        threading.Thread(target=process_queue_background, daemon=True).start()
        return jsonify({"status": "started"})
    return jsonify({"status": "already_running"})

@app.route('/api/downloader/spotify/playlists', methods=['GET'])
def get_spotify_playlists():
    dl = get_downloader(open_browser=False)
    if not dl.spotify.client:
        return jsonify({"error": "Spotify not authenticated"}), 401
    
    try:
        playlists = dl.spotify.get_user_playlists()
        return jsonify({"playlists": playlists})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Station Admin Endpoints (Parity with Original ODST) ---

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
    # Read from environment / .env
    # For a real implementation, we should read the .env file directly to be sure
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

    config = {
        "spotify_client_id": env_vars.get("SPOTIFY_CLIENT_ID", os.getenv("SPOTIFY_CLIENT_ID", "")),
        "spotify_client_secret": mask(env_vars.get("SPOTIFY_CLIENT_SECRET", os.getenv("SPOTIFY_CLIENT_SECRET", ""))),
        "output_dir": env_vars.get("OUTPUT_DIR", os.getenv("OUTPUT_DIR", str(Path.home() / "Music" / "Spotify"))),
        "quality": env_vars.get("DEFAULT_QUALITY", os.getenv("DEFAULT_QUALITY", "high")),
        "r2_account_id": env_vars.get("R2_ACCOUNT_ID", os.getenv("R2_ACCOUNT_ID", "")),
        "r2_access_key": mask(env_vars.get("R2_ACCESS_KEY_ID", os.getenv("R2_ACCESS_KEY_ID", ""))),
        "r2_secret_key": mask(env_vars.get("R2_SECRET_ACCESS_KEY", os.getenv("R2_SECRET_ACCESS_KEY", ""))),
        "r2_bucket": env_vars.get("R2_BUCKET_NAME", os.getenv("R2_BUCKET_NAME", ""))
    }
    return jsonify(config)

@app.route('/api/downloader/config', methods=['POST'])
def update_downloader_config():
    data = request.json
    env_path = Path('odst_tool/.env')
    
    from dotenv import set_key, dotenv_values
    if not env_path.exists():
        env_path.touch()
        
    current_vars = dotenv_values(env_path)
    
    # Mapping keys
    key_map = {
        "spotify_client_id": "SPOTIFY_CLIENT_ID",
        "spotify_client_secret": "SPOTIFY_CLIENT_SECRET",
        "output_dir": "OUTPUT_DIR",
        "quality": "DEFAULT_QUALITY",
        "r2_account_id": "R2_ACCOUNT_ID",
        "r2_access_key": "R2_ACCESS_KEY_ID",
        "r2_secret_key": "R2_SECRET_ACCESS_KEY",
        "r2_bucket": "R2_BUCKET_NAME"
    }
    
    for key, env_key in key_map.items():
        val = data.get(key)
        if val is not None:
            # Check if it's a masked value
            if isinstance(val, str) and val.endswith("****"):
                continue # Skip updating this one
            
            set_key(str(env_path), env_key, val)
            os.environ[env_key] = val
            
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
    data = request.json
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(config_path, 'w') as f:
        json.dump(data, f, indent=2)
    
    # Reload core
    global library_manager
    library_manager = None 
    get_core()
    
    return jsonify({"status": "updated"})

# --- Server Management ---

def start_api(port=5005, debug=False):
    print(f"--- Soundsible API Boot Sequence ---")
    print(f"Target Port: {port}")
    print(f"CWD: {os.getcwd()}")
    
    try:
        lib, _, _ = get_core()
        print("API: Core services initialized successfully.")
        
        # Start Library File Watcher
        config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
        config_dir.mkdir(parents=True, exist_ok=True)
        
        event_handler = LibraryFileWatcher(lib)
        observer = Observer()
        observer.schedule(event_handler, str(config_dir), recursive=False)
        observer.start()
        print(f"API: Library File Watcher started on {config_dir}")
        
    except Exception as e:
        print(f"FATAL: Core initialization failed: {e}")
        import traceback
        traceback.print_exc()

    # Access Summary
    print("\n" + "="*40)
    print("       SOUNDSIBLE ONLINE")
    print("="*40)
    print(f"Local:  http://localhost:{port}/player/")
    
    endpoints = get_active_endpoints()
    for ip in endpoints:
        print(f"Remote: http://{ip}:{port}/player/")
    print("="*40 + "\n")

    print(f"API: Starting SocketIO server on 0.0.0.0:{port}...")
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)

if __name__ == '__main__':
    start_api()
