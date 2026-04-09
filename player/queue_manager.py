"""
Queue Manager for Music Player.
Provides simple in-memory queue management for playback.
"""

from typing import List, Optional, Callable
from shared.models import Track, QueueItem
import threading


class QueueManager:
    """
    Simple in-memory queue manager for music playback.
    Holds QueueItems (library or preview). Session-based - queue clears when application exits.
    """
    
    def __init__(self):
        self._queue: List[QueueItem] = []
        self._history: List[QueueItem] = []
        self._repeat_mode = "off"  # Note: Off, all, one, once (web: one=infinite song, once=one extra play)
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

    def add_item(self, item: QueueItem) -> None:
        """Add a queue item (library or preview) to the end of the queue."""
        with self._lock:
            self._queue.append(item)
            print(f"Added to queue: {item.title} by {item.artist}")
            self._notify_change()

    def add_library_track(self, track: Track) -> None:
        """Add a library track to the queue."""
        self.add_item(QueueItem.from_library_track(track))

    def add_preview(
        self,
        video_id: str,
        title: str,
        artist: str,
        duration: int,
        thumbnail: Optional[str] = None,
        library_track_id: Optional[str] = None,
        album: Optional[str] = None,
    ) -> None:
        """Add a preview (yt-dlp) item to the queue."""
        self.add_item(QueueItem.from_preview(
            video_id=video_id,
            title=title,
            artist=artist,
            duration=duration,
            thumbnail=thumbnail,
            library_track_id=library_track_id,
            album=album,
        ))

    def add(self, track: Track) -> None:
        """Add a library track to the end of the queue (convenience for GTK/API)."""
        self.add_library_track(track)
    
    def add_multiple(self, tracks: List[Track]) -> None:
        """Add multiple library tracks to the queue at once."""
        with self._lock:
            for track in tracks:
                self._queue.append(QueueItem.from_library_track(track))
            print(f"Added {len(tracks)} tracks to queue")
            self._notify_change()
    
    def get_next(self) -> Optional[QueueItem]:
        """
        Get and remove the next item from the queue based on repeat mode.
        """
        with self._lock:
            if not self._queue:
                if self._repeat_mode == "all" and self._history:
                    self._queue = self._history.copy()
                    self._history.clear()
                    print("Queue refilled from history (Repeat All)")
                else:
                    return None

            item = self._queue.pop(0)
            self._history.append(item)
            print(f"Dequeued: {item.title}")
            self._notify_change()
            return item
    
    def peek(self) -> Optional[QueueItem]:
        """View the next item without removing it. Returns None if queue is empty."""
        with self._lock:
            return self._queue[0] if self._queue else None
    
    def get_all(self) -> List[QueueItem]:
        """Get a copy of all queued items."""
        with self._lock:
            return self._queue.copy()

    def remove_by_id(self, item_id: str) -> int:
        """Remove all entries with the given id (library UUID or video_id). Returns number removed."""
        with self._lock:
            indices = [i for i, item in enumerate(self._queue) if item.id == item_id]
            if not indices:
                return 0
            for i in reversed(indices):
                self._queue.pop(i)
            self._notify_change()
            return len(indices)
    
    def remove(self, index: int) -> bool:
        """
        Remove the item at the specified index.
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
        Move an item from one position to another in the queue.
        Returns True if successful, False otherwise.
        """
        with self._lock:
            if 0 <= from_index < len(self._queue) and 0 <= to_index < len(self._queue):
                item = self._queue.pop(from_index)
                self._queue.insert(to_index, item)
                print(f"Moved track from {from_index} to {to_index}")
                self._notify_change()
                return True
            return False
    
    def clear(self) -> None:
        """Clear all items from the queue."""
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
