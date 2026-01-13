"""
Audio file processing utilities.

This module handles audio metadata extraction, file hashing, and format conversion.
"""

import hashlib
import os
from typing import Optional, Dict, Any, Tuple
from mutagen import File as MutagenFile
from mutagen.easyid3 import EasyID3
from mutagen.mp3 import MP3
from mutagen.flac import FLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.mp4 import MP4
import ffmpeg
from pathlib import Path

from shared.constants import (
    SUPPORTED_AUDIO_FORMATS,
    DEFAULT_MP3_BITRATE,
    DEFAULT_OGG_QUALITY
)


class AudioProcessor:
    """Handler for audio file operations."""
    
    @staticmethod
    def is_supported_format(file_path: str) -> bool:
        """
        Check if file format is supported.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            True if format is supported
        """
        ext = Path(file_path).suffix.lower()
        return ext in SUPPORTED_AUDIO_FORMATS
    
    @staticmethod
    def calculate_hash(file_path: str) -> str:
        """
        Calculate SHA256 hash of file for deduplication.
        
        Args:
            file_path: Path to file
            
        Returns:
            Hexadecimal SHA256 hash string
        """
        sha256 = hashlib.sha256()
        
        with open(file_path, 'rb') as f:
            # Read in chunks for memory efficiency
            for chunk in iter(lambda: f.read(8192), b''):
                sha256.update(chunk)
        
        return sha256.hexdigest()
    
    @staticmethod
    def extract_metadata(file_path: str) -> Dict[str, Any]:
        """
        Extract metadata from audio file using mutagen.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            Dictionary with metadata:
                - title: Song title
                - artist: Artist name
                - album: Album name
                - duration: Duration in seconds
                - bitrate: Bitrate in kbps
                - format: File format
                - year: Release year (optional)
                - genre: Genre (optional)
                - track_number: Track number (optional)
                - cover_art: Boolean indicating if cover art is present
        """
        try:
            audio = MutagenFile(file_path, easy=False)
            if audio is None:
                raise ValueError(f"Failed to open audio file: {file_path}")
            
            # Extract basic info
            duration = int(audio.info.length) if hasattr(audio.info, 'length') else 0
            bitrate = int(audio.info.bitrate / 1000) if hasattr(audio.info, 'bitrate') else 0
            format_ext = Path(file_path).suffix.lower().lstrip('.')
            
            # Extract tags based on format
            metadata = {
                'title': 'Unknown Title',
                'artist': 'Unknown Artist',
                'album': 'Unknown Album',
                'duration': duration,
                'bitrate': bitrate,
                'format': format_ext,
                'year': None,
                'genre': None,
                'track_number': None,
                'cover_art': False
            }
            
            # MP3 files
            if isinstance(audio, MP3):
                tags = audio.tags
                if tags:
                    metadata['title'] = str(tags.get('TIT2', 'Unknown Title'))
                    metadata['artist'] = str(tags.get('TPE1', 'Unknown Artist'))
                    metadata['album'] = str(tags.get('TALB', 'Unknown Album'))
                    
                    # Year
                    if 'TDRC' in tags:
                        metadata['year'] = int(str(tags['TDRC']).split('-')[0])
                    
                    # Genre
                    if 'TCON' in tags:
                        metadata['genre'] = str(tags['TCON'])
                    
                    # Track number
                    if 'TRCK' in tags:
                        track_str = str(tags['TRCK'])
                        metadata['track_number'] = int(track_str.split('/')[0])
                    
                    # Cover art
                    if any(frame.startswith('APIC:') for frame in tags.keys()):
                        metadata['cover_art'] = True
            
            # FLAC files
            elif isinstance(audio, FLAC):
                if audio.tags:
                    metadata['title'] = audio.tags.get('title', ['Unknown Title'])[0]
                    metadata['artist'] = audio.tags.get('artist', ['Unknown Artist'])[0]
                    metadata['album'] = audio.tags.get('album', ['Unknown Album'])[0]
                    
                    if 'date' in audio.tags:
                        metadata['year'] = int(audio.tags['date'][0].split('-')[0])
                    
                    if 'genre' in audio.tags:
                        metadata['genre'] = audio.tags['genre'][0]
                    
                    if 'tracknumber' in audio.tags:
                        track_str = audio.tags['tracknumber'][0]
                        metadata['track_number'] = int(track_str.split('/')[0])
                
                # Check for cover art
                if audio.pictures:
                    metadata['cover_art'] = True
            
            # OGG Vorbis files
            elif isinstance(audio, OggVorbis):
                if audio.tags:
                    metadata['title'] = audio.tags.get('title', ['Unknown Title'])[0]
                    metadata['artist'] = audio.tags.get('artist', ['Unknown Artist'])[0]
                    metadata['album'] = audio.tags.get('album', ['Unknown Album'])[0]
                    
                    if 'date' in audio.tags:
                        metadata['year'] = int(audio.tags['date'][0])
                    
                    if 'genre' in audio.tags:
                        metadata['genre'] = audio.tags['genre'][0]
                    
                    if 'tracknumber' in audio.tags:
                        metadata['track_number'] = int(audio.tags['tracknumber'][0])
            
            # M4A (MP4/AAC) files
            elif isinstance(audio, MP4):
                if audio.tags:
                    metadata['title'] = audio.tags.get('\xa9nam', ['Unknown Title'])[0]
                    metadata['artist'] = audio.tags.get('\xa9ART', ['Unknown Artist'])[0]
                    metadata['album'] = audio.tags.get('\xa9alb', ['Unknown Album'])[0]
                    
                    if '\xa9day' in audio.tags:
                        metadata['year'] = int(audio.tags['\xa9day'][0])
                    
                    if '\xa9gen' in audio.tags:
                        metadata['genre'] = audio.tags['\xa9gen'][0]
                    
                    if 'trkn' in audio.tags:
                        metadata['track_number'] = audio.tags['trkn'][0][0]
                    
                    # Check for cover art
                    if 'covr' in audio.tags:
                        metadata['cover_art'] = True
            
            # Fallback to filename if title is still unknown
            if metadata['title'] == 'Unknown Title':
                metadata['title'] = Path(file_path).stem
            
            return metadata
            
        except Exception as e:
            print(f"Warning: Failed to extract metadata from {file_path}: {e}")
            # Return minimal metadata
            return {
                'title': Path(file_path).stem,
                'artist': 'Unknown Artist',
                'album': 'Unknown Album',
                'duration': 0,
                'bitrate': 0,
                'format': Path(file_path).suffix.lower().lstrip('.'),
                'year': None,
                'genre': None,
                'track_number': None,
                'cover_art': False
            }
    
    @staticmethod
    def compress_to_mp3(input_path: str, output_path: str, 
                       bitrate: int = DEFAULT_MP3_BITRATE) -> bool:
        """
        Convert audio file to MP3 format.
        
        Args:
            input_path: Source audio file
            output_path: Destination MP3 file
            bitrate: Target bitrate in kbps (default 320)
            
        Returns:
            True if conversion successful
        """
        try:
            # Use ffmpeg to convert
            stream = ffmpeg.input(input_path)
            stream = ffmpeg.output(
                stream,
                output_path,
                audio_bitrate=f'{bitrate}k',
                acodec='libmp3lame',
                map_metadata=0  # Preserve metadata
            )
            ffmpeg.run(stream, overwrite_output=True, quiet=True)
            return True
            
        except ffmpeg.Error as e:
            print(f"FFmpeg conversion error: {e}")
            return False
    
    @staticmethod
    def compress_to_ogg(input_path: str, output_path: str,
                       quality: int = DEFAULT_OGG_QUALITY) -> bool:
        """
        Convert audio file to OGG Vorbis format.
        
        Args:
            input_path: Source audio file
            output_path: Destination OGG file
            quality: VBR quality level 0-10 (default 8)
            
        Returns:
            True if conversion successful
        """
        try:
            stream = ffmpeg.input(input_path)
            stream = ffmpeg.output(
                stream,
                output_path,
                acodec='libvorbis',
                audio_quality=quality,
                map_metadata=0
            )
            ffmpeg.run(stream, overwrite_output=True, quiet=True)
            return True
            
        except ffmpeg.Error as e:
            print(f"FFmpeg conversion error: {e}")
            return False
    
    @staticmethod
    def should_compress(file_path: str) -> Tuple[bool, str]:
        """
        Determine if a file should be compressed.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            Tuple of (should_compress: bool, reason: str)
        """
        ext = Path(file_path).suffix.lower()
        
        # Already compressed formats
        if ext in ['.mp3', '.ogg', '.opus', '.aac']:
            return False, f"Already compressed ({ext})"
        
        # Lossless formats that should be compressed for streaming
        if ext in ['.flac', '.wav', '.alac']:
            return True, f"Lossless format ({ext}) - compressing for streaming"
        
        # Default: don't compress unknown formats
        return False, "Format not recognized for compression"

    @staticmethod
    def update_tags(file_path: str, tags: Dict[str, str]) -> bool:
        """
        Update audio file tags.
        """
        try:
            import mutagen
            from mutagen.easyid3 import EasyID3
            from mutagen.flac import FLAC
            from mutagen.oggvorbis import OggVorbis
            from mutagen.mp3 import MP3
            
            path_obj = Path(file_path)
            ext = path_obj.suffix.lower()
            
            if ext == '.mp3':
                try:
                    audio = EasyID3(file_path)
                except mutagen.id3.ID3NoHeaderError:
                    audio = EasyID3()
                    audio.save(file_path)
                    audio = EasyID3(file_path)
            elif ext == '.flac':
                audio = FLAC(file_path)
            elif ext == '.ogg':
                audio = OggVorbis(file_path)
            else:
                return False
                
            if 'title' in tags: audio['title'] = tags['title']
            if 'artist' in tags: audio['artist'] = tags['artist']
            if 'album' in tags: audio['album'] = tags['album']
            
            audio.save()
            return True
            
        except Exception as e:
            print(f"Error updating tags: {e}")
            return False

    @staticmethod
    def embed_artwork(file_path: str, cover_path: str) -> bool:
        """
        Embed album art into the audio file.
        Supports MP3 (ID3 APIC) and FLAC (Picture).
        """
        try:
            import mutagen
            from mutagen.id3 import ID3, APIC, ID3NoHeaderError
            from mutagen.flac import FLAC, Picture
            from mutagen.mp3 import MP3
            
            path_obj = Path(file_path)
            ext = path_obj.suffix.lower()
            
            if ext == '.mp3':
                try:
                    audio = ID3(file_path)
                except ID3NoHeaderError:
                    audio = ID3()
                
                with open(cover_path, 'rb') as img:
                    audio.add(APIC(
                        encoding=3, # 3 is UTF-8
                        mime='image/jpeg', # Assuming JPEG from iTunes
                        type=3, # 3 is cover(front)
                        desc=u'Cover',
                        data=img.read()
                    ))
                audio.save(file_path)
                return True
                
            elif ext == '.flac':
                audio = FLAC(file_path)
                image = Picture()
                image.type = 3
                image.mime = u"image/jpeg"
                image.desc = u"Cover"
                with open(cover_path, 'rb') as f:
                    image.data = f.read()
                audio.add_picture(image)
                audio.save()
                return True
                
            return False
            
        except Exception as e:
            print(f"Error embedding artwork: {e}")
            return False

    @staticmethod
    def extract_cover_art(file_path: str) -> Optional[bytes]:
        """
        Extract embedded album art from audio file.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            Image data as bytes, or None if no cover art found
        """
        try:
            from mutagen.id3 import ID3
            from mutagen.flac import FLAC
            from mutagen.mp4 import MP4
            
            path_obj = Path(file_path)
            ext = path_obj.suffix.lower()
            
            if ext == '.mp3':
                try:
                    audio = ID3(file_path)
                    # Look for APIC frames (album pictures)
                    for key in audio.keys():
                        if key.startswith('APIC:'):
                            return audio[key].data
                except:
                    pass
                    
            elif ext == '.flac':
                audio = FLAC(file_path)
                if audio.pictures:
                    return audio.pictures[0].data
                    
            elif ext == '.m4a' or ext == '.mp4':
                audio = MP4(file_path)
                if 'covr' in audio.tags:
                    return bytes(audio.tags['covr'][0])
            
            return None
            
        except Exception as e:
            print(f"Error extracting cover art: {e}")
            return None
