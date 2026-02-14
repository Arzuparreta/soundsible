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
    
    def __init__(self, client_id=None, client_secret=None):
        self.client_id = client_id or SPOTIFY_CLIENT_ID
        self.client_secret = client_secret or SPOTIFY_CLIENT_SECRET
        self.redirect_uri = SPOTIFY_REDIRECT_URI
        self.scope = SPOTIFY_SCOPE
        self.cache_path = CREDENTIALS_DIR / ".spotify_cache"
        
    def get_client(self, open_browser=None) -> spotipy.Spotify:
        """
        Authenticate and return a Spotify client.
        If not authenticated, this will trigger the OAuth flow.
        Returns None if credentials are missing.
        """
        if not self.client_id or not self.client_secret:
            print("Warning: Spotify credentials not found. Some features will be disabled.")
            return None
            
        try:
            # For server environments, we usually want open_browser=False
            # if we can't interact with the desktop.
            if open_browser is None:
                # Detect if we are in a headless environment or terminal
                open_browser = False if os.environ.get("HEADLESS") == "1" else True

            auth_manager = SpotifyOAuth(
                client_id=self.client_id,
                client_secret=self.client_secret,
                redirect_uri=self.redirect_uri,
                scope=self.scope,
                cache_path=str(self.cache_path),
                open_browser=open_browser
            )
            
            # Passive check: If we can't open a browser, only return a client 
            # if we already have a valid token in the cache.
            if not open_browser:
                token = auth_manager.get_cached_token()
                if not token:
                    print("Spotify: No cached token and browser disabled. Skipping auth.")
                    return None
            
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
