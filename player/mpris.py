import logging
from mpris_server.adapters import MprisAdapter
from mpris_server.events import EventAdapter

class MusicHubMpris(MprisAdapter):
    """
    MPRIS Interface for internal PlaybackEngine.
    """
    def __init__(self, engine, app):
        super().__init__()
        self.engine = engine
        self.app = app
        self._current_track = None
        
        # Connect to engine signals
        self.engine.set_state_change_callback(self.on_state_change)
        self.engine.add_track_end_callback(self.on_track_end_relay)
        # Note: Time update is too frequent for generic event relay, usually handled by query

    def get_current_track_info(self):
        """Return generic track info for DBus."""
        if not self.engine.current_track:
             return {"mpris:trackid": "/org/mpris/MediaPlayer2/TrackList/NoTrack"}
             
        track = self.engine.current_track
        # mpris:trackid must be unique path
        return {
            "mpris:trackid": f"/org/mpris/MediaPlayer2/TrackList/{track.id}",
            "mpris:length": int((track.duration or 0) * 1_000_000), # Microseconds
            "xesam:title": track.title,
            "xesam:artist": [track.artist] if track.artist else ["Unknown"],
            "xesam:album": track.album or "Unknown",
        }

    def can_control(self):
        return True

    def can_go_next(self):
        return True

    def can_go_previous(self):
        return True

    def can_pause(self):
        return True

    def can_play(self):
        return True
        
    def can_seek(self):
        return True

    # --- Actions triggered by system (DBus) ---
    def play(self):
        """Handle play command from MPRIS/media keys."""
        if not self.engine.is_playing:
            if self.engine.current_track:
                self.engine.pause()  # Resume paused track
            else:
                # No track loaded - request first track from app
                if hasattr(self.app, 'win') and hasattr(self.app.win, 'play_first_track'):
                    self.app.win.play_first_track()

    def pause(self):
        """Handle pause command from MPRIS/media keys."""
        if self.engine.is_playing:
            self.engine.pause()

    def playpause(self):
        """Handle play/pause toggle from MPRIS/media keys."""
        if self.engine.current_track:
            self.engine.pause()  # Toggles internally
        else:
            # No track loaded - start playback
            self.play()

    def stop(self):
        """Handle stop command from MPRIS/media keys."""
        self.engine.stop()

    def next(self):
        """Handle next track command from MPRIS/media keys."""
        # TODO: Implement queue management, for now just a placeholder
        if hasattr(self.app, 'win') and hasattr(self.app.win, 'play_next'):
            self.app.win.play_next()
        else:
            print("Next track: Queue management not yet implemented")

    def previous(self):
        """Handle previous track command from MPRIS/media keys."""
        # TODO: Implement queue management, for now just a placeholder
        if hasattr(self.app, 'win') and hasattr(self.app.win, 'play_previous'):
            self.app.win.play_previous()
        else:
            print("Previous track: Queue management not yet implemented")
            
    def seek(self, offset):
        # Offset in microseconds
        current = self.engine.get_time()
        self.engine.seek(current + (offset / 1_000_000))
        
    def set_position(self, track_id, position):
        self.engine.seek(position / 1_000_000)

    # --- Internal events to System ---
    def on_state_change(self, state):
        # Relay to app UI first if needed (already handled by app connecting to engine)
        # We need to trigger MPRIS properties update
        # The MprisServer polls 'get_playback_status', so we just need to ensure our state is consistent
        # But we can emit signal if needed.
        # Actually mpris_server handles a lot of this magic?
        # We communicate via the 'EventAdapter' if using that pattern, 
        # or we update our internal state and let the loop handle it
        pass
        
    def on_track_end_relay(self):
        # Engine calls this when track ends
        pass

    def get_playback_status(self):
        if self.engine.is_playing:
            return "Playing"
        elif self.engine.current_track:
            return "Paused"
        else:
            return "Stopped"

    def get_loop_status(self):
        return "None"
        
    def get_shuffle(self):
        return False
        
    def get_volume(self):
        return self.engine.player.volume / 100.0
        
    def set_volume(self, volume):
        self.engine.set_volume(volume * 100)
