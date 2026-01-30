"""
Core playback engine using python-mpv.
Handles the low-level details of audio playback, events, and state.
"""

import mpv
import os
from typing import Optional, Callable, Dict, Any, List
from shared.models import Track
from player.queue_manager import QueueManager

class PlaybackEngine:
    """Wrapper around MPV for music playback."""
    
    def __init__(self, queue_manager: Optional[QueueManager] = None):
        # Initialize MPV with options optimized for streaming
        # vo='null' because we are audio-only
        self.player = mpv.MPV(
            input_default_bindings=True, 
            input_vo_keyboard=True, 
            osc=True,
            vo='null',
            ytdl=False  # We provide direct URLs
        )
        
        # Queue Manager
        self.queue_manager = queue_manager
        
        # Callbacks
        self._track_end_callbacks: List[Callable[[], None]] = []
        self._on_time_update: Optional[Callable[[float], None]] = None
        self._on_state_change: Optional[Callable[[str], None]] = None
        self._on_track_load: Optional[Callable[[Track], None]] = None  # For UI to load next track
        
        # State
        self.current_track: Optional[Track] = None
        self.is_playing = False
        
        # Throttling for time updates (reduce CPU usage)
        self._last_time_update = 0.0
        
        # Bind events
        self.player.observe_property('time-pos', self._handle_time_update)
        self.player.observe_property('eof-reached', self._handle_eof)
        self.player.observe_property('idle-active', self._handle_idle)
        
        # Pause observer disabled - using explicit state updates in play()/pause()
        # self.player.observe_property('pause', self._handle_pause_change)
        
        # Set initial volume
        self.player.volume = 100

    def play(self, url: str, track: Track):
        """Start playing a track from a URL (local or remote)."""
        self.current_track = track
        self.player.play(url)
        self.player.pause = False
        self.is_playing = True
        
        # Notify UI of state change
        if self._on_state_change:
            self._on_state_change('playing')
            
    def pause(self):
        """Toggle pause."""
        self.player.pause = not self.player.pause
        self.is_playing = not self.player.pause
        
        # Explicitly notify UI immediately
        if self._on_state_change:
            state = 'paused' if self.player.pause else 'playing'
            self._on_state_change(state)
            
    def stop(self):
        """Stop playback."""
        self.player.stop()
        self.is_playing = False
        self.current_track = None
        if self._on_state_change:
            self._on_state_change('stopped')

    def seek(self, position: float):
        """Seek to absolute position in seconds."""
        if self.current_track:
            try:
                self.player.seek(position, reference='absolute')
            except Exception as e:
                print(f"Error seeking: {e}")
            
    def set_volume(self, level: int):
        """Set volume (0-100)."""
        self.player.volume = max(0, min(100, level))
        
    def get_time(self) -> float:
        """Get current playback time in seconds."""
        return self.player.time_pos or 0
        
    def get_duration(self) -> float:
        """Get track duration in seconds."""
        return self.player.duration or 0

    # Event handlers
    def _handle_time_update(self, name, value):
        """Handle time position updates from MPV with throttling."""
        if value is not None and self._on_time_update:
            # Throttle to ~4 updates per second (250ms between updates)
            import time
            current_time = time.time()
            if current_time - self._last_time_update >= 0.25:
                self._last_time_update = current_time
                self._on_time_update(value)
            
            
    def _handle_eof(self, name, value):
        print(f"DEBUG: MPV eof-reached: {value}")
        if value:
            self._trigger_track_end()
            
    def _handle_idle(self, name, value):
        """Handle idle state (player stopped/finished)."""
        print(f"DEBUG: MPV idle-active: {value}")
        if value and self.is_playing:
            print("DEBUG: Player went idle while supposedly playing. Triggering track end.")
            self._trigger_track_end()

    def _trigger_track_end(self):
        """Execute all registered track end callbacks safely."""
        print(f"DEBUG: Triggering {len(self._track_end_callbacks)} track end callbacks")
        
        # First, execute custom callbacks
        for callback in self._track_end_callbacks:
            try:
                print(f"DEBUG: Executing callback: {callback}")
                callback()
            except Exception as e:
                print(f"ERROR executing track_end callback {callback}: {e}")
        
        # Then, check queue for auto-play
        if self.queue_manager and not self.queue_manager.is_empty():
            next_track = self.queue_manager.get_next()
            if next_track and self._on_track_load:
                print(f"DEBUG: Auto-playing next queued track: {next_track.title}")
                try:
                    self._on_track_load(next_track)
                except Exception as e:
                    print(f"ERROR auto-playing queued track: {e}")
            
    def _handle_pause_change(self, name, value):
        """Handle pause state changes from MPV."""
        # Ignore None values (MPV initialization)
        if value is None:
            return
            
        self.is_playing = not value
        
        # Only send state change callbacks if we have a track
        # This prevents UI updates for spurious MPV state changes
        if self._on_state_change:
            state = 'paused' if value else 'playing'
            self._on_state_change(state)

    # Callback setters
    def add_track_end_callback(self, callback: Callable[[], None]):
        """Register a callback for when a track ends."""
        print(f"DEBUG: Adding track_end_callback check: {callback}")
        if callback not in self._track_end_callbacks:
            self._track_end_callbacks.append(callback)
            print(f"DEBUG: Callback added. Total callbacks: {len(self._track_end_callbacks)}")
        else:
            print("DEBUG: Callback already registered.")
        
    def set_time_update_callback(self, callback: Callable[[float], None]):
        self._on_time_update = callback
        
    def set_state_change_callback(self, callback: Callable[[str], None]):
        self._on_state_change = callback
    
    def set_track_load_callback(self, callback: Callable[[Track], None]):
        """Set callback for when a new track should be loaded (e.g., from queue)."""
        self._on_track_load = callback
