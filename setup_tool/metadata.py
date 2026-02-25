"""
Metadata fetching utilities using iTunes Search API.
"""

import requests
import urllib.parse
import time
from typing import List, Dict, Optional, Any

_session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=3)
_session.mount('https://', adapter)
_session.mount('http://', adapter)

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
        retries = 3
        for attempt in range(retries):
            response = _session.get(base_url, params=params, timeout=10)
            
            if response.status_code == 429:
                wait = 2 ** (attempt + 1)
                time.sleep(wait)
                continue
                
            response.raise_for_status()
            break
        else:
            return []
            
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

# YouTube thumbnail hosts often block default User-Agent; use browser-like header
_YT_IMAGE_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0"
)

def download_image(url: str) -> Optional[bytes]:
    """Download image data from URL. Uses browser User-Agent for YouTube thumbnail hosts."""
    try:
        parsed = urllib.parse.urlparse(url or "")
        host = (parsed.netloc or "").lower()
        headers = None
        if "ytimg.com" in host or "youtube.com" in host or "img.youtube" in host:
            headers = {"User-Agent": _YT_IMAGE_USER_AGENT}
        response = _session.get(url, timeout=10, headers=headers)
        response.raise_for_status()
        return response.content
    except Exception as e:
        print(f"Error downloading image: {e}")
        return None
