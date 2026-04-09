"""
Data models for tracks, playlists, and library metadata.

This module defines the core data structures used throughout the platform
for representing music tracks, library organization, and synchronization.
"""

from dataclasses import dataclass, asdict, field
from typing import List, Dict, Optional, Any, Literal
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
        album_artist: Common artist for the whole album (optional)
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
    # Note: Fields with default values MUST come last
    album_artist: Optional[str] = None
    cover_art_key: Optional[str] = None
    year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    is_local: bool = False
    local_path: Optional[str] = None
    musicbrainz_id: Optional[str] = None
    isrc: Optional[str] = None
    cover_source: Optional[str] = None
    metadata_modified_by_user: bool = False
    youtube_id: Optional[str] = None

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
class QueueItem:
    """
    A single playable item in the playback queue (library track or preview).
    id is the canonical identifier: library UUID or video_id for preview.
    """
    source: Literal["library", "preview"]
    id: str
    title: str
    artist: str
    duration: int
    thumbnail: Optional[str] = None
    library_track_id: Optional[str] = None
    album: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Stable JSON for API and web (source, id, title, artist, duration, thumbnail)."""
        out: Dict[str, Any] = {
            "source": self.source,
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "duration": self.duration,
        }
        if self.thumbnail is not None:
            out["thumbnail"] = self.thumbnail
        if self.library_track_id is not None:
            out["library_track_id"] = self.library_track_id
        if self.album is not None:
            out["album"] = self.album
        return out

    @classmethod
    def from_library_track(cls, track: 'Track') -> 'QueueItem':
        """Build a library QueueItem from a Track."""
        return cls(
            source="library",
            id=track.id,
            title=track.title,
            artist=track.artist,
            duration=track.duration,
            thumbnail=None,
            library_track_id=None,
            album=track.album,
        )

    @classmethod
    def from_preview(
        cls,
        video_id: str,
        title: str,
        artist: str,
        duration: int,
        thumbnail: Optional[str] = None,
        library_track_id: Optional[str] = None,
        album: Optional[str] = None,
    ) -> 'QueueItem':
        """Build a preview QueueItem."""
        return cls(
            source="preview",
            id=video_id,
            title=title,
            artist=artist,
            duration=duration,
            thumbnail=thumbnail,
            library_track_id=library_track_id,
            album=album,
        )


@dataclass
class LibraryMetadata:
    """
    Represents the entire music library metadata.
    
    This is serialized to library.json and stored in the cloud bucket.
    All clients sync against this metadata file.
    """
    version: int
    tracks: List[Track]
    playlists: Dict[str, List[str]]  # Note: Playlist_name -> [track_ids]
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
        # Note: Omit local_path when persisting; path is resolved at read from output_dir.
        data = {
            "version": self.version,
            "tracks": [{k: v for k, v in track.to_dict().items() if k != "local_path"} for track in self.tracks],
            "playlists": self.playlists,
            "settings": self.settings,
            "last_updated": self.last_updated
        }
        return json.dumps(data, indent=indent)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'LibraryMetadata':
        """
        Deserialize library metadata from dictionary.
        Ignore stored local_path; path is resolved at read from OUTPUT_DIR.
        """
        tracks = [Track.from_dict({**t, "local_path": None}) for t in data.get("tracks", [])]
        
        # Note: Handle migration from library_version (str) to version (int)
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
        Returns empty library on decode error or empty/corrupt content.
        """
        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            return cls(version=1, tracks=[], playlists={}, settings={})
        return cls.from_dict(data)
    
    def get_track_by_id(self, track_id: str) -> Optional[Track]:
        """Find track by ID."""
        for track in self.tracks:
            if track.id == track_id:
                return track
        return None

    def get_track_by_hash(self, file_hash: str) -> Optional[Track]:
        """Find track by file hash."""
        for track in self.tracks:
            if track.file_hash == file_hash:
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

    def remove_from_playlist(self, playlist_name: str, track_id: str) -> bool:
        """
        Remove track from playlist.
        
        Returns:
            True if removed or playlist didn't contain track, False if playlist doesn't exist
        """
        if playlist_name not in self.playlists:
            return False
        ids = self.playlists[playlist_name]
        if track_id in ids:
            ids.remove(track_id)
            stored_cover = self.get_playlist_cover_track_id(playlist_name)
            if stored_cover == track_id:
                pc = self.settings.get("playlist_covers")
                if isinstance(pc, dict):
                    pc.pop(playlist_name, None)
            self.last_updated = datetime.utcnow().isoformat()
        return True

    def delete_playlist(self, name: str) -> bool:
        """
        Delete a playlist by name.
        
        Returns:
            True if deleted, False if not found
        """
        if name not in self.playlists:
            return False
        del self.playlists[name]
        pc = self.settings.get("playlist_covers")
        if isinstance(pc, dict):
            pc.pop(name, None)
        self.last_updated = datetime.utcnow().isoformat()
        return True

    def rename_playlist(self, old_name: str, new_name: str) -> bool:
        """
        Rename a playlist.
        
        Returns:
            True if renamed, False if old name not found or new name already exists
        """
        if old_name not in self.playlists or new_name in self.playlists:
            return False
        self.playlists[new_name] = self.playlists.pop(old_name)
        pc = self.settings.get("playlist_covers")
        if isinstance(pc, dict) and old_name in pc:
            pc[new_name] = pc.pop(old_name)
        self.last_updated = datetime.utcnow().isoformat()
        return True

    def get_playlist_cover_track_id(self, playlist_name: str) -> Optional[str]:
        """Track id whose art is used as playlist cover, or None for default (first track)."""
        m = self.settings.get("playlist_covers")
        if not isinstance(m, dict):
            return None
        v = m.get(playlist_name)
        if isinstance(v, str) and v:
            return v
        return None

    def set_playlist_cover_track_id(self, playlist_name: str, track_id: Optional[str]) -> bool:
        """
        Set or clear custom playlist cover (must reference a track currently in the playlist).
        Passing None or empty string clears the preference.
        """
        if playlist_name not in self.playlists:
            return False
        if not track_id:
            pc = self.settings.get("playlist_covers")
            if isinstance(pc, dict):
                pc.pop(playlist_name, None)
            self.last_updated = datetime.utcnow().isoformat()
            return True
        if track_id not in self.playlists[playlist_name]:
            return False
        pc_raw = self.settings.setdefault("playlist_covers", {})
        if not isinstance(pc_raw, dict):
            pc_raw = {}
            self.settings["playlist_covers"] = pc_raw
        pc_raw[playlist_name] = track_id
        self.last_updated = datetime.utcnow().isoformat()
        return True

    def set_playlist_tracks(self, name: str, track_ids: List[str]) -> bool:
        """
        Set the ordered list of track IDs for a playlist (used for reorder).
        
        Returns:
            True if set, False if playlist doesn't exist
        """
        if name not in self.playlists:
            return False
        self.playlists[name] = list(track_ids)
        cv = self.get_playlist_cover_track_id(name)
        if cv and cv not in self.playlists[name]:
            pc = self.settings.get("playlist_covers")
            if isinstance(pc, dict):
                pc.pop(name, None)
        self.last_updated = datetime.utcnow().isoformat()
        return True

    def reorder_playlists(self, ordered_names: List[str]) -> None:
        """Rebuild playlists dict in the given order (preserves only listed names)."""
        new_playlists = {}
        for name in ordered_names:
            if name in self.playlists:
                new_playlists[name] = self.playlists[name]
        self.playlists = new_playlists
        pc = self.settings.get("playlist_covers")
        if isinstance(pc, dict):
            valid = set(self.playlists.keys())
            for k in list(pc.keys()):
                if k not in valid:
                    del pc[k]
        self.last_updated = datetime.utcnow().isoformat()


def merge_playlist_maps(
    a: Optional[Dict[str, List[str]]],
    b: Optional[Dict[str, List[str]]],
) -> Dict[str, List[str]]:
    """
    Merge two playlist maps (name -> track ids). Union of playlist names;
    for names present in both, concatenate unique ids in order (a first, then b-only).
    """
    if not a:
        a = {}
    if not b:
        b = {}
    out: Dict[str, List[str]] = {}
    for name in set(a.keys()) | set(b.keys()):
        la = a.get(name)
        lb = b.get(name)
        if la is None:
            out[name] = list(lb)
        elif lb is None:
            out[name] = list(la)
        else:
            seen = set(la)
            merged = list(la)
            for tid in lb:
                if tid not in seen:
                    merged.append(tid)
                    seen.add(tid)
            out[name] = merged
    return out


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
    last_sync: Optional[str] = None
    quality_preference: str = "high"  # Note: Standard, high, ultra
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
        
        # Note: Filter out keys that are not in the dataclass
        import dataclasses
        field_names = {f.name for f in dataclasses.fields(cls)}
        filtered_data = {k: v for k, v in data.items() if k in field_names}
        
        filtered_data['provider'] = StorageProvider(filtered_data['provider'])
        
        if filtered_data.get('is_encrypted', False):
            # Note: Decrypt for in-memory use
            dec_id = CredentialManager.decrypt(filtered_data['access_key_id'])
            dec_key = CredentialManager.decrypt(filtered_data['secret_access_key'])
            
            # Note: If decryption works, update data. if not (e.g. wrong machine),
            # Note: We keep encrypted strings (which will fail auth, but not crash)
            if dec_id is not None and dec_key is not None:
                filtered_data['access_key_id'] = dec_id
                filtered_data['secret_access_key'] = dec_key
                filtered_data['is_encrypted'] = False # Note: Marked as raw in memory
        
        return cls(**filtered_data)
    
    def to_json(self, indent: int = 2) -> str:
        """Serialize to JSON."""
        return json.dumps(self.to_dict(), indent=indent)
    
    @classmethod
    def from_json(cls, json_str: str) -> 'PlayerConfig':
        """Deserialize from JSON."""
        return cls.from_dict(json.loads(json_str))
