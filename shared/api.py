"""
Unified API Server for Soundsible.
Acts as the bridge between the Python core and various frontends (Tauri, Web, PWA).
"""

import os
import sys
import threading
import json
from pathlib import Path
from flask import Flask, request, jsonify, send_file, Response, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS

from shared.models import PlayerConfig, Track, LibraryMetadata, StorageProvider
from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME
from player.library import LibraryManager
from player.engine import PlaybackEngine
from player.queue_manager import QueueManager
from odst_tool.spotify_youtube_dl import SpotifyYouTubeDL
from setup_tool.uploader import UploadEngine
from setup_tool.provider_factory import StorageProviderFactory

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
downloader = None

def get_core():
    global library_manager, playback_engine, queue_manager
    if not library_manager:
        library_manager = LibraryManager()
        # Ensure we have metadata loaded from local cache at minimum
        if not library_manager.metadata:
            cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
            library_manager._load_from_cache(cache_path)
            
        queue_manager = QueueManager()
        # Note: PlaybackEngine requires an active MPV instance which might need a display.
        # For headless/server mode, we might need to handle this carefully.
        try:
            playback_engine = PlaybackEngine(queue_manager=queue_manager)
        except Exception as e:
            print(f"Warning: Could not initialize playback engine: {e}")
    return library_manager, playback_engine, queue_manager

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
    if not lib.metadata:
        lib.sync_library()
    
    if lib.metadata:
        return jsonify(json.loads(lib.metadata.to_json()))
    return jsonify({"error": "Library not loaded"}), 404

@app.route('/api/library/sync', methods=['POST'])
def sync_library():
    lib, _, _ = get_core()
    success = lib.sync_library()
    return jsonify({"status": "success" if success else "failed"})

@app.route('/api/library/search', methods=['GET'])
def search_library():
    lib, _, _ = get_core()
    query = request.args.get('q', '').lower()
    
    # Use high-performance DB search
    results = lib.search(query)
    return jsonify([t.to_dict() for t in results[:50]])

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

@app.route('/api/download', methods=['POST'])
def start_download():
    global downloader
    data = request.json
    url = data.get('url') # YouTube or Spotify URL
    
    if not downloader:
        # Init downloader with quality preference from config
        lib, _, _ = get_core()
        quality = lib.config.quality_preference if lib.config else "high"
        
        from odst_tool.config import DEFAULT_OUTPUT_DIR, DEFAULT_WORKERS
        downloader = SpotifyYouTubeDL(DEFAULT_OUTPUT_DIR, DEFAULT_WORKERS, skip_auth=True, quality=quality)
    
    def download_task():
        track = downloader.downloader.process_video(url)
        if track:
            # Add to ODST internal library
            downloader.library.add_track(track)
            downloader.save_library()
            
            # ALSO update the live library manager in Core API
            lib, _, _ = get_core()
            if lib.metadata:
                lib.metadata.add_track(track)
            
            socketio.emit('download_complete', {'track': track.title, 'id': track.id})
        else:
            socketio.emit('download_failed', {'url': url})

    threading.Thread(target=download_task).start()
    return jsonify({"status": "started"})

# --- Config Endpoints ---

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
    print(f"Starting Soundsible Core API on port {port}...")
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)

if __name__ == '__main__':
    start_api()
