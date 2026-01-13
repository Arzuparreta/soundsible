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
        

