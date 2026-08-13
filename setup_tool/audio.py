"""
Audio file processing utilities.

This module handles audio metadata extraction, file hashing, and format conversion.
"""

import hashlib
from typing import Optional, Dict, Any, Tuple
from mutagen import File as MutagenFile
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
from shared.musicbrainz import (
    MUSICBRAINZ_MP4_RECORDING_TAG,
    MUSICBRAINZ_UFID_OWNER,
    MUSICBRAINZ_VORBIS_RECORDING_TAG,
    first_recording_mbid,
    normalize_recording_mbid,
)


def _number_pair(value: object) -> Tuple[Optional[int], Optional[int]]:
    text = str(value or "").strip()
    if not text:
        return None, None
    first, _, second = text.partition("/")
    number = int(first) if first.strip().isdigit() else None
    total = int(second) if second.strip().isdigit() else None
    return number, total


def _tag_bool(value: object) -> bool:
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    return str(value or "").strip().casefold() in {"1", "true", "yes"}


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
            # Note: Read in chunks for memory efficiency
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
            
            # Note: Extract basic info
            duration = int(audio.info.length) if hasattr(audio.info, 'length') else 0
            bitrate = int(audio.info.bitrate / 1000) if hasattr(audio.info, 'bitrate') else 0
            format_ext = Path(file_path).suffix.lower().lstrip('.')
            
            # Note: Extract tags based on format
            metadata = {
                'title': 'Unknown Title',
                'artist': 'Unknown Artist',
                'album': 'Unknown Album',
                'album_artist': None,
                'duration': duration,
                'bitrate': bitrate,
                'format': format_ext,
                'year': None,
                'genre': None,
                'track_number': None,
                'artists': None,
                'disc_number': None,
                'disc_total': None,
                'is_compilation': False,
                'musicbrainz_id': None,
                'cover_art': False
            }
            
            # Note: MP3 files
            if isinstance(audio, MP3):
                tags = audio.tags
                if tags:
                    metadata['title'] = str(tags.get('TIT2', 'Unknown Title'))
                    artist_frame = tags.get('TPE1')
                    artists = [str(value).strip() for value in getattr(artist_frame, 'text', []) if str(value).strip()]
                    metadata['artists'] = artists or None
                    metadata['artist'] = ' & '.join(artists) if artists else 'Unknown Artist'
                    metadata['album'] = str(tags.get('TALB', 'Unknown Album'))
                    
                    # Note: Album artist
                    if 'TPE2' in tags:
                        metadata['album_artist'] = str(tags['TPE2'])
                    
                    # Note: Year details
                    if 'TDRC' in tags:
                        metadata['year'] = int(str(tags['TDRC']).split('-')[0])
                    
                    # Note: Genre details
                    if 'TCON' in tags:
                        metadata['genre'] = str(tags['TCON'])
                    
                    # Note: Track number
                    if 'TRCK' in tags:
                        track_str = str(tags['TRCK'])
                        metadata['track_number'] = int(track_str.split('/')[0])

                    if 'TPOS' in tags:
                        metadata['disc_number'], metadata['disc_total'] = _number_pair(tags['TPOS'])

                    if 'TCMP' in tags:
                        metadata['is_compilation'] = _tag_bool(tags['TCMP'])

                    ufid = tags.get(f'UFID:{MUSICBRAINZ_UFID_OWNER}')
                    metadata['musicbrainz_id'] = normalize_recording_mbid(
                        getattr(ufid, 'data', None)
                    )
                    
                    # Note: Cover art
                    if any(frame.startswith('APIC:') for frame in tags.keys()):
                        metadata['cover_art'] = True
            
            # Note: FLAC files
            elif isinstance(audio, FLAC):
                if audio.tags:
                    metadata['title'] = audio.tags.get('title', ['Unknown Title'])[0]
                    artists = [str(value).strip() for value in audio.tags.get('artist', []) if str(value).strip()]
                    metadata['artists'] = artists or None
                    metadata['artist'] = ' & '.join(artists) if artists else 'Unknown Artist'
                    metadata['album'] = audio.tags.get('album', ['Unknown Album'])[0]
                    
                    # Note: Album artist
                    if 'albumartist' in audio.tags:
                        metadata['album_artist'] = audio.tags['albumartist'][0]
                    elif 'album artist' in audio.tags:
                        metadata['album_artist'] = audio.tags['album artist'][0]
                    
                    if 'date' in audio.tags:
                        metadata['year'] = int(audio.tags['date'][0].split('-')[0])
                    
                    if 'genre' in audio.tags:
                        metadata['genre'] = audio.tags['genre'][0]
                    
                    if 'tracknumber' in audio.tags:
                        track_str = audio.tags['tracknumber'][0]
                        metadata['track_number'] = int(track_str.split('/')[0])

                    if 'discnumber' in audio.tags:
                        metadata['disc_number'], embedded_total = _number_pair(audio.tags['discnumber'][0])
                        metadata['disc_total'] = embedded_total
                    total_discs = audio.tags.get('disctotal') or audio.tags.get('totaldiscs')
                    if total_discs:
                        _, metadata['disc_total'] = _number_pair(f"0/{total_discs[0]}")
                    if 'compilation' in audio.tags:
                        metadata['is_compilation'] = _tag_bool(audio.tags['compilation'])
                    metadata['musicbrainz_id'] = first_recording_mbid(
                        audio.tags.get(MUSICBRAINZ_VORBIS_RECORDING_TAG)
                    )
                
                # Note: Check for cover art
                if audio.pictures:
                    metadata['cover_art'] = True
            
            # Note: OGG vorbis files
            elif isinstance(audio, OggVorbis):
                if audio.tags:
                    metadata['title'] = audio.tags.get('title', ['Unknown Title'])[0]
                    artists = [str(value).strip() for value in audio.tags.get('artist', []) if str(value).strip()]
                    metadata['artists'] = artists or None
                    metadata['artist'] = ' & '.join(artists) if artists else 'Unknown Artist'
                    metadata['album'] = audio.tags.get('album', ['Unknown Album'])[0]
                    
                    if 'albumartist' in audio.tags:
                         metadata['album_artist'] = audio.tags['albumartist'][0]
                    
                    if 'date' in audio.tags:
                        metadata['year'] = int(audio.tags['date'][0])
                    
                    if 'genre' in audio.tags:
                        metadata['genre'] = audio.tags['genre'][0]
                    
                    if 'tracknumber' in audio.tags:
                        metadata['track_number'] = int(audio.tags['tracknumber'][0])
                    if 'discnumber' in audio.tags:
                        metadata['disc_number'], embedded_total = _number_pair(audio.tags['discnumber'][0])
                        metadata['disc_total'] = embedded_total
                    total_discs = audio.tags.get('disctotal') or audio.tags.get('totaldiscs')
                    if total_discs:
                        _, metadata['disc_total'] = _number_pair(f"0/{total_discs[0]}")
                    if 'compilation' in audio.tags:
                        metadata['is_compilation'] = _tag_bool(audio.tags['compilation'])
                    metadata['musicbrainz_id'] = first_recording_mbid(
                        audio.tags.get(MUSICBRAINZ_VORBIS_RECORDING_TAG)
                    )
            
            # Note: M4A (MP4/AAC) files
            elif isinstance(audio, MP4):
                if audio.tags:
                    metadata['title'] = audio.tags.get('\xa9nam', ['Unknown Title'])[0]
                    artists = [str(value).strip() for value in audio.tags.get('\xa9ART', []) if str(value).strip()]
                    metadata['artists'] = artists or None
                    metadata['artist'] = ' & '.join(artists) if artists else 'Unknown Artist'
                    metadata['album'] = audio.tags.get('\xa9alb', ['Unknown Album'])[0]
                    
                    if 'aART' in audio.tags:
                        metadata['album_artist'] = audio.tags['aART'][0]
                    
                    if '\xa9day' in audio.tags:
                        metadata['year'] = int(audio.tags['\xa9day'][0])
                    
                    if '\xa9gen' in audio.tags:
                        metadata['genre'] = audio.tags['\xa9gen'][0]
                    
                    if 'trkn' in audio.tags:
                        metadata['track_number'] = audio.tags['trkn'][0][0]
                    if 'disk' in audio.tags:
                        metadata['disc_number'] = audio.tags['disk'][0][0] or None
                        metadata['disc_total'] = audio.tags['disk'][0][1] or None
                    if 'cpil' in audio.tags:
                        metadata['is_compilation'] = bool(audio.tags['cpil'][0])
                    metadata['musicbrainz_id'] = first_recording_mbid(
                        audio.tags.get(MUSICBRAINZ_MP4_RECORDING_TAG)
                    )
                    
                    # Note: Check for cover art
                    if 'covr' in audio.tags:
                        metadata['cover_art'] = True
            
            # Note: Fallback to filename if title is still unknown
            if metadata['title'] == 'Unknown Title':
                metadata['title'] = Path(file_path).stem
            
            return metadata
            
        except Exception as e:
            print(f"Warning: Failed to extract metadata from {file_path}: {e}")
            # Note: Return minimal metadata
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
                'artists': None,
                'disc_number': None,
                'disc_total': None,
                'is_compilation': False,
                'musicbrainz_id': None,
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
            # Note: Use ffmpeg to convert
            stream = ffmpeg.input(input_path)
            stream = ffmpeg.output(
                stream,
                output_path,
                audio_bitrate=f'{bitrate}k',
                acodec='libmp3lame',
                map_metadata=0  # Note: Preserve metadata
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
        
        # Note: We now support streaming lossless formats directly
        if ext in ['.mp3', '.ogg', '.opus', '.aac', '.flac', '.wav', '.alac', '.m4a']:
            return False, f"Format supported for direct streaming ({ext})"
        
        # Note: Default don't compress unknown formats, let the user decide
        return False, "Format not recognized for auto-compression"

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
            elif ext == '.ogg' or ext == '.opus':
                audio = OggVorbis(file_path)
            elif ext == '.m4a' or ext == '.mp4':
                from mutagen.mp4 import MP4
                audio = MP4(file_path)
            else:
                return False
                
            if 'title' in tags: audio['title'] = tags['title']
            if 'artist' in tags: audio['artist'] = tags['artist']
            if 'album' in tags: audio['album'] = tags['album']
            
            # Note: Handle album artist (key varies by format)
            album_artist = tags.get('album_artist')
            if album_artist:
                if ext == '.mp3':
                    audio['albumartist'] = album_artist
                elif ext == '.m4a' or ext == '.mp4':
                    audio['\xa9ART'] = album_artist # Note: Album artist in M4A
                else:
                    # Note: FLAC/OGG standard
                    audio['albumartist'] = album_artist
            
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
            from mutagen.id3 import ID3, APIC, ID3NoHeaderError
            from mutagen.flac import FLAC, Picture
            
            path_obj = Path(file_path)
            ext = path_obj.suffix.lower()
            
            if ext == '.mp3':
                try:
                    audio = ID3(file_path)
                except ID3NoHeaderError:
                    audio = ID3()
                
                # Note: Remove existing covers
                audio.delall('APIC')
                
                with open(cover_path, 'rb') as img:
                    data = img.read()
                    
                # Note: Simple header check for mime
                mime = 'image/jpeg'
                if data.startswith(b'\x89PNG'):
                    mime = 'image/png'
                    
                audio.add(APIC(
                    encoding=3, # Note: 3 Is UTF-8
                    mime=mime, 
                    type=3, # Note: 3 Is cover(front)
                    desc=u'Cover',
                    data=data
                ))
                audio.save(file_path, v2_version=3)
                return True
                
            elif ext == '.flac':
                audio = FLAC(file_path)
                audio.clear_pictures()
                
                image = Picture()
                image.type = 3
                
                with open(cover_path, 'rb') as f:
                    data = f.read()
                    
                image.mime = u"image/jpeg"
                if data.startswith(b'\x89PNG'):
                    image.mime = u"image/png"
                    
                image.desc = u"Cover"
                image.data = data
                
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
                    # Note: Look for APIC frames (album pictures)
                    for key in audio.keys():
                        if key.startswith('APIC:'):
                            return audio[key].data
                except Exception:
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
