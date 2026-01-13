"""
Core library management for the player.
Handles loading library.json, resolving URLs, and basic playlist management.
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional
from shared.models import LibraryMetadata, Track, PlayerConfig
from shared.constants import LIBRARY_METADATA_FILENAME, DEFAULT_CONFIG_DIR
from setup_tool.provider_factory import StorageProviderFactory
from setup_tool.audio import AudioProcessor
from setup_tool.uploader import UploadEngine
import shutil
import tempfile

class LibraryManager:
    """Manages the music library and stream URLs."""
    
    def __init__(self):
        self.metadata: Optional[LibraryMetadata] = None
        self.config: Optional[PlayerConfig] = None
        self.provider = None
        
        # Initialize Cache
        try:
             from .cache import CacheManager
             self.cache = CacheManager()
        except ImportError:
             self.cache = None
        
        self._load_config()
        if self.config:
            self._init_network()

    # ... (skipping unchanged methods)

    def get_track_url(self, track: Track) -> str:
        """
        Get streamable URL for a track.
        Checks local cache first, returns remote URL if not cached.
        """
        # 1. Check Cache
        if self.cache:
            cached_path = self.cache.get_cached_path(track.id)
            if cached_path:
                return cached_path

        # 2. Return Remote URL
        if not self.provider:
            return ""
            
        remote_key = f"tracks/{track.id}.{track.format}"
        # Start background download to cache? (For next time)
        # For now, just stream remote.
        
        return self.provider.get_file_url(remote_key, expires_in=3600*2)
            
    def _load_config(self):
        """Load player configuration."""
        try:
            config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
            if config_path.exists():
                with open(config_path, 'r') as f:
                    self.config = PlayerConfig.from_dict(json.load(f))
        except Exception as e:
            print(f"Error loading config: {e}")
            
    def _init_network(self):
        """Initialize storage provider."""
        if self.config:
            # Reconstruct credentials from config
            # Note: In real app, decrypt access_key here
            creds = {}
            if self.config.provider.name == 'CLOUDFLARE_R2':
                # Attempt to extract account ID from endpoint if needed
                creds = {
                    'access_key_id': self.config.access_key_id,
                    'secret_access_key': self.config.secret_access_key,
                    'account_id': self.config.endpoint.split('//')[1].split('.')[0] if self.config.endpoint else '' 
                }
            else:
                creds = {
                    'application_key_id': self.config.access_key_id,
                    'application_key': self.config.secret_access_key,
                }
                
            self.provider = StorageProviderFactory.create(self.config.provider)
            self.provider.authenticate(creds)
            # Ensure we know the bucket name
            self.provider.bucket_name = self.config.bucket
            if hasattr(self.provider, 'bucket') and self.provider.bucket is None:
                # For B2 specific setup if needed
                 try:
                    self.provider.bucket = self.provider.api.get_bucket_by_name(self.config.bucket)
                 except: pass

    def sync_library(self) -> bool:
        """
        Download latest library.json from cloud storage.
        Falls back to local cache if network fails.
        """
        cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
        
        if not self.provider:
            print("No storage provider configured. Attempting to load from cache...")
            return self._load_from_cache(cache_path)
            
        try:
            print("Syncing library from cloud storage...")
            json_str = self.provider.download_json(LIBRARY_METADATA_FILENAME)
            if json_str:
                self.metadata = LibraryMetadata.from_json(json_str)
                # Cache locally for offline use
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(json_str)
                print("Library synced successfully and cached locally.")
                return True
        except (ConnectionError, TimeoutError) as e:
            print(f"Network error during sync: {e}")
            print("Attempting to use cached library (offline mode)...")
            return self._load_from_cache(cache_path)
        except Exception as e:
            print(f"Sync failed: {e}")
            print("Attempting to use cached library...")
            return self._load_from_cache(cache_path)
            
        return False
    
    def _load_from_cache(self, cache_path: Path) -> bool:
        """
        Load library metadata from local cache.
        
        Args:
            cache_path: Path to cached library.json file
            
        Returns:
            True if cache loaded successfully, False otherwise
        """
        try:
            if cache_path.exists():
                json_str = cache_path.read_text()
                self.metadata = LibraryMetadata.from_json(json_str)
                print(f"✓ Loaded library from cache (offline mode) - {len(self.metadata.tracks)} tracks")
                return True
            else:
                print("No cached library found.")
        except Exception as e:
            print(f"Failed to load cached library: {e}")
        return False
        
    def get_all_tracks(self) -> List[Track]:
        """Return all tracks from library metadata."""
        return self.metadata.tracks if self.metadata else []

    def update_track(self, track: Track, new_metadata: Dict[str, str], cover_path: Optional[str] = None) -> bool:
        """
        Update track metadata and/or cover art.
        This involves:
        1. Downloading the file (if not cached).
        2. Modifying tags/embedding art.
        3. Re-uploading (if hash changed).
        4. Updating library.json.
        """
        try:
            print(f"Updating track: {track.title}")
            
            # 1. Get local file
            local_path = None
            
            # Try cache first
            if self.cache:
                cached = self.cache.get_cached_path(track.id)
                if cached:
                    # Copy to temp to avoid messing up cache directly
                    fd, temp_path = tempfile.mkstemp(suffix=f".{track.format}")
                    os.close(fd)
                    shutil.copy2(cached, temp_path)
                    local_path = temp_path
            
            # If not in cache, download it
            if not local_path and self.provider:
                remote_key = f"tracks/{track.id}.{track.format}"
                fd, temp_path = tempfile.mkstemp(suffix=f".{track.format}")
                os.close(fd)
                print("Downloading track for update...")
                if self.provider.download_file(remote_key, temp_path):
                    local_path = temp_path
                else:
                    print("Failed to download track.")
                    return False
            
            if not local_path:
                return False
                
            # 2. Modify File
            changes_made = False
            
            # Update Tags
            if new_metadata:
                if AudioProcessor.update_tags(local_path, new_metadata):
                    changes_made = True
            
            # Embed Art
            if cover_path:
                print(f"Embedding artwork from {cover_path}...")
                if AudioProcessor.embed_artwork(local_path, cover_path):
                    changes_made = True
            
            if not changes_made:
                print("No changes applied.")
                os.remove(local_path)
                return True # Success but nothing to do
                
            # 3. Process as "New" Upload
            # We use UploadEngine logic to re-hash and upload
            print("Re-processing file...")
            uploader = UploadEngine(self.config)
            
            # Hack: We use _process_single_file but we need to pass a valid source_root
            # We treat the temp dir as root
            source_root = Path(local_path).parent
            
            new_track, uploaded = uploader._process_single_file(
                Path(local_path),
                source_root,
                compress=False, # Don't re-compress if possible, just upload
                bitrate=track.bitrate or 320,
                existing_tracks={}, # Force upload
                cover_image_path=None, # Already embedded
                auto_fetch=False
            )
            
            if new_track:
                # 4. Update Library
                print("Updating library registry...")
                
                # Clear cache for this track so new version with cover will be downloaded
                if self.cache:
                    old_cache_key = f"tracks/{track.id}.{track.format}"
                    cache_file = self.cache.cache_dir / old_cache_key.replace('/', '_')
                    if cache_file.exists():
                        print(f"Clearing cache for updated track...")
                        os.remove(cache_file)
                
                # Remove old track
                self.metadata.tracks = [t for t in self.metadata.tracks if t.id != track.id]
                
                # Add new track
                self.metadata.tracks.append(new_track)
                self.metadata.version += 1
                
                # Save Library
                # Use uploader storage to save library
                uploader.storage.save_library(self.metadata)
                
                # 5. Cleanup Old Remote File (if hash changed)
                if new_track.id != track.id:
                    print("Removing old file from storage...")
                    old_key = f"tracks/{track.id}.{track.format}"
                    self.provider.delete_file(old_key)

                os.remove(local_path)
                print("Update complete!")
                return True
                
            os.remove(local_path)
            return False
            
        except Exception as e:
            print(f"Update failed: {e}")
            if 'local_path' in locals() and local_path and os.path.exists(local_path):
                os.remove(local_path)
            return False
        

