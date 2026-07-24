"""
Favourites Manager for Music Player.
Manages favourite tracks with JSON persistence.
"""

import json
import logging
import threading
from pathlib import Path
from typing import Set, List, Callable, Optional

from shared.models import Track
from shared.user_context import user_config_dir

logger = logging.getLogger(__name__)


class FavouritesManager:
    """
    Manages favourite tracks with JSON file persistence.
    Tracks are identified by their ID.
    """
    
    def __init__(self):
        self._favourites: Set[str] = set()
        self._lock = threading.RLock()  # Note: Use reentrant lock to prevent deadlocks with callbacks
        self._on_change_callbacks: List[Callable[[], None]] = []
        self._favourites_file = user_config_dir() / "favourites.json"
        
        # Note: Load existing favourites
        self._load_from_file()
    
    def add(self, track_id: str) -> None:
        """Add a track to favourites."""
        with self._lock:
            if track_id not in self._favourites:
                self._favourites.add(track_id)
                logger.debug("Added to favourites: %s", track_id)
                self._save_to_file()
                self._notify_change()
    
    def remove(self, track_id: str) -> None:
        """Remove a track from favourites."""
        with self._lock:
            if track_id in self._favourites:
                self._favourites.remove(track_id)
                logger.debug("Removed from favourites: %s", track_id)
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
                logger.debug("Toggled OFF favourite: %s", track_id)
                self._save_to_file()
                self._notify_change()
                return False
            else:
                self._favourites.add(track_id)
                logger.debug("Toggled ON favourite: %s", track_id)
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
            logger.debug("Cleared all favourites")
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
                logger.warning("Error in favourites change callback: %s", e)
    
    def _save_to_file(self) -> None:
        """Save favourites to JSON file."""
        try:
            # Note: Ensure config directory exists
            self._favourites_file.parent.mkdir(parents=True, exist_ok=True)
            
            data = {
                "version": "1.0",
                "favourites": list(self._favourites)
            }
            
            with open(self._favourites_file, 'w') as f:
                json.dump(data, f, indent=2)
            
            logger.debug("Saved %s favourites to %s", len(self._favourites), self._favourites_file)
        except Exception as e:
            logger.warning("Error saving favourites to file: %s", e)
    
    def _load_from_file(self) -> None:
        """Load favourites from JSON file."""
        try:
            if not self._favourites_file.exists():
                logger.debug("No favourites file found at %s, starting fresh", self._favourites_file)
                return
            
            with open(self._favourites_file, 'r') as f:
                data = json.load(f)
            
            # Note: Validate data structure
            if not isinstance(data, dict) or 'favourites' not in data:
                logger.warning("Invalid favourites file format, starting fresh")
                return
            
            favourites_list = data['favourites']
            if not isinstance(favourites_list, list):
                logger.warning("Invalid favourites list format, starting fresh")
                return
            
            self._favourites = set(favourites_list)
            logger.debug("Loaded %s favourites from %s", len(self._favourites), self._favourites_file)
            
        except json.JSONDecodeError as e:
            logger.warning("Error decoding favourites JSON file: %s, starting fresh", e)
        except Exception as e:
            logger.warning("Error loading favourites from file: %s, starting fresh", e)
