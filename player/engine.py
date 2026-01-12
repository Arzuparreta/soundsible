"""
Core playback engine using python-mpv.
Handles the low-level details of audio playback, events, and state.
"""

import mpv
import os
from typing import Optional, Callable, Dict, Any, List
from shared.models import Track

class PlaybackEngine:
    """Wrapper around MPV for music playback."""
    
    def __init__(self):
        # Initialize MPV with options optimized for streaming
        # vo='null' because we are audio-only
        self.player = mpv.MPV(
            input_default_bindings=True, 
            input_vo_keyboard=True, 
            osc=True,
            vo='null',
            ytdl=False  # We provide direct URLs
        )
        
        # Callbacks
        self._on_track_end: Optional[Callable[[], None]] = None
        self._on_time_update: Optional[Callable[[float], None]] = None
        self._on_state_change: Optional[Callable[[str], None]] = None
        
        # State
        self.current_track: Optional[Track] = None
        self.is_playing = False
        
        # Bind events
        self.player.observe_property('time-pos', self._handle_time_update)
        self.player.observe_property('eof-reached', self._handle_eof)
        self.player.observe_property('pause', self._handle_pause_change)
        
        # Set initial volume
        self.player.volume = 100

    def play(self, url: str, track: Track):
        """Start playing a track from a URL (local or remote)."""
        self.current_track = track
        self.player.play(url)
        self.is_playing = True
        self.player.pause = False
        
        if self._on_state_change:
            self._on_state_change('playing')
            
    def pause(self):
        """Toggle pause."""
        self.player.pause = not self.player.pause
        self.is_playing = not self.player.pause
        
        state = 'paused' if self.player.pause else 'playing'
        if self._on_state_change:
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
            self.player.seek(position, reference='absolute')
            
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
        if value is not None and self._on_time_update:
            self._on_time_update(value)
            
    def _handle_eof(self, name, value):
        if value and self._on_track_end:
            self._on_track_end()
            
    def _handle_pause_change(self, name, value):
        self.is_playing = not value
        state = 'paused' if value else 'playing'
        if self._on_state_change:
            self._on_state_change(state)

    # Callback setters
    def set_track_end_callback(self, callback: Callable[[], None]):
        self._on_track_end = callback
        
    def set_time_update_callback(self, callback: Callable[[float], None]):
        self._on_time_update = callback
        
    def set_state_change_callback(self, callback: Callable[[str], None]):
        self._on_state_change = callback
