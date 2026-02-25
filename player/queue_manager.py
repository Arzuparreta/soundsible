"""
Queue Manager for Music Player.
Provides simple in-memory queue management for playback.
"""

from typing import List, Optional, Callable
from shared.models import Track
import threading


class QueueManager:
    """
    Simple in-memory queue manager for music playback.
    Session-based - queue clears when application exits.
    """
    
    def __init__(self):
        self._queue: List[Track] = []
        self._history: List[Track] = [] # Track played songs for "Repeat All"
        self._repeat_mode = "off"  # off, all, one, once (web: one=infinite song, once=one extra play)
        self._lock = threading.Lock()
        self._on_change_callbacks: List[Callable[[], None]] = []
    
    def set_repeat_mode(self, mode: str) -> None:
        with self._lock:
            self._repeat_mode = mode
            self._notify_change()

    def get_repeat_mode(self) -> str:
        return self._repeat_mode

    def shuffle(self) -> None:
        """Shuffle the current queue."""
        import random
        with self._lock:
            random.shuffle(self._queue)
            self._notify_change()

    def add(self, track: Track) -> None:
        """Add a track to the end of the queue."""
        with self._lock:
            self._queue.append(track)
            print(f"Added to queue: {track.title} by {track.artist}")
            self._notify_change()
    
    def add_multiple(self, tracks: List[Track]) -> None:
        """Add multiple tracks to the queue at once."""
        with self._lock:
            self._queue.extend(tracks)
            print(f"Added {len(tracks)} tracks to queue")
            self._notify_change()
    
    def get_next(self) -> Optional[Track]:
        """
        Get and remove the next track from the queue based on repeat mode.
        """
        with self._lock:
            # Handle Repeat One: Just peek the last played if we had one? 
            # Actually, the engine handles 'Repeat One' usually, but here we can return it.
            # However, get_next is destructive (pops from queue).
            
            if not self._queue:
                if self._repeat_mode == "all" and self._history:
                    # Refill queue from history
                    self._queue = self._history.copy()
                    self._history.clear()
                    print("Queue refilled from history (Repeat All)")
                else:
                    return None

            track = self._queue.pop(0)
            self._history.append(track)
            print(f"Dequeued: {track.title}")
            self._notify_change()
            return track
    
    def peek(self) -> Optional[Track]:
        """
        View the next track without removing it.
        Returns None if queue is empty.
        """
        with self._lock:
            return self._queue[0] if self._queue else None
    
    def get_all(self) -> List[Track]:
        """Get a copy of all queued tracks."""
        with self._lock:
            return self._queue.copy()
    
    def remove(self, index: int) -> bool:
        """
        Remove a track at the specified index.
        Returns True if successful, False if index out of range.
        """
        with self._lock:
            if 0 <= index < len(self._queue):
                removed = self._queue.pop(index)
                print(f"Removed from queue: {removed.title}")
                self._notify_change()
                return True
            return False
    
    def move(self, from_index: int, to_index: int) -> bool:
        """
        Move a track from one position to another in the queue.
        Returns True if successful, False otherwise.
        """
        with self._lock:
            if 0 <= from_index < len(self._queue) and 0 <= to_index < len(self._queue):
                track = self._queue.pop(from_index)
                self._queue.insert(to_index, track)
                print(f"Moved track from {from_index} to {to_index}")
                self._notify_change()
                return True
            return False
    
    def clear(self) -> None:
        """Clear all tracks from the queue."""
        with self._lock:
            count = len(self._queue)
            self._queue.clear()
            print(f"Queue cleared ({count} tracks removed)")
            self._notify_change()
    
    def is_empty(self) -> bool:
        """Check if the queue is empty."""
        with self._lock:
            return len(self._queue) == 0
    
    def size(self) -> int:
        """Get the number of tracks in the queue."""
        with self._lock:
            return len(self._queue)
    
    def add_change_callback(self, callback: Callable[[], None]) -> None:
        """Register a callback to be called when the queue changes."""
        if callback not in self._on_change_callbacks:
            self._on_change_callbacks.append(callback)
    
    def remove_change_callback(self, callback: Callable[[], None]) -> None:
        """Unregister a queue change callback."""
        if callback in self._on_change_callbacks:
            self._on_change_callbacks.remove(callback)
    
    def _notify_change(self) -> None:
        """Notify all registered callbacks that the queue has changed."""
        for callback in self._on_change_callbacks:
            try:
                callback()
            except Exception as e:
                print(f"Error in queue change callback: {e}")
