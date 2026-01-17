import os
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from .config import (
    SPOTIFY_CLIENT_ID, 
    SPOTIFY_CLIENT_SECRET, 
    SPOTIFY_REDIRECT_URI, 
    SPOTIFY_SCOPE,
    CREDENTIALS_DIR
)

class SpotifyAuth:
    """Handles Spotify Authentication."""
    
    def __init__(self):
        self.client_id = SPOTIFY_CLIENT_ID
        self.client_secret = SPOTIFY_CLIENT_SECRET
        self.redirect_uri = SPOTIFY_REDIRECT_URI
        self.scope = SPOTIFY_SCOPE
        self.cache_path = CREDENTIALS_DIR / ".spotify_cache"
        
    def get_client(self) -> spotipy.Spotify:
        """
        Authenticate and return a Spotify client.
        If not authenticated, this will trigger the OAuth flow (opens browser).
        Returns None if credentials are missing.
        """
        if not self.client_id or not self.client_secret:
            print("Warning: Spotify credentials not found. Some features will be disabled.")
            return None
            
        try:
            auth_manager = SpotifyOAuth(
                client_id=self.client_id,
                client_secret=self.client_secret,
                redirect_uri=self.redirect_uri,
                scope=self.scope,
                cache_path=str(self.cache_path),
                open_browser=True
            )
            return spotipy.Spotify(auth_manager=auth_manager)
        except Exception as e:
            print(f"Error initializing Spotify client: {e}")
            return None

    def check_credentials(self) -> bool:
        """Check if credentials are set and valid token exists."""
        if not self.client_id or not self.client_secret:
            return False
        
        # lightweight check
        auth_manager = SpotifyOAuth(
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=self.redirect_uri,
            scope=self.scope,
            cache_path=str(self.cache_path)
        )
        return auth_manager.validate_token(auth_manager.cache_handler.get_cached_token()) is not None
