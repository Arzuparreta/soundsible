
import sys
import shutil
import time
import os
from pathlib import Path

# Add project root to path if needed (for GUI usage it might be already there)
# But for safety, we assume imports work relative to project root.

class SmartDownloader:
    def __init__(self, output_dir=None):
        if output_dir:
            self.output_dir = Path(output_dir)
        else:
            self.output_dir = Path("staging_downloads")
            
        self.output_dir.mkdir(exist_ok=True)
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
            
            # Cookie logic
            cookie_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "cookies.txt"
            cookie_file = str(cookie_path) if cookie_path.exists() else None
            
            # Browser fallback REMOVED to prevent conflict with Android client workaround
            # The android client workaround is robust enough without cookies.
            browser = None 
            
            self.downloader = YouTubeDownloader(
                self.output_dir, 
                cookie_file=cookie_file,
                cookie_browser=browser
            )
            self.spotify = SpotifyLibrary(skip_auth=False) 
        except ImportError as e:
            self.log(f"Failed to load downloader modules: {e}", "error")
            raise e
        except Exception as e:
            self.log(f"Initialization error (possible network/hang): {e}", "error")
            raise e

    def cleanup(self):
        if self.output_dir.exists():
            try:
                shutil.rmtree(self.output_dir)
            except:
                pass

    def process_query(self, query):
        self._lazy_load()
        self.log(f"Processing query: {query}", "info")
        
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
             # Assume "Artist - Title" search
             self.log(f"Searching for: {query}", "info")
             # Construct metadata for search
             parts = query.split('-')
             if len(parts) > 1:
                 artist = parts[0].strip()
                 title = parts[1].strip()
             else:
                 artist = ""
                 title = query.strip()
                 
             meta = {
                 'artist': artist,
                 'title': title,
                 'duration_sec': 0, 
                 'album': 'Unknown',
                 'track_number': 1
             }
             
             video_info = self.downloader._search_youtube(meta)
             if video_info:
                 url = video_info.get('webpage_url')
                 if url:
                    track = self.downloader.process_video(url)
                 else:
                    self.log("No video URL found in search results.", "warning")
             else:
                 self.log("No matching video found on YouTube.", "warning")

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
             return

        config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
        
        if not config_path.exists():
             self.log("Cloud config not found. Run setup wizard first.", "error")
             return

        with open(config_path, 'r') as f:
            config_data = json.load(f)
        config = PlayerConfig.from_dict(config_data)
        
        uploader = UploadEngine(config)
        tracks_dir = self.output_dir / "tracks"
        
        if not tracks_dir.exists():
             self.log("No tracks found in staging area to upload.", "warning")
             return
             
        # Create a proxy progress object or capture logs?
        # UploadEngine uses rich.progress usually. 
        # We can pass None for progress if we don't handle it, or we handle logging differently.
        
        try:
            uploader.run(tracks_dir, compress=False, parallel=1, auto_fetch=False)
            self.log("Upload sequence finished.", "success")
            return True
        except Exception as e:
            self.log(f"Upload failed: {e}", "error")
            return False
