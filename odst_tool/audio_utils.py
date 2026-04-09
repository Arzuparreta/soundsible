import hashlib
import os
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import requests
import mutagen
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TDRC, TCON, APIC, COMM, USLT
from mutagen.mp3 import MP3
from mutagen.flac import FLAC, Picture

_session = requests.Session()
_YT_IMAGE_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0"
)


def download_image(url: str) -> Optional[bytes]:
    """Download image bytes. Uses browser UA for YouTube thumbnail hosts."""
    if not url:
        return None
    headers = None
    host = ""
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).netloc or "").lower()
    except Exception:
        host = ""
    if "ytimg.com" in host or "youtube.com" in host or "img.youtube" in host:
        headers = {"User-Agent": _YT_IMAGE_USER_AGENT}
    try:
        response = _session.get(url, timeout=10, headers=headers)
        response.raise_for_status()
        return response.content
    except Exception:
        return None

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
            
            # Note: Basic tags
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

            # Note: Cover art
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

        # Note: Title details
        if metadata.get('title'):
            audio.tags.add(TIT2(encoding=3, text=metadata['title']))
        
        # Note: Artist details
        if metadata.get('artist'):
            audio.tags.add(TPE1(encoding=3, text=metadata['artist']))
            
        # Note: Album details
        if metadata.get('album'):
            audio.tags.add(TALB(encoding=3, text=metadata['album']))
            
        # Note: Album artist
        if metadata.get('album_artist'):
            from mutagen.id3 import TPE2
            audio.tags.add(TPE2(encoding=3, text=metadata['album_artist']))
            
        # Note: Year details
        year = metadata.get('year') or (metadata['release_date'][:4] if metadata.get('release_date') else None)
        if year:
            audio.tags.add(TDRC(encoding=3, text=str(year)))
            
        # Note: Track number
        if metadata.get('track_number'):
            from mutagen.id3 import TRCK
            audio.tags.add(TRCK(encoding=3, text=str(metadata['track_number'])))
            
        # Note: ISRC details
        if metadata.get('isrc'):
            from mutagen.id3 import TXXX
            audio.tags.add(TXXX(encoding=3, desc='ISRC', text=metadata['isrc']))

        # Note: Cover art
        if cover_data:
            try:
                audio.tags.add(
                    APIC(
                        encoding=3, # Note: 3 Is UTF-8
                        mime='image/jpeg', # Note: Assume jpeg usually
                        type=3, # Note: 3 Is for the cover image
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
                # Note: Bitrate might not be available for all formats (e.g. lossless)
                if hasattr(audio.info, 'bitrate') and audio.info.bitrate:
                    bitrate = int(audio.info.bitrate / 1000)
                else:
                    # Note: For lossless, we can calculate 'nominal' bitrate or leave as 0
                    # Note: For now, let's try to estimate if possible or just use 0 (which means 'variable/highest')
                    bitrate = 0
        except Exception as e:
            print(f"Error reading audio details: {e}")
            
        return duration, bitrate, size

    @staticmethod
    def get_metadata_from_file(file_path: str) -> Dict[str, Any]:
        """Read embedded metadata from an audio file (MP3 or FLAC). Returns dict with title, artist, album, etc."""
        path = Path(file_path)
        out = {'title': '', 'artist': '', 'album': '', 'album_artist': None, 'year': None, 'track_number': None}
        try:
            if path.suffix.lower() == '.flac':
                audio = FLAC(file_path)
                out['title'] = (audio.get('title') or [''])[0]
                out['artist'] = (audio.get('artist') or [''])[0]
                out['album'] = (audio.get('album') or [''])[0]
                out['album_artist'] = (audio.get('albumartist') or [None])[0]
                date = (audio.get('date') or [''])[0]
                out['year'] = int(date[:4]) if date and date[:4].isdigit() else None
                tn = (audio.get('tracknumber') or [''])[0]
                out['track_number'] = int(tn) if tn and str(tn).isdigit() else None
            elif path.suffix.lower() == '.mp3':
                audio = MP3(file_path)
                if audio.tags:
                    def _txt(f):
                        return f.text[0] if f and getattr(f, 'text', None) else ''
                    def _txt_opt(f):
                        return f.text[0] if f and getattr(f, 'text', None) else None
                    out['title'] = _txt(audio.tags.get('TIT2')) or ''
                    out['artist'] = _txt(audio.tags.get('TPE1')) or ''
                    out['album'] = _txt(audio.tags.get('TALB')) or ''
                    out['album_artist'] = _txt_opt(audio.tags.get('TPE2'))
                    tdrc = audio.tags.get('TDRC')
                    if tdrc and getattr(tdrc, 'text', None):
                        s = str(tdrc.text[0])[:4]
                        out['year'] = int(s) if s.isdigit() else None
                    trck = audio.tags.get('TRCK')
                    if trck and getattr(trck, 'text', None):
                        tn = str(trck.text[0]).split('/')[0].strip()
                        out['track_number'] = int(tn) if tn.isdigit() else None
        except Exception as e:
            print(f"Error reading metadata from file: {e}")
        return out
