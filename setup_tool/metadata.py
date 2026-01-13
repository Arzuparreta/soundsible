"""
Metadata fetching utilities using iTunes Search API.
"""

import requests
import urllib.parse
from typing import List, Dict, Optional, Any

def search_itunes(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    """
    Search iTunes API for track/album metadata.
    
    Args:
        query: Search term (e.g. "Artist - Title")
        limit: Max results to return
        
    Returns:
        List of result dictionaries containing:
        - track_name
        - artist_name
        - album_name
        - artwork_url (high res)
        - year
        - genre
    """
    base_url = "https://itunes.apple.com/search"
    
    params = {
        "term": query,
        "media": "music",
        "entity": "song",
        "limit": limit
    }
    
    try:
        response = requests.get(base_url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        results = []
        if 'results' in data:
            for item in data['results']:
                # Get highest res artwork available (usually 100x100 is returned, but we can hack url)
                artwork_url = item.get('artworkUrl100', '')
                # Hack to get 600x600 or higher
                # iTunes URLs are like .../100x100bb.jpg
                # We can replace 100x100bb with 600x600bb
                if artwork_url:
                    artwork_url = artwork_url.replace('100x100bb', '600x600bb')
                
                result = {
                    'track_name': item.get('trackName'),
                    'artist_name': item.get('artistName'),
                    'album_name': item.get('collectionName'),
                    'artwork_url': artwork_url,
                    'year': item.get('releaseDate', '')[:4] if item.get('releaseDate') else '',
                    'genre': item.get('primaryGenreName'),
                    'preview_url': item.get('previewUrl')
                }
                results.append(result)
                
        return results
        
    except Exception as e:
        print(f"Error searching iTunes: {e}")
        return []

def download_image(url: str) -> Optional[bytes]:
    """Download image data from URL."""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.content
    except Exception as e:
        print(f"Error downloading image: {e}")
        return None
