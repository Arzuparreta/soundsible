import hashlib
import os
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import mutagen
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TDRC, TCON, APIC, COMM, USLT
from mutagen.mp3 import MP3
from mutagen.flac import FLAC, Picture
import requests

class AudioProcessor:
    """Utilities for audio file processing."""

    @staticmethod
    def calculate_hash(file_path: str, chunk_size: int = 8192) -> str:
        """Calculate SHA256 hash of a file."""
        sha256 = hashlib.sha256()
        with open(file_path, 'rb') as f:
            while chunk := f.read(chunk_size):
                sha256.update(chunk)
        return sha256.hexdigest()

    @staticmethod
    def embed_metadata(file_path: str, metadata: Dict[str, Any], cover_url: Optional[str] = None):
        """
        Embed ID3 tags/metadata into the file.
        Supports MP3 and FLAC.
        """
        path = Path(file_path)
        if path.suffix.lower() == '.mp3':
            AudioProcessor._embed_mp3(str(path), metadata, cover_url)
        elif path.suffix.lower() == '.flac':
            AudioProcessor._embed_flac(str(path), metadata, cover_url)

    @staticmethod
    def _embed_flac(file_path: str, metadata: Dict[str, Any], cover_url: Optional[str]):
        """Embed metadata into FLAC file."""
        try:
            audio = FLAC(file_path)
            
            # Basic tags
            if metadata.get('title'):
                audio['title'] = metadata['title']
            if metadata.get('artist'):
                audio['artist'] = metadata['artist']
            if metadata.get('album'):
                audio['album'] = metadata['album']
            
            year = metadata.get('year') or (metadata['release_date'][:4] if metadata.get('release_date') else None)
            if year:
                audio['date'] = str(year)
                
            if metadata.get('track_number'):
                audio['tracknumber'] = str(metadata['track_number'])
            
            if metadata.get('isrc'):
                audio['isrc'] = metadata['isrc']
                
            # Cover Art
            if cover_url:
                try:
                    response = requests.get(cover_url, timeout=10)
                    if response.status_code == 200:
                        image = Picture()
                        image.type = 3
                        image.mime = 'image/jpeg'
                        image.desc = u'Cover'
                        image.data = response.content
                        audio.add_picture(image)
                except Exception as e:
                    print(f"Failed to embed FLAC cover art: {e}")
            
            audio.save()
        except Exception as e:
            print(f"Error embedding FLAC metadata: {e}")

    @staticmethod
    def _embed_mp3(file_path: str, metadata: Dict[str, Any], cover_url: Optional[str]):
        """Embed metadata into MP3 file."""
        try:
            audio = MP3(file_path, ID3=ID3)
        except mutagen.MutagenError:
            audio = MP3(file_path)
            audio.add_tags()

        # Title
        if metadata.get('title'):
            audio.tags.add(TIT2(encoding=3, text=metadata['title']))
        
        # Artist
        if metadata.get('artist'):
            audio.tags.add(TPE1(encoding=3, text=metadata['artist']))
            
        # Album
        if metadata.get('album'):
            audio.tags.add(TALB(encoding=3, text=metadata['album']))
            
        # Year
        year = metadata.get('year') or (metadata['release_date'][:4] if metadata.get('release_date') else None)
        if year:
            audio.tags.add(TDRC(encoding=3, text=str(year)))
            
        # Track Number
        if metadata.get('track_number'):
            from mutagen.id3 import TRCK
            audio.tags.add(TRCK(encoding=3, text=str(metadata['track_number'])))
            
        # ISRC
        if metadata.get('isrc'):
            # Custom TXXX frame for ISRC
            from mutagen.id3 import TXXX
            audio.tags.add(TXXX(encoding=3, desc='ISRC', text=metadata['isrc']))
            
        # Cover Art
        if cover_url:
            try:
                response = requests.get(cover_url, timeout=10)
                if response.status_code == 200:
                    audio.tags.add(
                        APIC(
                            encoding=3, # 3 is UTF-8
                            mime='image/jpeg', # assume jpeg usually
                            type=3, # 3 is for the cover image
                            desc=u'Cover',
                            data=response.content
                        )
                    )
            except Exception as e:
                print(f"Failed to embed cover art: {e}")

        audio.save()

    @staticmethod
    def get_audio_details(file_path: str) -> Tuple[int, int, int]:
        """
        Get duration, bitrate, and size of audio file.
        Returns: (duration_sec, bitrate_kbps, size_bytes)
        """
        size = os.path.getsize(file_path)
        duration = 0
        bitrate = 0
        
        try:
            audio = mutagen.File(file_path)
            if audio is not None:
                duration = int(audio.info.length)
                # Bitrate might not be available for all formats (e.g. lossless)
                if hasattr(audio.info, 'bitrate') and audio.info.bitrate:
                    bitrate = int(audio.info.bitrate / 1000)
                else:
                    # For lossless, we can calculate 'nominal' bitrate or leave as 0
                    # For now, let's try to estimate if possible or just use 0 (which means 'variable/highest')
                    bitrate = 0
        except Exception as e:
            print(f"Error reading audio details: {e}")
            
        return duration, bitrate, size
