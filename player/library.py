"""
Core library management for the player.
Handles loading library.json, resolving URLs, and basic playlist management.
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional
from shared.models import LibraryMetadata, Track, PlayerConfig, StorageProvider
from shared.constants import LIBRARY_METADATA_FILENAME, DEFAULT_CONFIG_DIR
from setup_tool.provider_factory import StorageProviderFactory
from setup_tool.audio import AudioProcessor
from setup_tool.uploader import UploadEngine
from shared.database import DatabaseManager
import shutil
import tempfile

class LibraryManager:
    """Manages the music library and stream URLs."""
    
    def __init__(self, silent: bool = False):
        self.silent = silent
        self.metadata: Optional[LibraryMetadata] = None
        self.config: Optional[PlayerConfig] = None
        self.provider = None
        self.db = DatabaseManager()
        
        # Initialize Cache
        try:
             from .cache import CacheManager
             self.cache = CacheManager()
        except ImportError:
             self.cache = None
        
        self._load_config()
        if self.config:
            self._init_network()

    def _log(self, msg: str):
        if not self.silent:
            print(msg)

    def _load_config(self):
        """Load player configuration and ensure it's encrypted on disk."""
        try:
            config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
            if config_path.exists():
                with open(config_path, 'r') as f:
                    data = json.load(f)
                    
                self.config = PlayerConfig.from_dict(data)
                
                # Migration: If it was plain text on disk, save it back encrypted
                if not data.get('is_encrypted', False):
                    self._log("Migrating config to encrypted format...")
                    with open(config_path, 'w') as f:
                        f.write(self.config.to_json())
        except Exception as e:
            self._log(f"Error loading config: {e}")
            
    def _init_network(self):
        """Initialize storage provider."""
        if self.config:
            # Reconstruct credentials from config
            creds = {
                'access_key_id': self.config.access_key_id,
                'secret_access_key': self.config.secret_access_key,
                'region': self.config.region,
                'endpoint': self.config.endpoint,
                'application_key_id': self.config.access_key_id,
                'application_key': self.config.secret_access_key
            }
            
            # Provider-specific credential adjustments
            if self.config.provider == StorageProvider.CLOUDFLARE_R2 and self.config.endpoint:
                try:
                    creds['account_id'] = self.config.endpoint.split('//')[1].split('.')[0]
                except: pass
            elif self.config.provider == StorageProvider.LOCAL:
                creds = {'base_path': self.config.endpoint}
            elif self.config.provider == StorageProvider.BACKBLAZE_B2:
                # B2 uses application_key_id/application_key
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

    def _save_metadata(self) -> bool:
        """
        Consistently save current metadata to:
        1. Local library.json (cache)
        2. Remote storage provider (cloud)
        3. Local SQLite database (for fast search)
        """
        if not self.metadata:
            return False
            
        try:
            json_str = self.metadata.to_json()
            
            # 1. Local Cache file
            cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json_str)
            
            # 2. Remote Cloud Storage
            if self.provider:
                self.provider.save_library(self.metadata)
                
            # 3. Local SQLite DB
            self.db.sync_from_metadata(self.metadata)
            
            return True
        except Exception as e:
            self._log(f"Error saving metadata: {e}")
            return False

    def sync_library(self, silent: bool = None) -> bool:
        """
        Perform a Universal Sync:
        1. Download remote library.json
        2. Merge with any local deep-scanned tracks
        3. Save unified manifest to cloud and local cache
        """
        # Allow override or use class default
        is_silent = silent if silent is not None else self.silent
        def _log_local(msg):
            if not is_silent: print(msg)

        cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
        
        if not self.provider:
            _log_local("No storage provider configured. Using local cache only.")
            return self._load_from_cache(cache_path)
            
        try:
            _log_local("Syncing library (Universal 3-way merge)...")
            
            # 1. Get Remote
            print(f"DEBUG: Sync - Attempting to download remote {LIBRARY_METADATA_FILENAME}...")
            remote_json = self.provider.download_json(LIBRARY_METADATA_FILENAME)
            remote_lib = None
            if remote_json:
                remote_lib = LibraryMetadata.from_json(remote_json)
                print(f"DEBUG: Sync - Downloaded remote library. Tracks: {len(remote_lib.tracks)}")
            else:
                print("DEBUG: Sync - No remote library found.")
            
            # 2. Get Local (from cache/previous sync)
            local_lib = None
            if cache_path.exists():
                local_content = cache_path.read_text().strip()
                if local_content:
                    try:
                        local_lib = LibraryMetadata.from_json(local_content)
                        print(f"DEBUG: Sync - Loaded local cache. Tracks: {len(local_lib.tracks)}")
                    except Exception as e:
                        _log_local(f"Warning: Cached library corrupted: {e}")
            
            # 3. Merge Logic
            if not remote_lib and not local_lib:
                _log_local("Initializing fresh library metadata...")
                self.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                # Save immediately to initialize the remote/local files
                self._save_metadata()
                return True
                
            if not remote_lib:
                self.metadata = local_lib
            elif not local_lib:
                self.metadata = remote_lib
            else:
                # Merge: Combine tracks by ID, keeping newest metadata
                # We prioritize remote version but preserve local_path for this machine
                
                # START WITH REMOTE - This is the source of truth for library content
                track_map = {t.id: t for t in remote_lib.tracks}
                print(f"DEBUG: Sync - Remote library has {len(track_map)} tracks.")
                
                # Now layer on local metadata (specifically paths)
                for lt in local_lib.tracks:
                    if lt.id in track_map:
                        # If we have a local path for a known track, use it (if valid)
                        if lt.local_path and os.path.exists(lt.local_path):
                            track_map[lt.id].local_path = lt.local_path
                            track_map[lt.id].is_local = True
                    else:
                        # This track is ONLY in local.
                        # It's likely a new local scan that hasn't been uploaded yet.
                        if lt.local_path and os.path.exists(lt.local_path):
                            track_map[lt.id] = lt
                            print(f"DEBUG: Sync - Adding new local-only track: {lt.title}")
                
                remote_lib.tracks = list(track_map.values())
                remote_lib.version = max(remote_lib.version, local_lib.version) + 1
                self.metadata = remote_lib
                print(f"DEBUG: Sync - Unified library has {len(self.metadata.tracks)} tracks.")

            # 4. Save Back using unified method
            return self._save_metadata()

        except Exception as e:
            if not is_silent:
                print(f"Sync failed: {e}")
                import traceback
                traceback.print_exc()
            return self._load_from_cache(cache_path)
    
    def get_track_url(self, track: Track) -> Optional[str]:
        """
        Get a playable URL for a track.
        Resolution Order:
        1. Local path (if verified exists)
        2. Cache path (if exists)
        3. Cloud URL (signed/presigned)
        """
        # 1. Local path
        if track.local_path and os.path.exists(track.local_path):
            return track.local_path
            
        # 2. Cache
        if self.cache:
            cached_path = self.cache.get_cached_path(track.id)
            if cached_path and os.path.exists(cached_path):
                return cached_path
                
        # 3. Cloud Provider
        if self.provider:
            remote_key = f"tracks/{track.id}.{track.format}"
            return self.provider.get_file_url(remote_key)
            
        return None

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
        """Return all tracks, prioritized by speed (DB first)."""
        db_tracks = self.db.get_all_tracks()
        if db_tracks:
            return db_tracks
        return self.metadata.tracks if self.metadata else []

    def search(self, query: str) -> List[Track]:
        """Perform a fast search using the local database."""
        return self.db.search_tracks(query)

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
                
                # Save changes everywhere
                self._save_metadata()
                
                # 5. Cleanup Old Remote File (if hash changed)
                if new_track.id != track.id:
                    print("Removing old file from storage...")
                    old_key = f"tracks/{track.id}.{track.format}"
                    self.provider.delete_file(old_key)

                # Update Cache Identically
                if self.cache:
                    print("Updating cache with new version...")
                    # We move the local_path to cache, so we don't need to delete it later
                    # cache.add_to_cache(id, path, move=True/False)
                    # We used a temp path, let's copy it to cache to be safe
                    self.cache.add_to_cache(new_track.id, local_path, move=False)

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

    def delete_track(self, track: Track) -> bool:
        """
        Permanently delete a track from:
        1. Local cache
        2. Cloud storage (R2/S3)
        3. Library metadata
        """
        print(f"Deleting track: {track.title} ({track.id})...")
        
        try:
            # 1. Remove from Cache
            if self.cache:
                self.cache.remove_track(track.id)
                
            # 2. Remove from Cloud Storage
            if self.provider:
                remote_key = f"tracks/{track.id}.{track.format}"
                if self.provider.file_exists(remote_key):
                    print(f"Deleting remote file: {remote_key}")
                    if not self.provider.delete_file(remote_key):
                        print("Failed to delete remote file. Proceeding anyway.")
                
                # Check for cover art if stored separately? 
                # Currently cover art seems embedded or fetched from URL, but if we stored it in S3 we should delete it too.
                # The Track model has cover_art_key.
                if track.cover_art_key:
                    print(f"Deleting cover art: {track.cover_art_key}")
                    self.provider.delete_file(track.cover_art_key)

            # 3. Update Library Metadata
            # Remove from track list
            original_count = len(self.metadata.tracks)
            self.metadata.tracks = [t for t in self.metadata.tracks if t.id != track.id]
            
            if len(self.metadata.tracks) < original_count:
                print("Removed track from metadata.")
                self.metadata.version += 1
                
                # Remove from playlists
                for name, playlist in self.metadata.playlists.items():
                    if track.id in playlist:
                        self.metadata.playlists[name] = [pid for pid in playlist if pid != track.id]

                # Save changes everywhere
                if self._save_metadata():
                    print("Track deleted successfully.")
                    return True
                else:
                    print("Failed to save deletion metadata.")
                    return False
            else:
                print("Track not found in metadata.")
                return False
                
        except Exception as e:
            print(f"Error deleting track: {e}")
            return False
        
        return True

    def nuke_library(self) -> bool:
        """
        The 'Nuclear Option': Permanently delete ALL tracks and metadata.
        Deletes from cloud storage, local cache, and local database.
        """
        self._log("!!! NUKE INITIATED !!!")
        try:
            # 1. Clear Cloud Storage
            if self.provider:
                self._log("Deleting all files from cloud storage...")
                files = self.provider.list_files()
                for file_info in files:
                    self._log(f"  Deleting: {file_info['key']}")
                    self.provider.delete_file(file_info['key'])
            
            # 2. Clear Local Cache
            if self.cache:
                self._log("Clearing local media cache...")
                self.cache.clear_cache()
            
            # 3. Clear Local SQLite Database
            self._log("Clearing local database...")
            self.db.clear_all()
            
            # 4. Reset Memory Metadata
            self.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
            
            # 5. Remove local metadata file (library.json)
            cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
            if cache_path.exists():
                os.remove(cache_path)
            
            self._log("✓ Library nuked successfully.")
            return True
        except Exception as e:
            self._log(f"Nuke failed: {e}")
            import traceback
            traceback.print_exc()
            return False

    def disconnect_storage(self, wipe_local: bool = False) -> bool:
        """
        Disconnect from the current storage provider.
        Removes the local config.json file.
        If wipe_local is True, also clears the local database and cache.
        """
        try:
            config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
            
            # 1. Clear local metadata if requested
            if wipe_local:
                self._log("Wiping local database and cache as requested...")
                self.db.clear_all()
                if self.cache:
                    self.cache.clear_cache()
                
                # Remove local library.json
                metadata_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
                if metadata_path.exists():
                    os.remove(metadata_path)

            # 2. Remove configuration file
            if config_path.exists():
                os.remove(config_path)
                self._log("Configuration file removed. You are now disconnected.")
            
            # 3. Reset internal state
            self.config = None
            self.provider = None
            self.metadata = None
            
            return True
        except Exception as e:
            self._log(f"Failed to disconnect: {e}")
            return False

