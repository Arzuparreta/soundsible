"""
Favourites Manager for Music Player.
Manages favourite tracks with JSON persistence.
"""

from typing import Set, List, Callable, Optional
from shared.models import Track
from shared.constants import DEFAULT_CONFIG_DIR
from pathlib import Path
import threading
import json


class FavouritesManager:
    """
    Manages favourite tracks with JSON file persistence.
    Tracks are identified by their ID.
    """
    
    def __init__(self):
        self._favourites: Set[str] = set()
        self._lock = threading.Lock()
        self._on_change_callbacks: List[Callable[[], None]] = []
        self._favourites_file = Path(DEFAULT_CONFIG_DIR).expanduser() / "favourites.json"
        
        # Load existing favourites
        self._load_from_file()
    
    def add(self, track_id: str) -> None:
        """Add a track to favourites."""
        with self._lock:
            if track_id not in self._favourites:
                self._favourites.add(track_id)
                print(f"Added to favourites: {track_id}")
                self._save_to_file()
                self._notify_change()
    
    def remove(self, track_id: str) -> None:
        """Remove a track from favourites."""
        with self._lock:
            if track_id in self._favourites:
                self._favourites.remove(track_id)
                print(f"Removed from favourites: {track_id}")
                self._save_to_file()
                self._notify_change()
    
    def toggle(self, track_id: str) -> bool:
        """
        Toggle favourite status of a track.
        Returns True if now favourited, False if unfavourited.
        """
        with self._lock:
            if track_id in self._favourites:
                self._favourites.remove(track_id)
                print(f"Toggled OFF favourite: {track_id}")
                self._save_to_file()
                self._notify_change()
                return False
            else:
                self._favourites.add(track_id)
                print(f"Toggled ON favourite: {track_id}")
                self._save_to_file()
                self._notify_change()
                return True
    
    def is_favourite(self, track_id: str) -> bool:
        """Check if a track is favourited."""
        with self._lock:
            return track_id in self._favourites
    
    def get_all(self) -> List[str]:
        """Get list of all favourite track IDs."""
        with self._lock:
            return list(self._favourites)
    
    def size(self) -> int:
        """Get count of favourited tracks."""
        with self._lock:
            return len(self._favourites)
    
    def clear(self) -> None:
        """Clear all favourites."""
        with self._lock:
            self._favourites.clear()
            print("Cleared all favourites")
            self._save_to_file()
            self._notify_change()
    
    def add_change_callback(self, callback: Callable[[], None]) -> None:
        """Register a callback to be called when favourites change."""
        if callback not in self._on_change_callbacks:
            self._on_change_callbacks.append(callback)
    
    def remove_change_callback(self, callback: Callable[[], None]) -> None:
        """Unregister a favourites change callback."""
        if callback in self._on_change_callbacks:
            self._on_change_callbacks.remove(callback)
    
    def _notify_change(self) -> None:
        """Notify all registered callbacks that favourites have changed."""
        for callback in self._on_change_callbacks:
            try:
                callback()
            except Exception as e:
                print(f"Error in favourites change callback: {e}")
    
    def _save_to_file(self) -> None:
        """Save favourites to JSON file."""
        try:
            # Ensure config directory exists
            self._favourites_file.parent.mkdir(parents=True, exist_ok=True)
            
            data = {
                "version": "1.0",
                "favourites": list(self._favourites)
            }
            
            with open(self._favourites_file, 'w') as f:
                json.dump(data, f, indent=2)
            
            print(f"Saved {len(self._favourites)} favourites to {self._favourites_file}")
        except Exception as e:
            print(f"Error saving favourites to file: {e}")
    
    def _load_from_file(self) -> None:
        """Load favourites from JSON file."""
        try:
            if not self._favourites_file.exists():
                print(f"No favourites file found at {self._favourites_file}, starting fresh")
                return
            
            with open(self._favourites_file, 'r') as f:
                data = json.load(f)
            
            # Validate data structure
            if not isinstance(data, dict) or 'favourites' not in data:
                print("Invalid favourites file format, starting fresh")
                return
            
            favourites_list = data['favourites']
            if not isinstance(favourites_list, list):
                print("Invalid favourites list format, starting fresh")
                return
            
            self._favourites = set(favourites_list)
            print(f"Loaded {len(self._favourites)} favourites from {self._favourites_file}")
            
        except json.JSONDecodeError as e:
            print(f"Error decoding favourites JSON file: {e}, starting fresh")
        except Exception as e:
            print(f"Error loading favourites from file: {e}, starting fresh")
