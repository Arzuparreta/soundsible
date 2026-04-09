"""
Core library management for the player.
Handles loading library.json, resolving URLs, and basic playlist management.
"""

import json
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional
from shared.models import LibraryMetadata, Track, PlayerConfig, StorageProvider, merge_playlist_maps
from shared.constants import LIBRARY_METADATA_FILENAME, DEFAULT_CONFIG_DIR
from shared.path_resolver import resolve_local_track_path
from shared.app_config import get_output_dir
from setup_tool.provider_factory import StorageProviderFactory

def _output_dir_for_library() -> Optional[Path]:
    """Return OUTPUT_DIR so player and API both see the path. Checks config dir first (same place we save from webapp)."""
    out = get_output_dir()
    if out:
        return out
    try:
        out = os.environ.get("OUTPUT_DIR")
        if out:
            return Path(out).expanduser().resolve()
    except Exception:
        pass
    # Note: Canonical path set from webapp settings same file for all processes regardless of cwd
    try:
        config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
        out_file = config_dir / "output_dir"
        if out_file.exists():
            raw = out_file.read_text().strip()
            if raw:
                return Path(raw).expanduser().resolve()
    except Exception:
        pass
    try:
        from dotenv import dotenv_values
        _repo = Path(__file__).resolve().parent.parent
        _env = _repo / "odst_tool" / ".env"
        if _env.exists():
            vals = dotenv_values(_env)
            out = (vals or {}).get("OUTPUT_DIR")
            if out:
                return Path(out).expanduser().resolve()
    except Exception:
        pass
    return None
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
        self._manifest_mtime = 0
        self._lock = threading.Lock()
        
        # Note: Initialize cache
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
                
                # Note: Migration if it was plain text on disk, save it back encrypted
                if not data.get('is_encrypted', False):
                    self._log("Migrating config to encrypted format...")
                    with open(config_path, 'w') as f:
                        f.write(self.config.to_json())
        except Exception as e:
            self._log(f"Error loading config: {e}")
            
    def _init_network(self):
        """Initialize storage provider."""
        if self.config:
            # Note: Reconstruct credentials from config
            creds = {
                'access_key_id': self.config.access_key_id,
                'secret_access_key': self.config.secret_access_key,
                'region': self.config.region,
                'endpoint': self.config.endpoint,
                'application_key_id': self.config.access_key_id,
                'application_key': self.config.secret_access_key
            }
            
            # Note: Provider-specific credential adjustments
            if self.config.provider == StorageProvider.CLOUDFLARE_R2 and self.config.endpoint:
                try:
                    creds['account_id'] = self.config.endpoint.split('//')[1].split('.')[0]
                except: pass
            elif self.config.provider == StorageProvider.LOCAL:
                creds = {'base_path': self.config.endpoint}
            elif self.config.provider == StorageProvider.BACKBLAZE_B2:
                # Note: B2 uses application_key_id/application_key
                creds = {
                    'application_key_id': self.config.access_key_id,
                    'application_key': self.config.secret_access_key,
                }
                
            self.provider = StorageProviderFactory.create(self.config.provider)
            try:
                self.provider.authenticate(creds)
            except (PermissionError, FileNotFoundError, ValueError) as e:
                self._log(
                    f"Storage path unavailable: {e}. "
                    "Edit ~/.config/soundsible/config.json (endpoint / base_path) or use Settings → Storage to set a writable folder."
                )
                raise
            
            # Note: Ensure we know the bucket name
            self.provider.bucket_name = self.config.bucket
            if hasattr(self.provider, 'bucket') and self.provider.bucket is None:
                # Note: For B2 specific setup if needed
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
            
        with self._lock:
            try:
                json_str = self.metadata.to_json()
                
                # Note: 1. Local cache file
                cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(json_str)
                try:
                    self._manifest_mtime = cache_path.stat().st_mtime
                except OSError:
                    pass

                # Note: 1b. Music output dir (same manifest as cache; ODST/downloader also use this path)
                out_dir = _output_dir_for_library()
                if out_dir:
                    music_lib = Path(out_dir).expanduser().resolve() / LIBRARY_METADATA_FILENAME
                    try:
                        music_lib.parent.mkdir(parents=True, exist_ok=True)
                        music_lib.write_text(json_str, encoding="utf-8")
                    except OSError as e:
                        self._log(f"Could not write library.json to music path {music_lib}: {e}")
                
                # Note: 2. Remote cloud storage
                if self.provider:
                    self.provider.save_library(self.metadata)
                    
                # Note: 3. Local sqlite DB
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
        # Note: Allow override or use class default
        is_silent = silent if silent is not None else self.silent
        def _log_local(msg):
            if not is_silent: print(msg)

        cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME

        # Note: Always prefer the path set in settings (output_dir) if it has library.JSON, use it first.
        # Note: This makes the webapp/player "music path" the single source of truth when that path has a library.
        out_dir = _output_dir_for_library()
        if out_dir:
            path_at_music = Path(out_dir).expanduser().resolve() / LIBRARY_METADATA_FILENAME
            if path_at_music.exists():
                try:
                    json_str = path_at_music.read_text()
                    lib = LibraryMetadata.from_json(json_str)
                    if lib.tracks:
                        _log_local(f"Loaded library from music path ({path_at_music.parent}): {len(lib.tracks)} tracks.")
                        # Note: Downloader/ODST may ship a library.json without playlists; config cache can be newer.
                        if cache_path.exists():
                            try:
                                cached = LibraryMetadata.from_json(cache_path.read_text())
                                lib.playlists = merge_playlist_maps(lib.playlists, cached.playlists)
                            except Exception as e:
                                _log_local(f"Warning: Could not merge playlists from cache: {e}")
                        self.metadata = lib
                        self._save_metadata()
                        return True
                except Exception as e:
                    _log_local(f"Could not load library from music path: {e}")

        if not self.provider:
            _log_local("No storage provider configured. Using local cache only.")
            ok = self._load_from_cache(cache_path)
            if ok and self.metadata and self._is_cache_likely_stale():
                _log_local("Cached library does not match current music path; starting fresh.")
                self.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                self._save_metadata()
                return True
            return ok

        try:
            _log_local("Syncing library (Universal 3-way merge)...")
            
            # Note: 1. Get remote
            remote_json = self.provider.download_json(LIBRARY_METADATA_FILENAME)
            remote_lib = None
            if remote_json:
                remote_lib = LibraryMetadata.from_json(remote_json)
            
            # Note: 2. Get local (from cache/previous sync)
            local_lib = None
            if cache_path.exists():
                local_content = cache_path.read_text().strip()
                if local_content:
                    try:
                        local_lib = LibraryMetadata.from_json(local_content)
                    except Exception as e:
                        _log_local(f"Warning: Cached library corrupted: {e}")
            
            # Note: 3. Merge logic
            if not remote_lib and not local_lib:
                _log_local("Initializing fresh library metadata...")
                self.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                # Note: Save immediately to initialize the remote/local files
                self._save_metadata()
                return True

            # Note: Don't use config-dir cache when the configured source has no library (e.g. new system,
            # Note: Same path as previous install but no library.JSON there). otherwise we show stale
            # Note: Tracks from another machine that can't be played.
            if not remote_lib and local_lib and self.config and self.config.provider == StorageProvider.LOCAL:
                _log_local("Configured music path has no library.json; ignoring stale cache and starting fresh.")
                self.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                self._save_metadata()
                return True

            # Note: If we would use cache but cached tracks don't exist at current output_dir, start fresh
            # Note: (E.g. new clone, same user, cache from 2 weeks ago, music path set to different drive)
            if not remote_lib and local_lib and self._is_cache_likely_stale(local_lib):
                _log_local("Cached library does not match current music path; starting fresh.")
                self.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                self._save_metadata()
                return True

            if not remote_lib:
                self.metadata = local_lib
            elif not local_lib:
                self.metadata = remote_lib
            else:
                # Note: Merge combine tracks by ID, keeping newest metadata
                # Note: We prioritize remote version but preserve local_path for this machine
                
                # Note: START WITH remote - this is the source of truth for library content
                track_map = {t.id: t for t in remote_lib.tracks}
                
                # Note: Now layer on local metadata (specifically paths)
                for lt in local_lib.tracks:
                    if lt.id in track_map:
                        # Note: If we have a local path for a known track, use it (if valid)
                        if lt.local_path and os.path.exists(lt.local_path):
                            track_map[lt.id].local_path = lt.local_path
                            track_map[lt.id].is_local = True
                    else:
                        # Note: This track is ONLY in local.
                        # Note: It's likely A new local scan that hasn't been uploaded yet.
                        if lt.local_path and os.path.exists(lt.local_path):
                            track_map[lt.id] = lt
                
                remote_lib.tracks = list(track_map.values())
                remote_lib.version = max(remote_lib.version, local_lib.version) + 1
                # Note: Track merge used remote as base; playlists/settings must merge too or local edits vanish.
                remote_lib.playlists = merge_playlist_maps(remote_lib.playlists, local_lib.playlists)
                remote_lib.settings = {**local_lib.settings, **remote_lib.settings}
                self.metadata = remote_lib

            # Note: 4. Save back using unified method
            success = self._save_metadata()
            if success:
                _log_local(f"✓ Sync complete: {len(self.metadata.tracks)} tracks unified.")
            return success

        except Exception as e:
            if not is_silent:
                self._log(f"Sync failed: {e}")
                import traceback
                traceback.print_exc()
            return self._load_from_cache(cache_path)
    
    def get_track_url(self, track: Track) -> Optional[str]:
        """
        Get a playable URL for a track.
        Resolution Order:
        1. Current OUTPUT_DIR (resolve at read via path_resolver)
        2. Cache path (if exists)
        3. Cloud URL (signed/presigned)
        """
        # Note: 1. Resolve from current output_dir (no stored path)
        resolved = resolve_local_track_path(track)
        if resolved:
            return resolved

        # Note: 2. Cache
        if self.cache:
            cached_path = self.cache.get_cached_path(track.id)
            if cached_path and os.path.exists(cached_path):
                return cached_path
                
        # Note: 3. Cloud provider
        if self.provider:
            remote_key = f"tracks/{track.id}.{track.format}"
            return self.provider.get_file_url(remote_key)
            
        return None

    def get_cover_url(self, track: Track) -> Optional[str]:
        """
        Get a local path or URL for cover art using the CoverFetchManager.
        """
        from player.cover_manager import CoverFetchManager
        manager = CoverFetchManager.get_instance()
        
        # Note: 1. Check if already cached for THIS track
        path = manager.get_cached_path(track.id)
        if path and os.path.exists(path):
            return path

        # Note: 2. Trigger async fetch if not found at all
        # Note: Pass the local track path if available for embedded extraction
        embedded_path = self.get_track_url(track)
        if embedded_path and not embedded_path.startswith('http'):
            manager.request_cover(track, embedded_cache_info=embedded_path)
        else:
            manager.request_cover(track)
            
        return None

    def refresh_if_stale(self):
        """Reload metadata from disk if the file has changed."""
        cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
        if cache_path.exists():
            mtime = cache_path.stat().st_mtime
            if mtime > self._manifest_mtime:
                self._log("Library manifest changed on disk. Reloading...")
                self._load_from_cache(cache_path)
                return True
        return False

    def _is_cache_likely_stale(self, metadata: Optional[LibraryMetadata] = None) -> bool:
        """
        Return True if the cached library appears to be from a different machine/path:
        current OUTPUT_DIR is set but (almost) none of the cached tracks exist there.
        """
        if metadata is None:
            metadata = self.metadata
        if not metadata or not metadata.tracks:
            return False
        out = get_output_dir()
        if not out:
            try:
                out = os.environ.get("OUTPUT_DIR")
            except Exception:
                pass
        if not out:
            return False
        sample_size = min(25, len(metadata.tracks))
        step = max(1, len(metadata.tracks) // sample_size) if metadata.tracks else 1
        found = 0
        for i in range(0, len(metadata.tracks), step):
            if found >= 2:
                break
            if i >= sample_size * step:
                break
            t = metadata.tracks[i]
            if resolve_local_track_path(t):
                found += 1
        # Note: If we have 5+ tracks and none (or 1) exist at current path, cache is stale
        if len(metadata.tracks) >= 5 and found <= 1:
            return True
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
                self._manifest_mtime = cache_path.stat().st_mtime
                self._log(f"✓ Loaded library from cache (offline mode) - {len(self.metadata.tracks)} tracks")
                return True
            else:
                self._log("No cached library found.")
        except Exception as e:
            self._log(f"Failed to load cached library: {e}")
        return False
        
    def get_all_tracks(self) -> List[Track]:
        """
        Return all tracks, preferring the SQLite index for ordering.
        Falls back to in-memory metadata if the DB is empty or unavailable.
        """
        db_tracks = self.db.get_all_tracks()
        if db_tracks:
            return db_tracks
        return self.metadata.tracks if self.metadata else []

    def search(self, query: str) -> List[Track]:
        """
        Perform a fast search using the local database (FTS5 when available).
        Falls back to in-memory metadata only if the DB has not been populated yet.
        """
        try:
            return self.db.search_tracks(query)
        except Exception:
            return self.metadata.tracks if (self.metadata and not query) else []

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
            self._log(f"Updating track: {track.title}")
            
            # Note: 1. Get local file
            local_path = None
            
            # Note: Try cache first
            if self.cache:
                cached = self.cache.get_cached_path(track.id)
                if cached:
                    # Note: Copy to temp to avoid messing up cache directly
                    fd, temp_path = tempfile.mkstemp(suffix=f".{track.format}")
                    os.close(fd)
                    shutil.copy2(cached, temp_path)
                    local_path = temp_path
            
            # Note: If not in cache, download it
            if not local_path and self.provider:
                remote_key = f"tracks/{track.id}.{track.format}"
                fd, temp_path = tempfile.mkstemp(suffix=f".{track.format}")
                os.close(fd)
                self._log("Downloading track for update...")
                if self.provider.download_file(remote_key, temp_path):
                    local_path = temp_path
                else:
                    self._log("Failed to download track.")
                    return False
            
            if not local_path:
                return False
                
            # Note: 2. Modify file
            changes_made = False
            
            # Note: Update tags
            if new_metadata:
                if AudioProcessor.update_tags(local_path, new_metadata):
                    changes_made = True
            
            # Note: Embed art
            if cover_path:
                self._log(f"Embedding artwork from {cover_path}...")
                if AudioProcessor.embed_artwork(local_path, cover_path):
                    changes_made = True
            
            if not changes_made:
                self._log("No changes applied.")
                os.remove(local_path)
                return True # Note: Success but nothing to do
                
            # Note: 3. Process as "new" upload
            # Note: We use uploadengine logic to re-hash and upload
            self._log("Re-processing file...")
            uploader = UploadEngine(self.config)
            
            # Note: Hack we use _process_single_file but we need to pass a valid source_root
            # Note: We treat the temp dir as root
            source_root = Path(local_path).parent
            
            new_track, uploaded = uploader._process_single_file(
                Path(local_path),
                source_root,
                compress=False, # Note: Don't re-compress if possible, just upload
                bitrate=track.bitrate or 320,
                existing_tracks={}, # Note: Clear to force new object construction
                cover_image_path=None, # Note: Already embedded
                auto_fetch=False,
                force_reprocess=True
            )
            
            if new_track:
                # Note: Add the manually set album_artist if it was passed in new_metadata
                if 'album_artist' in new_metadata:
                    new_track.album_artist = new_metadata['album_artist']
                elif not new_track.album_artist:
                    # Note: Fallback to existing if not re-extracted
                    new_track.album_artist = track.album_artist
                
                # Note: 4. Update library
                self._log("Updating library registry...")
                
                # Note: Clear cache for this track so new version with cover will be downloaded
                if self.cache:
                    old_cache_key = f"tracks/{track.id}.{track.format}"
                    cache_file = self.cache.cache_dir / old_cache_key.replace('/', '_')
                    if cache_file.exists():
                        self._log(f"Clearing cache for updated track...")
                        os.remove(cache_file)
                
                # Note: Remove old track
                self.metadata.tracks = [t for t in self.metadata.tracks if t.id != track.id]
                
                # Note: Add new track
                self.metadata.tracks.append(new_track)
                self.metadata.version += 1
                
                # Note: Save changes everywhere
                self._save_metadata()
                
                # Note: 5. Cleanup old remote file (if hash changed)
                if new_track.id != track.id:
                    self._log("Removing old file from storage...")
                    old_key = f"tracks/{track.id}.{track.format}"
                    self.provider.delete_file(old_key)

                # Note: Update cache identically
                if self.cache:
                    self._log("Updating cache with new version...")
                    # Note: We move the local_path to cache, so we don't need to delete it later
                    # Note: Cache.add_to_cache(ID, path, move=true/false)
                    # Note: We used A temp path, let's copy it to cache to be safe
                    self.cache.add_to_cache(new_track.id, local_path, move=False)

                os.remove(local_path)
                self._log("Update complete!")
                return True
                
            os.remove(local_path)
            return False
            
        except Exception as e:
            self._log(f"Update failed: {e}")
            import traceback
            traceback.print_exc()
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
        self._log(f"Deleting track: {track.title} ({track.id})...")
        
        try:
            # Note: 1. Remove from cache
            if self.cache:
                self.cache.remove_track(track.id)
                
            # Note: 2. Remove from cloud storage
            if self.provider:
                remote_key = f"tracks/{track.id}.{track.format}"
                if self.provider.file_exists(remote_key):
                    self._log(f"Deleting remote file: {remote_key}")
                    if not self.provider.delete_file(remote_key):
                        self._log("Failed to delete remote file. Proceeding anyway.")
                
                # Note: Check for cover art if stored separately?
                # Note: Currently cover art seems embedded or fetched from URL, but if we stored it in S3 we should delete it too.
                # Note: The track model has cover_art_key.
                if track.cover_art_key:
                    self._log(f"Deleting cover art: {track.cover_art_key}")
                    self.provider.delete_file(track.cover_art_key)

            # Note: 3. Update library metadata
            # Note: Remove from track list
            original_count = len(self.metadata.tracks)
            self.metadata.tracks = [t for t in self.metadata.tracks if t.id != track.id]
            
            if len(self.metadata.tracks) < original_count:
                self._log("Removed track from metadata.")
                self.metadata.version += 1
                
                # Note: Remove from playlists
                for name, playlist in self.metadata.playlists.items():
                    if track.id in playlist:
                        self.metadata.playlists[name] = [pid for pid in playlist if pid != track.id]

                # Note: Save changes everywhere
                if self._save_metadata():
                    self._log("Track deleted successfully.")
                    return True
                else:
                    self._log("Failed to save deletion metadata.")
                    return False
            else:
                self._log("Track not found in metadata.")
                return False
                
        except Exception as e:
            self._log(f"Error deleting track: {e}")
            return False
        
        return True

    def nuke_library(self) -> bool:
        """
        The 'Nuclear Option': Permanently delete ALL tracks and metadata.
        Deletes from cloud storage, local cache, and local database.
        """
        self._log("!!! NUKE INITIATED !!!")
        try:
            # Note: 1. Clear cloud storage
            if self.provider:
                self._log("Deleting all files from cloud storage...")
                files = self.provider.list_files()
                for file_info in files:
                    remote_key = file_info.get('key') or file_info.get('Key')
                    if not remote_key:
                        continue
                    self._log(f"  Deleting: {remote_key}")
                    self.provider.delete_file(remote_key)
            
            # Note: 2. Clear local cache
            if self.cache:
                self._log("Clearing local media cache...")
                self.cache.clear_cache()
            
            # Note: 3. Reset memory metadata and persist empty state (disk, cloud, DB)
            self.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
            self._log("Clearing local database and saving empty manifest...")
            self._save_metadata()
            
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
            
            # Note: 1. Clear local metadata if requested
            if wipe_local:
                self._log("Wiping local database and cache as requested...")
                self.db.clear_all()
                if self.cache:
                    self.cache.clear_cache()
                
                # Note: Remove local library.JSON
                metadata_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
                if metadata_path.exists():
                    os.remove(metadata_path)

            # Note: 2. Remove configuration file
            if config_path.exists():
                os.remove(config_path)
                self._log("Configuration file removed. You are now disconnected.")
            
            # Note: 3. Reset internal state
            self.config = None
            self.provider = None
            self.metadata = None
            
            return True
        except Exception as e:
            self._log(f"Failed to disconnect: {e}")
            return False

    def purge_missing_tracks(self) -> dict:
        """
        Remove tracks from metadata (and playlists/DB) whose audio file no longer exists
        in the current OUTPUT_DIR and, if a cloud provider is configured, in remote storage.
        Returns a summary dict: {"checked": N, "removed": M}.
        """
        if not self.metadata or not self.metadata.tracks:
            return {"checked": 0, "removed": 0}

        checked = 0
        removed = 0

        # Work on a copy so we can mutate the original list safely
        tracks_snapshot = list(self.metadata.tracks)

        for track in tracks_snapshot:
            checked += 1

            # 1) Check local file via unified resolver
            local_path = resolve_local_track_path(track)

            # 2) If we have a provider, see if the remote object still exists
            remote_exists = False
            if self.provider:
                try:
                    remote_key = f"tracks/{track.id}.{track.format}"
                    remote_exists = self.provider.file_exists(remote_key)
                except Exception:
                    # Be conservative: if we can't check, assume it exists to avoid accidental data loss
                    remote_exists = True

            if local_path or remote_exists:
                continue

            # At this point, neither a local file nor a known remote object exists – purge metadata entry.
            self.metadata.tracks = [t for t in self.metadata.tracks if t.id != track.id]
            # Also remove from any playlists
            for name, playlist in list(self.metadata.playlists.items()):
                if track.id in playlist:
                    self.metadata.playlists[name] = [pid for pid in playlist if pid != track.id]
            removed += 1

        if removed > 0:
            self.metadata.version += 1
            self._save_metadata()

        return {"checked": checked, "removed": removed}

