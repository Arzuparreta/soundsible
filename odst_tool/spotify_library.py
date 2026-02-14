from typing import List, Dict, Any, Optional
import time
from rich.progress import Progress, SpinnerColumn, TextColumn
import spotipy
from .spotify_auth import SpotifyAuth

class SpotifyLibrary:
    """Handles retrieval of music from Spotify."""
    
    def __init__(self, client: Optional[spotipy.Spotify] = None, skip_auth: bool = False, access_token: str = None, client_id=None, client_secret=None, open_browser=None):
        if client:
            self.client = client
        elif access_token:
            self.client = spotipy.Spotify(auth=access_token)
        elif not skip_auth:
            # Can return None now
            self.client = SpotifyAuth(client_id=client_id, client_secret=client_secret).get_client(open_browser=open_browser)
        else:
            self.client = None
            
    def get_user_profile(self) -> Dict[str, Any]:
        """Get current user profile."""
        return self.client.current_user()

    def get_all_liked_songs(self) -> List[Dict[str, Any]]:
        """
        Retrieve all liked songs from the user's library. 
        Auto-paginates to get everything.
        """
        tracks = []
        results = self.client.current_user_saved_tracks(limit=50)
        
        while results:
            for item in results['items']:
                track = item['track']
                # Add 'added_at' date to track metadata for sorting/info
                track['added_at'] = item['added_at']
                tracks.append(track)
            
            if results['next']:
                results = self.client.next(results)
            else:
                break
                
        return tracks

    def _call_with_retry(self, func, *args, **kwargs):
        """Helper to execute spotipy functions with rate limit handling."""
        retries = 3
        for i in range(retries):
            try:
                return func(*args, **kwargs)
            except SpotifyException as e:
                # HTTP 429 = Too Many Requests
                if e.http_status == 429:
                    retry_after = int(e.headers.get("Retry-After", 1)) + 1
                    print(f"Rate limited. Waiting {retry_after}s...")
                    time.sleep(retry_after)
                    continue
                else:
                    raise e
        raise Exception("Max retries exceeded for Spotify API")

    def get_user_playlists(self) -> List[Dict]:
        """Fetch all playlists for the current user."""
        if not self.client: return []
        
        playlists = []
        try:
            results = self._call_with_retry(self.client.current_user_playlists, limit=50)
            playlists.extend(results['items'])
            while results['next']:
                results = self._call_with_retry(self.client.next, results)
                playlists.extend(results['items'])
        except Exception as e:
            print(f"Error fetching playlists: {e}")
            
        return playlists

    def get_playlist_tracks(self, playlist_id: str) -> List[Dict]:
        """Fetch all tracks from a specific playlist."""
        if not self.client: return []
        
        tracks = []
        try:
            results = self._call_with_retry(self.client.playlist_items, playlist_id, additional_types=['track'])
            tracks.extend([item['track'] for item in results['items'] if item['track']])
            while results['next']:
                results = self._call_with_retry(self.client.next, results)
                tracks.extend([item['track'] for item in results['items'] if item['track']])
        except Exception as e:
            print(f"Error fetching playlist tracks: {e}")
            
        return tracks

    def get_all_liked_songs(self) -> List[Dict]:
        """Fetch all liked songs."""
        if not self.client: return []
        
        tracks = []
        try:
            results = self._call_with_retry(self.client.current_user_saved_tracks, limit=50)
            tracks.extend([item['track'] for item in results['items']])
            while results['next']:
                results = self._call_with_retry(self.client.next, results)
                tracks.extend([item['track'] for item in results['items']])
        except Exception as e:
            print(f"Error fetching liked songs: {e}")
            
        return tracks

    def get_saved_albums_tracks(self) -> List[Dict[str, Any]]:
        """Get all tracks from saved albums."""
        tracks = []
        results = self.client.current_user_saved_albums(limit=20)
        
        while results:
            for item in results['items']:
                album = item['album']
                for track in album['tracks']['items']:
                    # Enrich track with album metadata since it's missing in track object
                    track['album'] = album
                    # Use album added date as proxy
                    track['added_at'] = item['added_at'] 
                    # Add artist info if missing (sometimes simplified in album view)
                    if 'artists' not in track:
                        track['artists'] = album['artists']
                    tracks.append(track)
            
            if results['next']:
                results = self.client.next(results)
            else:
                break
        return tracks

    def extract_track_metadata(self, spotify_track: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert Spotify track object to simplified metadata dict.
        Useful for passing to the downloader/searcher.
        """
        # Handle cases where track might be None or malformed
        if not spotify_track:
            return {}
            
        return {
            'title': spotify_track['name'],
            'artist': spotify_track['artists'][0]['name'],
            'album': spotify_track['album']['name'] if 'album' in spotify_track else 'Unknown Album',
            'duration_ms': spotify_track['duration_ms'],
            'duration_sec': spotify_track['duration_ms'] // 1000,
            'isrc': spotify_track.get('external_ids', {}).get('isrc'),
            'spotify_id': spotify_track['id'],
            'explicit': spotify_track.get('explicit', False),
            'track_number': spotify_track.get('track_number'),
            'disc_number': spotify_track.get('disc_number'),
            'release_date': spotify_track['album']['release_date'] if 'album' in spotify_track else None,
            'album_art_url': spotify_track['album']['images'][0]['url'] if 'album' in spotify_track and spotify_track['album'].get('images') else None
        }

    def selection_menu(self):
        """Interactive CLI menu for selecting what to download."""
        # This will be called by the main script using Rich
        pass
