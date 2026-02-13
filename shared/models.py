"""
Data models for tracks, playlists, and library metadata.

This module defines the core data structures used throughout the platform
for representing music tracks, library organization, and synchronization.
"""

from dataclasses import dataclass, asdict, field
from typing import List, Dict, Optional, Any
from enum import Enum
import json
import uuid
from datetime import datetime


class StorageProvider(Enum):
    """Supported cloud storage providers."""
    CLOUDFLARE_R2 = "r2"
    BACKBLAZE_B2 = "b2"
    AWS_S3 = "s3"
    GENERIC_S3 = "generic"
    LOCAL = "local"


@dataclass
class Track:
    """
    Represents a single music track with metadata.
    
    Attributes:
        id: Unique identifier (UUID or Hash)
        title: Song title
        artist: Artist name
        album: Album name
        duration: Duration in seconds
        file_hash: SHA256 hash of the file
        original_filename: Original file name before upload
        compressed: Whether the file was compressed during upload
        file_size: Size in bytes
        bitrate: Bitrate in kbps (e.g., 320, 1411 for lossless)
        format: Audio format (mp3, flac, ogg, wav, etc.)
        cover_art_key: Optional S3 key or local path for cover art
        year: Release year (optional)
        genre: Music genre (optional)
        track_number: Track number in album (optional)
        is_local: Whether the track is stored locally (optional, defaults to False)
        local_path: Absolute path to the file if scanned locally (optional)
        musicbrainz_id: Unique MusicBrainz Recording ID (optional)
        isrc: International Standard Recording Code (optional)
    """
    id: str
    title: str
    artist: str
    album: str
    duration: int
    file_hash: str
    original_filename: str
    compressed: bool
    file_size: int
    bitrate: int
    format: str
    cover_art_key: Optional[str] = None
    year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    is_local: bool = False
    local_path: Optional[str] = None
    musicbrainz_id: Optional[str] = None
    isrc: Optional[str] = None
    
    @staticmethod
    def generate_id() -> str:
        """Generate a unique track ID."""
        return str(uuid.uuid4())
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert track to dictionary."""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Track':
        """Create Track from dictionary, filtering unknown keys."""
        import dataclasses
        field_names = {f.name for f in dataclasses.fields(cls)}
        filtered_data = {k: v for k, v in data.items() if k in field_names}
        return cls(**filtered_data)


@dataclass
class LibraryMetadata:
    """
    Represents the entire music library metadata.
    
    This is serialized to library.json and stored in the cloud bucket.
    All clients sync against this metadata file.
    """
    version: int
    tracks: List[Track]
    playlists: Dict[str, List[str]]  # playlist_name -> [track_ids]
    settings: Dict[str, Any]
    last_updated: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    
    def to_json(self, indent: int = 2) -> str:
        """
        Serialize library metadata to JSON string.
        
        Args:
            indent: JSON indentation level
            
        Returns:
            JSON string representation
        """
        data = {
            "version": self.version,
            "tracks": [track.to_dict() for track in self.tracks],
            "playlists": self.playlists,
            "settings": self.settings,
            "last_updated": self.last_updated
        }
        return json.dumps(data, indent=indent)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'LibraryMetadata':
        """
        Deserialize library metadata from dictionary.
        """
        tracks = [Track.from_dict(t) for t in data["tracks"]]
        
        # Handle migration from library_version (str) to version (int)
        raw_version = data.get("version")
        if raw_version is None:
            raw_version = data.get("library_version", "1")
            
        try:
            version = int(raw_version)
        except (ValueError, TypeError):
            version = 1
            
        return cls(
            version=version,
            tracks=tracks,
            playlists=data.get("playlists", {}),
            settings=data.get("settings", {}),
            last_updated=data.get("last_updated", datetime.utcnow().isoformat())
        )
    
    @classmethod
    def from_json(cls, json_str: str) -> 'LibraryMetadata':
        """
        Deserialize library metadata from JSON string.
        
        Args:
            json_str: JSON string to parse
            
        Returns:
            LibraryMetadata instance
        """
        data = json.loads(json_str)
        return cls.from_dict(data)
    
    def get_track_by_id(self, track_id: str) -> Optional[Track]:
        """Find track by ID."""
        for track in self.tracks:
            if track.id == track_id:
                return track
        return None
    
    def add_track(self, track: Track) -> None:
        """Add a track to the library."""
        self.tracks.append(track)
        self.last_updated = datetime.utcnow().isoformat()
    
    def remove_track(self, track_id: str) -> bool:
        """
        Remove track from library.
        
        Returns:
            True if track was removed, False if not found
        """
        for i, track in enumerate(self.tracks):
            if track.id == track_id:
                self.tracks.pop(i)
                self.last_updated = datetime.utcnow().isoformat()
                return True
        return False
    
    def create_playlist(self, name: str, track_ids: Optional[List[str]] = None) -> None:
        """Create a new playlist."""
        self.playlists[name] = track_ids or []
        self.last_updated = datetime.utcnow().isoformat()
    
    def add_to_playlist(self, playlist_name: str, track_id: str) -> bool:
        """
        Add track to playlist.
        
        Returns:
            True if successful, False if playlist doesn't exist
        """
        if playlist_name not in self.playlists:
            return False
        if track_id not in self.playlists[playlist_name]:
            self.playlists[playlist_name].append(track_id)
            self.last_updated = datetime.utcnow().isoformat()
        return True


@dataclass
class PlayerConfig:
    """
    Player configuration stored locally on each device.
    
    Contains credentials for accessing cloud storage and local preferences.
    """
    provider: StorageProvider
    endpoint: str
    bucket: str
    access_key_id: str
    secret_access_key: str
    region: Optional[str] = None
    public: bool = False
    cache_max_size_gb: int = 50
    cache_location: str = "~/.cache/musicplayer/"
    sync_interval_minutes: int = 18
    last_sync: Optional[str] = None
    quality_preference: str = "high"  # standard, high, ultra
    watch_folders: List[str] = field(default_factory=list)
    is_encrypted: bool = False
    
    def to_dict(self, encrypt: bool = True) -> Dict[str, Any]:
        """Convert config to dictionary, optionally encrypting credentials."""
        from shared.crypto import CredentialManager
        
        data = asdict(self)
        data['provider'] = self.provider.value
        
        if encrypt and not self.is_encrypted:
            data['access_key_id'] = CredentialManager.encrypt(self.access_key_id)
            data['secret_access_key'] = CredentialManager.encrypt(self.secret_access_key)
            data['is_encrypted'] = True
            
        return data
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'PlayerConfig':
        """Create PlayerConfig from dictionary, decrypting if necessary."""
        from shared.crypto import CredentialManager
        
        # Filter out keys that are not in the dataclass
        import dataclasses
        field_names = {f.name for f in dataclasses.fields(cls)}
        filtered_data = {k: v for k, v in data.items() if k in field_names}
        
        filtered_data['provider'] = StorageProvider(filtered_data['provider'])
        
        if filtered_data.get('is_encrypted', False):
            # Decrypt for in-memory use
            dec_id = CredentialManager.decrypt(filtered_data['access_key_id'])
            dec_key = CredentialManager.decrypt(filtered_data['secret_access_key'])
            
            # If decryption works, update data. If not (e.g. wrong machine), 
            # we keep encrypted strings (which will fail auth, but not crash)
            if dec_id is not None and dec_key is not None:
                filtered_data['access_key_id'] = dec_id
                filtered_data['secret_access_key'] = dec_key
                filtered_data['is_encrypted'] = False # Marked as raw in memory
        
        return cls(**filtered_data)
    
    def to_json(self, indent: int = 2) -> str:
        """Serialize to JSON."""
        return json.dumps(self.to_dict(), indent=indent)
    
    @classmethod
    def from_json(cls, json_str: str) -> 'PlayerConfig':
        """Deserialize from JSON."""
        return cls.from_dict(json.loads(json_str))
