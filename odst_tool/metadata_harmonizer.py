"""
Metadata Harmonizer for Soundsible.
Standardizes track information from diverse sources (Spotify, YouTube, MusicBrainz).
Ensures clean titles, consistent casing, and real album resolution.
"""

import re
import musicbrainzngs
from typing import Dict, Any, Optional, Tuple
from pathlib import Path

# Configure MusicBrainz
musicbrainzngs.set_useragent("Soundsible", "1.0.0", "https://github.com/Arzuparreta/soundsible")

class MetadataHarmonizer:
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
        """Remove common junk from YouTube titles."""
        if not text: return "Unknown"
        
        cleaned = text
        for pattern in MetadataHarmonizer.CLEANUP_REGEX:
            cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
        
        # Remove multiple spaces and strip
        cleaned = " ".join(cleaned.split()).strip()
        
        # Title Casing
        return cleaned.title()

    @classmethod
    def harmonize(cls, raw_data: Dict[str, Any], source: str = "youtube") -> Dict[str, Any]:
        """
        Main logic gate for all incoming metadata.
        Returns a standardized dict.
        """
        # Start with what we have
        raw_title = raw_data.get('title', 'Unknown Title')
        raw_artist = raw_data.get('artist', 'Unknown Artist')
        
        # Smart Split: If artist is unknown/generic but title has a separator
        separators = [" - ", " | "]
        for sep in separators:
            if (raw_artist.lower() in ["unknown artist", "unknown", "youtube"] or not raw_artist) and sep in raw_title:
                parts = raw_title.split(sep, 1)
                raw_artist = parts[0]
                raw_title = parts[1]
                break

        title = cls.clean_string(raw_title)
        artist = cls.clean_string(raw_artist)
        album = raw_data.get('album', '')
        year = raw_data.get('year') or raw_data.get('release_year')
        track_number = raw_data.get('track_number', 1)
        cover_url = raw_data.get('album_art_url') or raw_data.get('thumbnail')
        mbid = raw_data.get('musicbrainz_id')
        isrc = raw_data.get('isrc')

        # Logic: If it's a plain YouTube download with generic album
        if source == "youtube" and (not album or album.lower() in ["youtube download", "unknown album", ""]):
            # Try to resolve via MusicBrainz
            mb_info = cls.resolve_via_musicbrainz(artist, title)
            if mb_info:
                artist = mb_info.get('artist', artist)
                title = mb_info.get('title', title)
                album = mb_info.get('album', album)
                year = mb_info.get('year', year)
                track_number = mb_info.get('track_number', track_number)
                mbid = mb_info.get('musicbrainz_id', mbid)
                isrc = mb_info.get('isrc', isrc)
                if mb_info.get('cover_url'):
                    cover_url = mb_info['cover_url']
            else:
                # Fallback grouping
                if year:
                    album = f"Singles [{year}]"
                else:
                    album = "Singles"

        # Ensure we have a year if possible
        if not year and raw_data.get('release_date'):
            try:
                # Handle YYYYMMDD or YYYY-MM-DD
                rd = str(raw_data['release_date'])
                year = int(rd[:4])
            except: pass

        return {
            'title': title,
            'artist': artist,
            'album': album,
            'year': year,
            'track_number': track_number,
            'album_art_url': cover_url,
            'musicbrainz_id': mbid,
            'isrc': isrc,
            'duration_sec': raw_data.get('duration_sec', 0)
        }

    @staticmethod
    def resolve_via_musicbrainz(artist: str, title: str) -> Optional[Dict[str, Any]]:
        """Attempt to find real album info via MusicBrainz."""
        try:
            # Search for the recording
            result = musicbrainzngs.search_recordings(artist=artist, recording=title, limit=5)
            
            if not result.get('recording-list'):
                return None
                
            # Pick the best match (simplified: first one with a release)
            for rec in result['recording-list']:
                if rec.get('release-list'):
                    release = rec['release-list'][0]
                    
                    # Try to get high-res cover via MB Cover Art Archive
                    release_id = release['id']
                    cover_url = f"https://coverartarchive.org/release/{release_id}/front"
                    
                    # Try to find ISRC if available
                    isrc_list = rec.get('isrc-list', [])
                    found_isrc = isrc_list[0] if isrc_list else None
                    
                    return {
                        'artist': rec['artist-credit-phrase'],
                        'title': rec['title'],
                        'album': release['title'],
                        'year': int(release['date'][:4]) if release.get('date') else None,
                        'track_number': int(rec['release-list'][0]['medium-list'][0]['track-list'][0]['number']),
                        'cover_url': cover_url,
                        'musicbrainz_id': rec['id'],
                        'isrc': found_isrc
                    }
        except Exception:
            pass # Silent failure for external APIs
        return None

    @staticmethod
    def get_best_yt_thumbnail(video_id: str) -> str:
        """YouTube provides multiple thumbnail qualities. We want maxresdefault."""
        return f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
