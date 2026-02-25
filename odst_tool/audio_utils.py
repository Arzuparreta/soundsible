import hashlib
import os
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import mutagen
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TDRC, TCON, APIC, COMM, USLT
from mutagen.mp3 import MP3
from mutagen.flac import FLAC, Picture

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
        Supports MP3 and FLAC. Uses download_image for cover so YouTube thumbnails work (User-Agent).
        """
        cover_data = None
        if cover_url:
            try:
                from setup_tool.metadata import download_image
                cover_data = download_image(cover_url)
            except Exception:
                pass
        path = Path(file_path)
        if path.suffix.lower() == '.mp3':
            AudioProcessor._embed_mp3(str(path), metadata, cover_data)
        elif path.suffix.lower() == '.flac':
            AudioProcessor._embed_flac(str(path), metadata, cover_data)

    @staticmethod
    def _embed_flac(file_path: str, metadata: Dict[str, Any], cover_data: Optional[bytes]):
        """Embed metadata into FLAC file. cover_data is image bytes (from download_image)."""
        try:
            audio = FLAC(file_path)
            
            # Basic tags
            if metadata.get('title'):
                audio['title'] = metadata['title']
            if metadata.get('artist'):
                audio['artist'] = metadata['artist']
            if metadata.get('album'):
                audio['album'] = metadata['album']
            if metadata.get('album_artist'):
                audio['albumartist'] = metadata['album_artist']
            
            year = metadata.get('year') or (metadata['release_date'][:4] if metadata.get('release_date') else None)
            if year:
                audio['date'] = str(year)
                
            if metadata.get('track_number'):
                audio['tracknumber'] = str(metadata['track_number'])
            
            if metadata.get('isrc'):
                audio['isrc'] = metadata['isrc']
            if metadata.get('metadata_source_authority'):
                audio['metadata_source_authority'] = str(metadata['metadata_source_authority'])
            if metadata.get('metadata_confidence') is not None:
                audio['metadata_confidence'] = str(metadata['metadata_confidence'])
            if metadata.get('metadata_decision_id'):
                audio['metadata_decision_id'] = str(metadata['metadata_decision_id'])
            if metadata.get('metadata_state'):
                audio['metadata_state'] = str(metadata['metadata_state'])
            if metadata.get('metadata_query_fingerprint'):
                audio['metadata_query_fingerprint'] = str(metadata['metadata_query_fingerprint'])
                
            # Cover Art
            if cover_data:
                try:
                    image = Picture()
                    image.type = 3
                    image.mime = 'image/jpeg'
                    image.desc = u'Cover'
                    image.data = cover_data
                    audio.add_picture(image)
                except Exception as e:
                    print(f"Failed to embed FLAC cover art: {e}")
            
            audio.save()
        except Exception as e:
            print(f"Error embedding FLAC metadata: {e}")

    @staticmethod
    def _embed_mp3(file_path: str, metadata: Dict[str, Any], cover_data: Optional[bytes]):
        """Embed metadata into MP3 file. cover_data is image bytes (from download_image)."""
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
            
        # Album Artist
        if metadata.get('album_artist'):
            from mutagen.id3 import TPE2
            audio.tags.add(TPE2(encoding=3, text=metadata['album_artist']))
            
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
        if metadata.get('metadata_source_authority'):
            from mutagen.id3 import TXXX
            audio.tags.add(TXXX(encoding=3, desc='METADATA_SOURCE_AUTHORITY', text=str(metadata['metadata_source_authority'])))
        if metadata.get('metadata_confidence') is not None:
            from mutagen.id3 import TXXX
            audio.tags.add(TXXX(encoding=3, desc='METADATA_CONFIDENCE', text=str(metadata['metadata_confidence'])))
        if metadata.get('metadata_decision_id'):
            from mutagen.id3 import TXXX
            audio.tags.add(TXXX(encoding=3, desc='METADATA_DECISION_ID', text=str(metadata['metadata_decision_id'])))
        if metadata.get('metadata_state'):
            from mutagen.id3 import TXXX
            audio.tags.add(TXXX(encoding=3, desc='METADATA_STATE', text=str(metadata['metadata_state'])))
        if metadata.get('metadata_query_fingerprint'):
            from mutagen.id3 import TXXX
            audio.tags.add(TXXX(encoding=3, desc='METADATA_QUERY_FINGERPRINT', text=str(metadata['metadata_query_fingerprint'])))
            
        # Cover Art
        if cover_data:
            try:
                audio.tags.add(
                    APIC(
                        encoding=3, # 3 is UTF-8
                        mime='image/jpeg', # assume jpeg usually
                        type=3, # 3 is for the cover image
                        desc=u'Cover',
                        data=cover_data
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
