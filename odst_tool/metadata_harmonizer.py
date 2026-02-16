"""
Metadata Harmonizer for Soundsible.
Standardizes track information from diverse sources (Spotify, YouTube, MusicBrainz, iTunes).
Ensures clean titles, consistent casing, and real album resolution.
"""

import re
import musicbrainzngs
import requests
import difflib
from typing import Dict, Any, Optional, Tuple
from pathlib import Path

# Configure MusicBrainz
musicbrainzngs.set_useragent("Soundsible", "1.0.0", "https://github.com/Arzuparreta/soundsible")

# Global Session for iTunes API
_session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=3)
_session.mount('https://', adapter)
_session.mount('http://', adapter)

class MetadataHarmonizer:
    # Collective labels that shouldn't be treated as the primary artist
    COLLECTIVES = [
        "88rising", "88 rising", "topic", "various artists", "lyrical lemonade", 
        "vevo", "records", "music", "collective", "label", "trap nation",
        "proximity", "monstercat", "ncs", "nocopyrightsounds"
    ]

    CLEANUP_REGEX = [
        r"\(Official Video\)", r"\[Official Video\]",
        r"\(Official Music Video\)", r"\[Official Music Video\]",
        r"\(Official Audio\)", r"\[Official Audio\]",
        r"\(Lyrics\)", r"\[Lyrics\]",
        r"\(HQ\)", r"\[HQ\]", r"\(HD\)", r"\[HD\]",
        r"\(4K\)", r"\[4K\]",
        r"\(prod\..*?\)", r"\[prod\..*?\]",
        r"\|.*?$", # Remove everything after a pipe
    ]

    @staticmethod
    def clean_string(text: str) -> str:
        """Standard cleaning for titles/artists."""
        if not text: return "Unknown"
        text = str(text)
        # Remove "- Topic" suffix
        cleaned = re.sub(r"\s*-\s*Topic$", "", text, flags=re.IGNORECASE)
        for pattern in MetadataHarmonizer.CLEANUP_REGEX:
            cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
        return " ".join(cleaned.split()).strip()

    @classmethod
    def harmonize(cls, raw_data: Dict[str, Any], source: str = "youtube") -> Dict[str, Any]:
        """
        The Robust Source of Truth for metadata.
        Standardizes input from ALL sources (Spotify, YouTube, Manual).
        """
        # 1. Initial Extraction
        title = str(raw_data.get('title') or raw_data.get('name') or 'Unknown Title')
        artist = str(raw_data.get('artist') or raw_data.get('uploader') or 'Unknown Artist')
        album = str(raw_data.get('album') or '')
        
        # 2. Cleaning & Generic Correction
        title = cls.clean_string(title)
        artist = cls.clean_string(artist)

        # Smart Split: If title contains "Artist - Title" and current artist is generic
        if " - " in title:
            is_generic = any(c in artist.lower() for c in cls.COLLECTIVES) or artist.lower() in ["unknown", "youtube"]
            if is_generic:
                parts = title.split(" - ", 1)
                artist = parts[0].strip()
                title = parts[1].strip()

        # 3. High-Quality Resolution (Fill-in-the-Blanks)
        is_generic_album = not album or album.lower() in [
            "youtube download", "unknown album", "manual", "manual download", "", "none"
        ]
        
        # Trigger resolution for manual searches OR if we need real album data
        if source == "manual" or is_generic_album:
            resolved = cls.resolve_missing_info(artist, title)
            if resolved:
                # SAFE MERGE: Only overwrite if it looks like the same song
                # and definitely prevent adding "Remix" if not originally there.
                orig_title_l = title.lower()
                res_title_l = resolved['title'].lower()
                
                is_remix_mismatch = "remix" in res_title_l and "remix" not in orig_title_l
                
                if not is_remix_mismatch:
                    # Update with verified info
                    artist = resolved.get('artist', artist)
                    title = resolved.get('title', title)
                    album = resolved.get('album', album)
                    raw_data['album_artist'] = resolved.get('album_artist')
                    raw_data['year'] = resolved.get('year')
                    raw_data['track_number'] = resolved.get('track_number')
                    raw_data['album_art_url'] = resolved.get('cover_url')
                    raw_data['musicbrainz_id'] = resolved.get('musicbrainz_id')
                    raw_data['isrc'] = resolved.get('isrc')
            
            # Fallback for album
            if not album: album = "Singles"

        # Final Casing
        title = title.title()
        artist = artist.title()

        return {
            'title': title,
            'artist': artist,
            'album': album,
            'album_artist': raw_data.get('album_artist'),
            'year': raw_data.get('year'),
            'track_number': raw_data.get('track_number', 1),
            'album_art_url': raw_data.get('album_art_url') or raw_data.get('thumbnail'),
            'musicbrainz_id': raw_data.get('musicbrainz_id'),
            'isrc': raw_data.get('isrc'),
            'duration_sec': raw_data.get('duration_sec', 0)
        }

    @classmethod
    def resolve_missing_info(cls, artist: str, title: str) -> Optional[Dict[str, Any]]:
        """Orchestrate search with name-swapping support."""
        # 1. Try normal order
        res = cls.fetch_from_apis(artist, title)
        if res: return res
        
        # 2. Try swapped order (ONLY if artist name doesn't look like an actual name or is generic)
        is_weak_artist = not artist or artist.lower() in ["unknown artist", "unknown", "manual", "88rising", "88 rising"] or len(artist) < 2
        
        if artist and title and (is_weak_artist or " - " in title or " - " in artist):
            res = cls.fetch_from_apis(title, artist)
            return res
        return None

    @classmethod
    def fetch_from_apis(cls, artist: str, title: str) -> Optional[Dict[str, Any]]:
        """Actually hits the external APIs."""
        # Clean artist for query
        q_artist = artist if artist.lower() not in ["unknown artist", "unknown", "manual"] else ""
        query = f"{q_artist} {title}".strip()
        
        if not query or len(query) < 3: return None
        
        try:
            params = {"term": query, "media": "music", "entity": "song", "limit": 5}
            r = _session.get("https://itunes.apple.com/search", params=params, timeout=5)
            if r.status_code == 200:
                results = r.json().get('results', [])
                for item in results:
                    res_art = item.get('artistName', '').lower()
                    res_tit = item.get('trackName', '').lower()
                    
                    # Fuzzy match words to ensure it's actually our song
                    query_words = set(re.findall(r'\w+', f"{artist} {title}".lower()))
                    query_words = query_words - {"unknown", "artist", "manual", "88rising", "88", "rising"}
                    
                    result_words = set(re.findall(r'\w+', f"{res_art} {res_tit}".lower()))
                    
                    # If most core words match, we trust it
                    intersection = query_words.intersection(result_words)
                    if len(intersection) >= min(len(query_words), 2):
                        return {
                            'artist': item.get('artistName'),
                            'title': item.get('trackName'),
                            'album': item.get('collectionName'),
                            'album_artist': item.get('collectionArtistName') or item.get('artistName'),
                            'year': int(item.get('releaseDate', '')[:4]) if item.get('releaseDate') else None,
                            'track_number': item.get('trackNumber'),
                            'cover_url': item.get('artworkUrl100', '').replace('100x100bb', '600x600bb')
                        }
        except: pass

        # 2. Try MusicBrainz Fallback
        if q_artist:
            try:
                result = musicbrainzngs.search_recordings(artist=q_artist, recording=title, limit=5)
                if result.get('recording-list'):
                    for rec in result['recording-list']:
                        if rec.get('release-list'):
                            rel = rec['release-list'][0]
                            return {
                                'artist': rec['artist-credit-phrase'],
                                'title': rec['title'],
                                'album': rel['title'],
                                'album_artist': rel.get('artist-credit-phrase'),
                                'year': int(rel['date'][:4]) if rel.get('date') else None,
                                'track_number': int(rel['medium-list'][0]['track-list'][0]['number']),
                                'cover_url': f"https://coverartarchive.org/release/{rel['id']}/front",
                                'musicbrainz_id': rec['id'],
                                'isrc': rec.get('isrc-list', [None])[0]
                            }
            except: pass
        return None

    @staticmethod
    def get_best_yt_thumbnail(video_id: str) -> str:
        return f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
