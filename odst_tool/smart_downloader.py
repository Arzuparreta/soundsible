
import sys
import shutil
import time
import os
import tempfile
from pathlib import Path

# Add project root to path if needed (for GUI usage it might be already there)
# But for safety, we assume imports work relative to project root.

class SmartDownloader:
    def __init__(self, output_dir=None):
        # We ALWAYS use a temporary directory for staging to prevent 
        # accidental deletion of the user's actual music library.
        self.staging_dir = Path(tempfile.mkdtemp(prefix="soundsible_staging_"))
        
        # Reference to the final library root if provided
        self.library_root = Path(output_dir) if output_dir else None
            
        self.staging_dir.mkdir(parents=True, exist_ok=True)
        self.downloader = None
        self.spotify = None
        self._log_callback = print # Default to print
        
    def set_log_callback(self, callback):
        """Set a callback for log messages (msg, level)."""
        self._log_callback = callback
        
    def log(self, msg, level="info"):
        if self._log_callback == print:
            print(f"[{level.upper()}] {msg}")
        else:
            self._log_callback(msg, level)
            
    def _lazy_load(self):
        if self.downloader:
             return
             
        self.log("Initializing downloader engine...", "info")
        try:
            # Import ODST-Tool components here to avoid startup hangs
            from odst_tool.youtube_downloader import YouTubeDownloader
            from odst_tool.spotify_auth import SpotifyAuth
            from odst_tool.spotify_library import SpotifyLibrary
            from shared.constants import DEFAULT_CONFIG_DIR
            from odst_tool.config import DEFAULT_QUALITY
            
            # Cookie logic
            cookie_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "cookies.txt"
            cookie_file = str(cookie_path) if cookie_path.exists() else None
            
            # Browser fallback REMOVED to prevent conflict with Android client workaround
            # The android client workaround is robust enough without cookies.
            browser = None 
            
            self.downloader = YouTubeDownloader(
                self.staging_dir, 
                cookie_file=cookie_file,
                cookie_browser=browser,
                quality=DEFAULT_QUALITY
            )
            self.spotify = SpotifyLibrary(skip_auth=False) 
        except ImportError as e:
            self.log(f"Failed to load downloader modules: {e}", "error")
            raise e
        except Exception as e:
            self.log(f"Initialization error (possible network/hang): {e}", "error")
            raise e

    def cleanup(self):
        if self.staging_dir.exists():
            try:
                shutil.rmtree(self.staging_dir)
            except:
                pass

    def process_query(self, query, quality=None):
        self._lazy_load()
        
        # Override quality if provided
        if quality:
            self.downloader.quality = quality
            
        self.log(f"Processing query: {query} (Quality: {self.downloader.quality})", "info")
        
        track = None
        
        # 1. Check if it's a URL
        if "youtube.com" in query or "youtu.be" in query:
             self.log("Detected YouTube URL...", "info")
             track = self.downloader.process_video(query)
             
        elif "spotify.com" in query:
             self.log("Detected Spotify URL...", "info")
             try:
                 track_id = query.split("/track/")[1].split("?")[0]
                 if self.spotify.client:
                     sp_track = self.spotify.client.track(track_id)
                     meta = self.spotify.extract_track_metadata(sp_track)
                     track = self.downloader.process_track(meta)
                 else:
                     self.log("Spotify credentials missing in .env. Cannot resolve Spotify URL.", "error")
             except Exception as e:
                 self.log(f"Error processing Spotify URL: {e}", "error")
                 return None

        else:
             # Manual search: Pass the whole query as title, let harmonizer resolve it.
             self.log(f"Searching for: {query}", "info")
             
             meta = {
                 'artist': 'Unknown',
                 'title': query.strip(),
                 'duration_sec': 0, 
                 'album': 'Manual',
                 'track_number': 1,
                 'id': f"manual_{int(time.time())}"
             }
             
             # Unified Path: process_track handles harmonization (API search) and YouTube download
             track = self.downloader.process_track(meta, source="manual")
             if not track:
                 self.log("No matching video found or resolution failed.", "warning")

        return track

    def upload_to_cloud(self):
        self.log("Initiating Cloud Upload...", "info")
        
        try:
            from setup_tool.uploader import UploadEngine
            from shared.models import PlayerConfig
            from shared.constants import DEFAULT_CONFIG_DIR
            import json
        except ImportError:
             self.log("Could not import setup_tool. Is the project structure correct?", "error")
             return None

        config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
        
        if not config_path.exists():
             self.log("Cloud config not found. Run setup wizard first.", "error")
             return None

        with open(config_path, 'r') as f:
            config_data = json.load(f)
        config = PlayerConfig.from_dict(config_data)
        
        uploader = UploadEngine(config)
        tracks_dir = self.staging_dir / "tracks"
        
        self.log(f"Looking for tracks to upload in: {tracks_dir}", "info")
        
        if not tracks_dir.exists():
             self.log(f"No tracks directory found at {tracks_dir}", "warning")
             return None
             
        # List files for debugging
        staged_files = list(tracks_dir.glob("*"))
        self.log(f"Found {len(staged_files)} files in staging area.", "info")
        for f in staged_files:
            self.log(f"  - {f.name}", "info")
             
        # Create a proxy progress object or capture logs?
        # UploadEngine uses rich.progress usually. 
        # We can pass None for progress if we don't handle it, or we handle logging differently.
        
        try:
            # We don't compress here since it's already been handled by YouTubeDownloader's quality setting
            updated_lib = uploader.run(str(tracks_dir), compress=False, parallel=1, auto_fetch=False)
            
            if updated_lib:
                self.log(f"Upload sequence finished. Library now has {len(updated_lib.tracks)} tracks.", "success")
                return updated_lib
            else:
                self.log("Upload finished but returned no library update (maybe no new files found?).", "warning")
                return None
        except Exception as e:
            self.log(f"Upload failed with error: {str(e)}", "error")
            import traceback
            self.log(traceback.format_exc(), "error")
            return None
