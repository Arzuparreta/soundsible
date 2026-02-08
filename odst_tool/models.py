"""
Data models compatible with Soundsible.
"""

from dataclasses import dataclass, asdict, field
from typing import List, Dict, Optional, Any
import json
import uuid
from datetime import datetime

@dataclass
class Track:
    """
    Represents a single music track with metadata.
    Compatible with Soundsible Track model.
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
    
    @staticmethod
    def generate_id() -> str:
        """Generate a unique track ID."""
        return str(uuid.uuid4())
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert track to dictionary."""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Track':
        """Create Track from dictionary."""
        return cls(**data)

@dataclass
class LibraryMetadata:
    """
    Represents the entire music library metadata.
    Compatible with Soundsible LibraryMetadata model.
    """
    version: int
    tracks: List[Track]
    playlists: Dict[str, List[str]]  # playlist_name -> [track_ids]
    settings: Dict[str, Any]
    last_updated: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    
    def to_json(self, indent: int = 2) -> str:
        """Serialize library metadata to JSON string."""
        data = {
            "version": self.version,
            "tracks": [track.to_dict() for track in self.tracks],
            "playlists": self.playlists,
            "settings": self.settings,
            "last_updated": self.last_updated
        }
        return json.dumps(data, indent=indent)
    
    @classmethod
    def from_json(cls, json_str: str) -> 'LibraryMetadata':
        """Deserialize library metadata from JSON string."""
        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            # Handle empty/corrupt file gracefully by returning empty library
            data = {}

        tracks_data = data.get("tracks", [])
        tracks = [Track.from_dict(t) for t in tracks_data]
        
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
    
    def get_track_by_hash(self, file_hash: str) -> Optional[Track]:
        """Find track by file hash."""
        for track in self.tracks:
            if track.file_hash == file_hash:
                return track
        return None
        
    def add_track(self, track: Track) -> None:
        """Add a track to the library, replacing if exists."""
        # Check if already exists (by hash)
        for i, t in enumerate(self.tracks):
            if t.file_hash == track.file_hash:
                self.tracks[i] = track
                self.last_updated = datetime.utcnow().isoformat()
                return
        
        self.tracks.append(track)
        self.last_updated = datetime.utcnow().isoformat()

    def add_to_playlist(self, playlist_name: str, track_id: str) -> None:
        """Add track id to playlist safely."""
        if playlist_name not in self.playlists:
            self.playlists[playlist_name] = []
        
        if track_id not in self.playlists[playlist_name]:
            self.playlists[playlist_name].append(track_id)
            self.last_updated = datetime.utcnow().isoformat()
