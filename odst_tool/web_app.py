from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import threading
import os
from pathlib import Path
from dotenv import set_key
from .config import (
    DEFAULT_OUTPUT_DIR, 
    DEFAULT_WORKERS, 
    DEFAULT_BITRATE, 
    DEFAULT_COOKIE_BROWSER,
    QUALITY_PROFILES,
    DEFAULT_QUALITY
)
from .spotify_youtube_dl import SpotifyYouTubeDL
from .spotify_library import SpotifyLibrary
import spotipy

# Initialize App
app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, async_mode='threading')

from .cloud_sync import CloudSync
from .optimize_library import optimize_library

# Global State
current_output_dir = DEFAULT_OUTPUT_DIR
current_quality = DEFAULT_QUALITY
optimization_thread = None

def init_downloader():
    # Helper to re-init with best available auth
    token = os.getenv("SPOTIFY_ACCESS_TOKEN")
    client_id = os.getenv("SPOTIFY_CLIENT_ID")
    client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
    
    # Priority: Token > Client ID/Secret > None
    if token:
        return SpotifyYouTubeDL(current_output_dir, DEFAULT_WORKERS, access_token=token, cookie_browser=DEFAULT_COOKIE_BROWSER, quality=current_quality)
    elif client_id and client_secret:
        return SpotifyYouTubeDL(current_output_dir, DEFAULT_WORKERS, skip_auth=False, cookie_browser=DEFAULT_COOKIE_BROWSER, quality=current_quality)
    else:
        return SpotifyYouTubeDL(current_output_dir, DEFAULT_WORKERS, skip_auth=True, cookie_browser=DEFAULT_COOKIE_BROWSER, quality=current_quality)

downloader_app = init_downloader()
cloud_sync = CloudSync(current_output_dir)

@app.route('/')
def index():
    # Check if credentials exist
    has_creds = (os.getenv("SPOTIFY_CLIENT_ID") and os.getenv("SPOTIFY_CLIENT_SECRET")) or os.getenv("SPOTIFY_ACCESS_TOKEN")
    has_cloud = cloud_sync.is_configured()
    return render_template('index.html', 
                         output_dir=str(current_output_dir), 
                         has_creds=has_creds,
                         has_cloud=has_cloud,
                         quality=current_quality,
                         quality_profiles=QUALITY_PROFILES)

@app.route('/settings', methods=['POST'])
def update_settings():
    global current_output_dir, current_quality, downloader_app, cloud_sync
    data = request.json
    
    # Update Output Directory
    new_dir = data.get('output_dir')
    if new_dir:
        current_output_dir = Path(new_dir)
    
    # Update Quality
    new_quality = data.get('quality')
    if new_quality and new_quality in QUALITY_PROFILES:
        current_quality = new_quality
    
    # Update Credentials
    client_id = data.get('client_id')
    client_secret = data.get('client_secret')
    access_token = data.get('access_token')
    
    env_path = Path('.env')
    if not env_path.exists(): env_path.touch()
    
    if access_token:
        # Token overrides everything for this session
        set_key(str(env_path), "SPOTIFY_ACCESS_TOKEN", access_token)
        os.environ["SPOTIFY_ACCESS_TOKEN"] = access_token
    
    if client_id and client_secret:
        set_key(str(env_path), "SPOTIFY_CLIENT_ID", client_id)
        set_key(str(env_path), "SPOTIFY_CLIENT_SECRET", client_secret)
        os.environ["SPOTIFY_CLIENT_ID"] = client_id
        os.environ["SPOTIFY_CLIENT_SECRET"] = client_secret
        
    # Re-init downloader
    downloader_app = init_downloader()

    return jsonify({"status": "ok", "msg": "Settings updated!"})

@app.route('/settings/cloud', methods=['POST'])
def update_cloud_settings():
    global cloud_sync
    data = request.json
    
    env_path = Path('.env')
    if not env_path.exists(): env_path.touch()
    
    set_key(str(env_path), "R2_ACCOUNT_ID", data.get('account_id', ''))
    set_key(str(env_path), "R2_ACCESS_KEY_ID", data.get('access_key', ''))
    set_key(str(env_path), "R2_SECRET_ACCESS_KEY", data.get('secret_key', ''))
    set_key(str(env_path), "R2_BUCKET_NAME", data.get('bucket', ''))
    
    # Reload vars
    os.environ["R2_ACCOUNT_ID"] = data.get('account_id', '')
    os.environ["R2_ACCESS_KEY_ID"] = data.get('access_key', '')
    os.environ["R2_SECRET_ACCESS_KEY"] = data.get('secret_key', '')
    os.environ["R2_BUCKET_NAME"] = data.get('bucket', '')
    
    cloud_sync = CloudSync(current_output_dir)
    return jsonify({"status": "ok", "msg": "Cloud config saved"})

@app.route('/optimize', methods=['POST'])
def trigger_optimize():
    global optimization_thread
    if optimization_thread and optimization_thread.is_alive():
         return jsonify({"status": "error", "msg": "Optimization already running"})
         
    dry_run = request.json.get('dry_run', True)
    
    optimization_thread = threading.Thread(target=run_optimization, args=(dry_run,))
    optimization_thread.start()
    return jsonify({"status": "started", "msg": "Optimization started"})

def run_optimization(dry_run):
    mode = "DRY RUN" if dry_run else "LIVE"
    socketio.emit('status', {'msg': f'Optimizing Library ({mode})...'})
    socketio.emit('log', {'data': f"--- Starting Optimization ({mode}) ---"})
    
    def cb(msg):
        socketio.emit('log', {'data': f"🔧 {msg}"})
        
    try:
        optimize_library(current_output_dir, dry_run=dry_run, progress_callback=cb)
    except Exception as e:
        socketio.emit('log', {'data': f"❌ Error: {e}"})
        
    socketio.emit('status', {'msg': 'Ready'})
    socketio.emit('log', {'data': "--- Optimization Finished ---"})
    
    # Reload library if not dry run
    if not dry_run:
        downloader_app.library = downloader_app._load_library()
        socketio.emit('log', {'data': "Library reloaded."})

@app.route('/sync', methods=['POST'])
def trigger_sync():
    if not cloud_sync.is_configured():
        return jsonify({"status": "error", "msg": "Cloud not configured"})
        
    threading.Thread(target=run_sync_process).start()
    return jsonify({"status": "started"})

def run_sync_process(delete_after=False):
    socketio.emit('status', {'msg': 'Syncing to Cloud...'})
    socketio.emit('log', {'data': "--- Starting Cloud Sync ---"})
    
    def cb(msg):
        socketio.emit('log', {'data': f"☁️ {msg}"})
        
    try:
        # Reload library to ensure current state
        downloader_app.library = downloader_app._load_library()
        
        result = cloud_sync.sync_library(downloader_app.library, progress_callback=cb, delete_local=delete_after)
        
        if 'error' in result:
             socketio.emit('log', {'data': f"❌ Sync Error: {result['error']}"})
        else:
             socketio.emit('log', {'data': f"✅ Sync Complete!"})
             socketio.emit('log', {'data': f"   Uploaded: {result['uploaded']}"})
             socketio.emit('log', {'data': f"   Merged: {result['merged']}"})
             if delete_after:
                  socketio.emit('log', {'data': f"   Deleted Local: {result.get('deleted', 0)}"})
             socketio.emit('log', {'data': f"   Total Remote: {result['total_remote']}"})
             
    except Exception as e:
        socketio.emit('log', {'data': f"❌ Critical Sync Error: {e}"})
        
    socketio.emit('status', {'msg': 'Ready'})
    socketio.emit('log', {'data': "--- Sync Finished ---"})



@app.route('/spotify/playlists', methods=['GET'])
def get_playlists():
    try:
        # Check if auth is working
        if not downloader_app.spotify.client:
             return jsonify({"error": "Spotify not authenticated. Please add API keys in Settings."}), 401
             
        playlists = downloader_app.spotify.get_user_playlists()
        # Simplify for frontend
        data = [{'name': p['name'], 'id': p['id'], 'count': p['tracks']['total']} for p in playlists]
        return jsonify({"playlists": data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/queue/spotify', methods=['POST'])
def add_spotify_to_queue():
    data = request.json
    source_type = data.get('type') # 'playlist' or 'liked'
    playlist_id = data.get('id')
    
    if not downloader_app.spotify.client:
        return jsonify({"error": "Spotify not authenticated"}), 401

    threading.Thread(target=fetch_spotify_tracks, args=(source_type, playlist_id)).start()
    return jsonify({"status": "fetching"})

def fetch_spotify_tracks(source_type, playlist_id):
    socketio.emit('status', {'msg': 'Fetching from Spotify...'})
    socketio.emit('log', {'data': f"--- Fetching {source_type} ---"})
    
    try:
        tracks = []
        if source_type == 'liked':
            tracks = downloader_app.spotify.get_all_liked_songs()
        elif source_type == 'playlist' and playlist_id:
            tracks = downloader_app.spotify.get_playlist_tracks(playlist_id)
            
        socketio.emit('log', {'data': f"Found {len(tracks)} tracks."})
        
        # Add to queue in frontend
        for t in tracks:
            # Format for frontend display
            name = t['name']
            artist = t['artists'][0]['name']
            song_str = f"{artist} - {name}"
            
            # Estimate Size: (Duration (s) * Bitrate) / 8 / 1024
            bitrate = QUALITY_PROFILES[current_quality]['bitrate'] or 320
            duration_sec = t['duration_ms'] / 1000
            estimated_mb = (duration_sec * bitrate) / 8192 # 8 * 1024
            
            # Send metadata needed for download
            # We construct a task object
            task = {
                'song_str': song_str,
                'spotify_data': t,
                'estimated_mb': round(estimated_mb, 2)
            }
            socketio.emit('add_to_queue', task)
            
    except Exception as e:
        socketio.emit('log', {'data': f"Error fetching: {str(e)}"})
        
    socketio.emit('status', {'msg': 'Ready'})

@app.route('/queue', methods=['POST'])
def add_to_queue():
    data = request.json
    song = data.get('song')
    if song:
        socketio.emit('log', {'data': f"Added to queue: {song}"})
        # Approx 3.5 mins (210s) @ Quality Bitrate
        bitrate = QUALITY_PROFILES[current_quality]['bitrate'] or 320
        est_mb = (210 * bitrate) / 8192
        return jsonify({"status": "ok", "song": song, "estimated_mb": round(est_mb, 2)})
    return jsonify({"status": "error"}), 400

@app.route('/queue/bulk', methods=['POST'])
def add_bulk_queue():
    data = request.json
    songs = data.get('songs', [])
    response_data = []
    
    count = 0
    for song in songs:
        if song.strip():
            # Approx 3.5 mins (210s)
            bitrate = QUALITY_PROFILES[current_quality]['bitrate'] or 320
            est_mb = (210 * bitrate) / 8192
            response_data.append({
                "song_str": song.strip(), 
                "estimated_mb": round(est_mb, 2)
            })
            count += 1
            
    if count > 0:
        socketio.emit('log', {'data': f"Batch queued {count} items successfully."})
            
    return jsonify({"status": "ok", "items": response_data})

@app.route('/start', methods=['POST'])
def start_download():
    data = request.json
    queue = data.get('queue', []) # List of objects with spotify_data or manual strings
    auto_sync = data.get('auto_sync', False) # Checkbox state
    
    if not queue:
        return jsonify({"status": "empty"})

    threading.Thread(target=process_queue, args=(queue, auto_sync)).start()
    return jsonify({"status": "started"})

import requests
import re

def resolve_spotify_url(url):
    """
    Scrapes the public Spotify page title to get 'Song - Artist'.
    Fallback since API is banned.
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
                # Sometimes it is "Song - Artist", sometimes "Artist - Song".
                # Spotify Web Title usually: "Song - Artist"
                return title_text
    except Exception as e:
        print(f"Error resolving URL: {e}")
    return None

def process_queue(queue, auto_sync=False):
    socketio.emit('status', {'msg': 'Downloading...'})
    
    for item in queue:
        try:
            # Item can be string (manual) or object (from spotify)
            if isinstance(item, str):
                song_str = item
                spotify_data = None
            else:
                song_str = item.get('song_str')
                spotify_data = item.get('spotify_data')

            if not song_str:
                socketio.emit('log', {'data': f"Skipping invalid item..."})
                continue

            # Check for URL
            if "http" in song_str:
                if "spotify.com" in song_str:
                     socketio.emit('log', {'data': f"🔎 Resolving Link: {song_str}..."})
                     resolved_name = resolve_spotify_url(song_str)
                     if resolved_name:
                         song_str = resolved_name
                         socketio.emit('log', {'data': f"   identified: {song_str}"})
                     else:
                         socketio.emit('log', {'data': f"⚠️ Could not resolve link. Skipping."})
                         socketio.emit('item_error', {'id': song_str})
                         continue
                
                # Check for YouTube URL (new logic)
                elif "youtube.com" in song_str or "youtu.be" in song_str:
                    socketio.emit('log', {'data': f"Processing YouTube Direct: {song_str}..."})
                    socketio.emit('item_processing', {'id': song_str})
                    
                    try:
                        track = downloader_app.downloader.process_video(song_str)
                        if track:
                            downloader_app.library.add_track(track)
                            socketio.emit('log', {'data': f"✅ Downloaded: {track.artist} - {track.title}"})
                            socketio.emit('item_done', {'id': song_str})
                        else:
                            socketio.emit('log', {'data': f"❌ Failed to download video."})
                            socketio.emit('item_error', {'id': song_str})
                    except Exception as e:
                        socketio.emit('log', {'data': f"❌ Error: {e}"})
                        socketio.emit('item_error', {'id': song_str})
                    continue # Skip the rest of loop for this item

            socketio.emit('log', {'data': f"Processing: {song_str}..."})
            socketio.emit('item_processing', {'id': song_str}) # Highlight in UI
            
            track = None
            
            if spotify_data:
                # Use real Spotify Metadata
                meta = downloader_app.spotify.extract_track_metadata(spotify_data)
                track = downloader_app.downloader.process_track(meta)
            else:
                # Manual Fallback
                parts = song_str.split("-")
                # Heuristic: Spotify titles are "Song - Artist". 
                # YouTube search expects "Artist - Title" ideally, but fuzzy works.
                # Let's hope the searcher is smart enough (it usually is).
                
                parts = [p.strip() for p in parts]
                if len(parts) >= 2:
                    # Assume Part 0 is Title, Part 1 is Artist (Spotify style)
                    # BUT user manual input might be Artist - Title
                    # Let's just treat the whole string as the query for simplicity in search?
                    # No, we need structure for metadata.
                    
                    # If it came from our resolver, it's likely "Song - Artist"
                    # We can try to flip it if it looks like that?
                    # Let's just assign simple values and let downloader handle the search.
                    
                    title = parts[0]
                    artist = parts[1]
                else:
                    title = song_str
                    artist = "Unknown"
                
                fake_meta = {
                    'title': title,
                    'artist': artist,
                    'album': 'Manual Download',
                    'duration_sec': 0, # Skip checks
                    'id': f"manual_{hash(song_str)}",
                    'release_date': None,
                    'track_number': None,
                    'album_art_url': None
                }
                track = downloader_app.downloader.process_track(fake_meta)
            
            if track:
                downloader_app.library.add_track(track)
                socketio.emit('log', {'data': f"✅ Downloaded: {song_str}"})
                socketio.emit('item_done', {'id': song_str})
            else:
                socketio.emit('log', {'data': f"❌ Failed: {song_str}"})
                socketio.emit('item_error', {'id': song_str})
                
        except Exception as e:
            # Catch ALL exceptions per item to ensure loop doesn't break
            # And try to emit error, but ignore if emit fails
            try:
                socketio.emit('log', {'data': f"Error processing {song_str}: {str(e)}"})
            except:
                print(f"Critical Socket Error processing {song_str}: {e}")
            
    try:
        downloader_app.save_library()
    except Exception as e:
        print(f"Error saving library: {e}")
    
    if auto_sync:
        socketio.emit('log', {'data': ">> Auto-Sync Enabled: Starting Cloud Upload..."})
        run_sync_process(delete_after=True) # This function emits its own status/logs
    else:
        socketio.emit('status', {'msg': 'Ready'})
        socketio.emit('log', {'data': "--- All Done ---"})

if __name__ == '__main__':
    import webbrowser
    import os
    
    # Only open browser in the reloader process (or main process if debug=False)
    # The WERKZEUG_RUN_MAIN env var is set by Flask's reloader in the child process.
    # We want to open it only on the first run (when it's NOT set).
    if not os.environ.get("WERKZEUG_RUN_MAIN"):
        print("Opening browser at http://localhost:5000 ...")
        # Use a timer to delay slightly ensures server is likely listening
        threading.Timer(1.0, lambda: webbrowser.open('http://localhost:5000')).start()
        
    socketio.run(app, debug=True, port=5000, host='0.0.0.0')
