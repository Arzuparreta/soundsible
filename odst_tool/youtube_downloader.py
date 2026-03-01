import os
import shutil
import time
import re
import uuid
from pathlib import Path
from typing import Optional, Dict, Any, List, Iterator
from urllib.parse import quote
import yt_dlp
import requests
from .config import (
    DEFAULT_OUTPUT_DIR,
    SEARCH_STRATEGY_PRIMARY,
    SEARCH_STRATEGY_FALLBACK,
    DURATION_TOLERANCE_SEC,
    DEFAULT_BITRATE,
    DEFAULT_QUALITY,
    QUALITY_PROFILES,
    TRACKS_DIR,
    MATCH_THRESHOLD_TITLE,
    FORBIDDEN_KEYWORDS
)
import difflib
from .audio_utils import AudioProcessor
from .models import Track

def _yt_thumbnail_url(video_id: Optional[str]) -> Optional[str]:
    """YouTube thumbnail URL (mqdefault). Returns None if video_id is falsy."""
    if not video_id:
        return None
    return f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg"


def _is_valid_youtube_video_id(video_id: Optional[str]) -> bool:
    """True if this looks like a YouTube video id (11 chars, alphanumeric + -_). Filters RDAM*, channel IDs, etc."""
    if not video_id or not isinstance(video_id, str):
        return False
    s = video_id.strip()
    if len(s) != 11:
        return False
    return all(c.isalnum() or c in "-_" for c in s)

# Prefer audio-only; fallbacks for YouTube format changes.
YDL_FORMAT_AUDIO = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best/worstaudio"


class YouTubeDownloader:
    """Handles searching and downloading from YouTube."""
    
    def __init__(self, output_dir: Path = DEFAULT_OUTPUT_DIR, cookie_browser: Optional[str] = None, cookie_file: Optional[str] = None, quality: str = DEFAULT_QUALITY):
        self.output_dir = output_dir
        self.tracks_dir = output_dir / TRACKS_DIR
        self.tracks_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir = output_dir / "temp"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.cookie_browser = cookie_browser
        self.cookie_file = cookie_file
        self.quality = quality
        
        # Auto-detect cookies.txt if no cookie source provided
        if not self.cookie_file and not self.cookie_browser:
            try:
                from shared.constants import DEFAULT_CONFIG_DIR
                potential_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "cookies.txt"
                if potential_path.exists():
                    self.cookie_file = str(potential_path)
                    # print(f"DEBUG: Auto-detected cookies at {self.cookie_file}")
            except ImportError:
                pass

    def process_track(self, metadata: Dict[str, Any], source: str = "spotify") -> Optional[Track]:
        """
        Full workflow for a single track: Search -> Download -> Process -> Return Track.
        """
        metadata = dict(metadata or {})
        metadata.setdefault("title", "Unknown Title")
        metadata.setdefault("artist", "Unknown Artist")
        metadata.setdefault("album", "")
        clean_metadata = metadata

        # Search for video
        video_info = self._search_youtube(clean_metadata)
        
        if not video_info:
            return None
            
        # Rate Limit Protection: Sleep random amount
        import time
        import random
        from .config import DOWNLOAD_DELAY_RANGE
        time.sleep(random.uniform(*DOWNLOAD_DELAY_RANGE))
            
        # 3. Download audio
        url = video_info.get('webpage_url') or video_info.get('url')
        temp_file = self._download_audio(url)
        
        if not temp_file:
            return None
            
        try:
            # 4. Process file (Hash, Metadata, Move)
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            
            # Embed metadata (using clean version)
            AudioProcessor.embed_metadata(
                str(temp_file), 
                clean_metadata, 
                clean_metadata.get('album_art_url')
            )
            
            # Verify audio details
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            
            # Move to final location (renaming to hash)
            shutil.move(str(temp_file), str(final_path))
            
            # 5. Create Track Object
            track = Track(
                id=file_hash,
                title=clean_metadata['title'],
                artist=clean_metadata['artist'],
                album=clean_metadata['album'],
                album_artist=clean_metadata.get('album_artist'),
                duration=duration if duration > 0 else clean_metadata['duration_sec'],
                file_hash=file_hash,
                original_filename=f"{clean_metadata['artist']} - {clean_metadata['title']}.{extension}",
                compressed=(self.quality != 'ultra'),
                file_size=size,
                bitrate=bitrate,
                format=extension,
                year=clean_metadata.get('year'),
                genre=None,
                track_number=clean_metadata.get('track_number'),
                is_local=True,
                local_path=str(final_path.absolute()),
                musicbrainz_id=clean_metadata.get("musicbrainz_id"),
                isrc=clean_metadata.get("isrc"),
                cover_source=clean_metadata.get("cover_source"),
                metadata_modified_by_user=False
            )
            return track
            
        except Exception as e:
            print(f"Error processing downloaded file {metadata.get('title', 'unknown')}: {e}")
            if temp_file.exists():
                os.remove(temp_file)
            return None

    @staticmethod
    def _is_music_specific_content(info: Dict[str, Any], url: str = "") -> bool:
        """
        Detect if YouTube content is music-specific (likely to have good album art thumbnails).
        Returns True if content appears to be music-focused (YouTube Music, VEVO, Topic channels, etc.).
        """
        # Check yt-dlp music-specific fields
        if info.get('artist') or info.get('track') or info.get('album'):
            return True
        
        # Check URL domain
        if 'music.youtube.com' in url.lower():
            return True
        
        # Check channel/uploader patterns
        channel = (info.get('channel') or info.get('uploader') or "").lower()
        if not channel:
            return False
        
        # VEVO channels
        if 'vevo' in channel:
            return True
        
        # Topic channels (official music channels)
        if channel.endswith('- topic') or channel.endswith(' - topic'):
            return True
        
        # Known music labels/collectives
        music_keywords = [
            'records', 'music', 'official', 'oficial', 'label',
            '88rising', 'trap nation', 'proximity', 'monstercat',
            'ncs', 'nocopyrightsounds', 'lyrical lemonade'
        ]
        for keyword in music_keywords:
            if keyword in channel:
                return True
        
        # Check category if available
        category = (info.get('categories') or [])
        if isinstance(category, list):
            category_str = ' '.join(category).lower()
            if 'music' in category_str:
                return True
        
        return False

    def process_video(self, url: str, metadata_hint: Optional[Dict[str, Any]] = None, source: str = "youtube_url") -> Optional[Track]:
        """
        Process a direct YouTube URL.
        1. Fetch metadata
        2. Download
        3. Process & Return Track
        """
        # 1. Fetch Video Info
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': False, # Need full info
        }
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
        if not info:
            raise Exception("Could not fetch video metadata. The URL might be private or invalid.")

        # Parse Metadata
        video_id = info.get('id')
        video_title = info.get('title', 'Unknown Title')
        uploader = info.get('uploader', 'Unknown Artist')
        channel = info.get('channel') or uploader
        duration = info.get('duration', 0)
        
        # Use YT-DLP's specific fields if available (YouTube Music)
        artist = info.get('artist') or info.get('uploader') or uploader
        title = info.get('track') or video_title
        album = info.get('album')
        
        # Detect if content is music-specific (for cover art priority)
        is_music_content = self._is_music_specific_content(info, url)
        
        # Initial raw dict (prefer yt-dlp thumbnail to reduce maxresdefault 404s)
        track_number = info.get('track_number') or info.get('playlist_index') or 1
        raw_meta = {
            'title': title,
            'artist': artist,
            'album': album,
            'album_art_url': info.get('thumbnail') or _yt_thumbnail_url(video_id),
            'duration_sec': duration,
            'release_date': info.get('upload_date'),
            'track_number': track_number,
            'channel': channel,
            'uploader': uploader,
            'description': info.get('description') or "",
            'is_music_content': is_music_content
        }
        raw_meta["thumbnail"] = info.get("thumbnail") or raw_meta.get("album_art_url")
        if isinstance(metadata_hint, dict):
            evidence_title = metadata_hint.get("title")
            evidence_artist = metadata_hint.get("artist") or metadata_hint.get("channel")
            if evidence_title:
                raw_meta["title"] = evidence_title
            if evidence_artist:
                raw_meta["artist"] = evidence_artist
            if metadata_hint.get("duration_sec"):
                raw_meta["duration_sec"] = metadata_hint.get("duration_sec")
            if metadata_hint.get("album"):
                raw_meta["album"] = metadata_hint.get("album")
        clean_meta = raw_meta
        
        # 2. Download
        temp_file = self._download_audio(url)
        
        if not temp_file or not temp_file.exists():
            raise Exception("Download failed: Audio file was not created by yt-dlp. Check if ffmpeg is installed.")
            
        try:
            # 3. Process: file already has metadata and thumbnail from yt-dlp postprocessors
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"

            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))

            shutil.move(str(temp_file), str(final_path))

            # Create Track from info (tags are already in file from yt-dlp)
            track = Track(
                id=file_hash, 
                title=clean_meta['title'],
                artist=clean_meta['artist'],
                album=clean_meta['album'],
                album_artist=clean_meta.get('album_artist'),
                duration=duration if duration > 0 else clean_meta['duration_sec'],
                file_hash=file_hash,
                original_filename=f"{clean_meta['artist']} - {clean_meta['title']}.{extension}",
                compressed=(self.quality != 'ultra'),
                file_size=size,
                bitrate=bitrate,
                format=extension,
                year=clean_meta.get('year'),
                genre=None,
                track_number=clean_meta.get('track_number'),
                is_local=True,
                local_path=str(final_path.absolute()),
                musicbrainz_id=clean_meta.get("musicbrainz_id"),
                isrc=clean_meta.get("isrc"),
                cover_source="youtube",
                metadata_modified_by_user=False
            )
            return track

        except Exception as e:
            if temp_file and temp_file.exists():
                os.remove(temp_file)
            raise Exception(f"Post-processing error: {e}")

    def _search_youtube(self, metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Search YouTube using configured strategies.
        Returns video info dict or None.
        """
        queries = []
        
        # Strategy 1: Topic search (Artist - Title official audio)
        q1 = SEARCH_STRATEGY_PRIMARY.format(
            artist=metadata['artist'], 
            title=metadata['title']
        )
        queries.append(q1)
        
        # Strategy 2: Fallback (Artist - Title)
        q2 = SEARCH_STRATEGY_FALLBACK.format(
            artist=metadata['artist'], 
            title=metadata['title']
        )
        queries.append(q2)
        
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True, # Don't download, just get info
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios', 'web'], # Try mobile clients first
                }
            }
        }
        
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            for query in queries:
                try:
                    # Search 5 results
                    results = ydl.extract_info(f"ytsearch5:{query}", download=False)
                    if not results or 'entries' not in results:
                        continue
                        
                    best_match = None
                    highest_score = 0
                    
                    for entry in results['entries']:
                        if not entry: continue
                        
                        is_valid, score = self._is_valid_match(entry, metadata)
                        
                        if is_valid:
                            if score > highest_score:
                                highest_score = score
                                best_match = entry
                    
                    if best_match:
                        print(f"Found match: {best_match.get('title')} (Score: {highest_score:.2f})")
                        return best_match
                        
                except Exception as e:
                    print(f"Search error for {query}: {e}")
                    continue
                    
        return None

    def _is_valid_match(self, video_info: Dict[str, Any], metadata: Dict[str, Any]) -> tuple[bool, float]:
        """
        Check if a video is a valid match using word intersection.
        """
        title = video_info.get('title', '').lower()
        
        # 1. Duration Check (Only if duration is known)
        target_duration = metadata.get('duration_sec', 0)
        if target_duration > 0:
            actual_duration = video_info.get('duration', 0)
            diff = abs(actual_duration - target_duration)
            if diff > DURATION_TOLERANCE_SEC:
                return False, 0.0
        
        # 2. Keyword Exclusion
        for keyword in FORBIDDEN_KEYWORDS:
            if keyword in title and keyword not in metadata['title'].lower():
                return False, 0.0

        # 3. Robust Word Matching
        # We check if most words from our query are present in the video title
        query_text = f"{metadata['artist']} {metadata['title']}".lower()
        query_words = set(re.findall(r'\w+', query_text))
        video_words = set(re.findall(r'\w+', title))
        
        # Remove small generic words from comparison
        stop_words = {'a', 'the', 'of', 'and', 'official', 'audio', 'video', 'music'}
        query_words = query_words - stop_words
        
        if not query_words:
            return True, 1.0 # Should not happen
            
        intersection = query_words.intersection(video_words)
        match_ratio = len(intersection) / len(query_words)
        
        # Use existing threshold
        if match_ratio >= 0.5: # Half of the important words match
            return True, match_ratio
            
        return False, 0.0

    def _calculate_similarity(self, a: str, b: str) -> float:
        return difflib.SequenceMatcher(None, a, b).ratio()

    def _download_audio(self, url: str) -> Optional[Path]:
        """Download audio from URL and convert/remux based on quality."""
        import time
        temp_filename = f"temp_{os.getpid()}_{time.time_ns()}_{uuid.uuid4().hex[:6]}"
        output_template = str(self.temp_dir / f"{temp_filename}.%(ext)s")
        
        profile = QUALITY_PROFILES.get(self.quality, QUALITY_PROFILES[DEFAULT_QUALITY])
        
        # Base options: YT Music metadata via add-metadata + embed-thumbnail (Gemini-style)
        ydl_opts = {
            'format': YDL_FORMAT_AUDIO,
            'retries': 10,
            'fragment_retries': 10,
            'outtmpl': output_template,
            'quiet': True,
            'no_warnings': True,
            'writethumbnail': True,  # Required for EmbedThumbnail
            'parse_metadata': [
                'playlist_index:%(track_number)s',
                '%(track|title)s:%(title)s',
            ],
            'extractor_args': {
                'youtube': {
                    'player_client': ['web', 'android', 'mweb'],
                }
            }
        }

        if profile['bitrate'] > 0:
            extract_pp = {
                'key': 'FFmpegExtractAudio',
                'preferredcodec': profile['format'],
                'preferredquality': str(profile['bitrate']),
            }
        else:
            extract_pp = {'key': 'FFmpegExtractAudio', 'preferredcodec': 'flac'}

        # Order: extract audio -> add metadata (title, artist, album, etc.) -> embed thumbnail
        ydl_opts['postprocessors'] = [
            extract_pp,
            {'key': 'FFmpegMetadata', 'add_metadata': True},
            {'key': 'EmbedThumbnail', 'already_have_thumbnail': False},
        ]
        
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
        except Exception as e:
            # Retry with even simpler options if first attempt fails
            try:
                print(f"Primary download failed, retrying with simplified options: {e}")
                simple_opts = {
                    'format': YDL_FORMAT_AUDIO,
                    'outtmpl': output_template,
                    'quiet': True,
                    'no_warnings': True,
                }
                # Keep postprocessors
                if 'postprocessors' in ydl_opts:
                    simple_opts['postprocessors'] = ydl_opts['postprocessors']
                
                with yt_dlp.YoutubeDL(simple_opts) as ydl:
                    ydl.download([url])
            except Exception as e2:
                raise Exception(f"yt-dlp error: {e2}")
                
        # Find the generated file (might be .mp3 or .flac)
        ext = profile['format']
        if ext == 'best': ext = 'flac'
        
        expected_path = self.temp_dir / f"{temp_filename}.{ext}"
        if expected_path.exists():
            return expected_path
        
        for f in self.temp_dir.glob(f"{temp_filename}.*"):
            return f

        return None

    def search_youtube(self, query: str, max_results: int = 10, use_ytmusic: bool = True) -> List[Dict[str, Any]]:
        """
        Search YouTube or YouTube Music with plain text. Returns raw yt-dlp entries
        as minimal dicts: id, title, duration, thumbnail, webpage_url, channel.
        No filtering — pass-through for UI; a proper search layer can be added later.
        use_ytmusic=True: youtube:music:search_url. use_ytmusic=False: ytsearch prefix.
        """
        if not query or not query.strip():
            return []
        query = query.strip()
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True,
            'extractor_args': {
                'youtube': {'player_client': ['android', 'ios', 'web']}
            }
        }
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        if use_ytmusic:
            search_input = f"https://music.youtube.com/search?q={quote(query)}"
        else:
            search_input = f"ytsearch{max_results}:{query}"

        def to_item(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            if not entry:
                return None
            video_id = entry.get('id')
            if not video_id:
                return None
            webpage_url = entry.get('url') or entry.get('webpage_url') or f"https://www.youtube.com/watch?v={video_id}"
            return {
                'id': video_id,
                'title': entry.get('title') or 'Unknown',
                'duration': entry.get('duration') or 0,
                'thumbnail': entry.get('thumbnail') or (f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg" if video_id else ''),
                'webpage_url': webpage_url,
                'channel': entry.get('channel') or entry.get('uploader') or ''
            }

        out: List[Dict[str, Any]] = []
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(search_input, download=False)
            if not result or 'entries' not in result:
                return []
            raw_entries = result['entries']
            if raw_entries is None:
                return []
            entries_list = list(raw_entries) if not isinstance(raw_entries, list) else raw_entries
            if use_ytmusic:
                entries_list = entries_list[:max_results]
            for entry in entries_list:
                item = to_item(entry)
                if item is not None:
                    out.append(item)
        except Exception as e:
            if use_ytmusic:
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        result = ydl.extract_info(f"ytsearch{max_results}:{query}", download=False)
                    if result and 'entries' in result:
                        for entry in result['entries']:
                            item = to_item(entry)
                            if item is not None:
                                out.append(item)
                    print(f"YouTube Music search failed, used YouTube fallback: {e}")
                except Exception as e2:
                    print(f"YouTube search error (fallback): {e2}")
            else:
                print(f"YouTube search error: {e}")
        return out

    def _extract_info_for_validation(self, url: str, ydl_opts: dict) -> Optional[Dict[str, Any]]:
        """Run extract_info and return info if thumbnail and playable audio URL present."""
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception:
            return None
        if not info:
            return None
        thumb = info.get('thumbnail') or (f"https://img.youtube.com/vi/{info.get('id')}/mqdefault.jpg" if info.get('id') else None)
        if not thumb:
            return None
        stream_url = info.get('url')
        if not stream_url and info.get('formats'):
            for f in info.get('formats', []):
                if f.get('vcodec') == 'none' and f.get('url'):
                    stream_url = f['url']
                    break
        if not stream_url:
            return None
        return info

    def validate_and_get_info(self, video_id: str) -> Optional[Dict[str, Any]]:
        """Extract full info for a video; return only if thumbnail and playable audio. Retry with worstaudio, then no format (pick from list)."""
        if not video_id or not str(video_id).strip():
            return None
        url = f"https://www.youtube.com/watch?v={video_id}"
        base_opts = {'quiet': True, 'no_warnings': True}
        if self.cookie_file and os.path.exists(self.cookie_file):
            base_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            base_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        # No player_client restriction so yt-dlp uses default (same as CLI; includes android_vr).
        # Try permissive format first (bestaudio/best), then strict, then worstaudio, then no format
        for fmt in ('bestaudio/best', YDL_FORMAT_AUDIO, 'worstaudio'):
            info = self._extract_info_for_validation(url, {**base_opts, 'format': fmt})
            if info:
                return info
        # Last resort: no format selector so yt-dlp returns all formats; pick first audio-only
        try:
            with yt_dlp.YoutubeDL(base_opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception:
            return None
        if not info:
            return None
        thumb = info.get('thumbnail') or (f"https://img.youtube.com/vi/{info.get('id')}/mqdefault.jpg" if info.get('id') else None)
        if not thumb:
            return None
        stream_url = info.get('url')
        if not stream_url and info.get('formats'):
            for f in info.get('formats', []):
                if f.get('vcodec') == 'none' and f.get('url'):
                    stream_url = f['url']
                    break
        return info if stream_url else None

    def get_stream_url(self, video_id: str) -> Optional[str]:
        """Return direct audio stream URL. Tries format strings, then no format (pick first audio from list)."""
        if not video_id or not str(video_id).strip():
            return None
        url = f"https://www.youtube.com/watch?v={video_id}"
        base_opts = {'quiet': True, 'no_warnings': True}
        if self.cookie_file and os.path.exists(self.cookie_file):
            base_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            base_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        # No player_client restriction so yt-dlp uses default (same as CLI).
        for fmt in ('bestaudio/best', YDL_FORMAT_AUDIO, 'worstaudio'):
            try:
                with yt_dlp.YoutubeDL({**base_opts, 'format': fmt}) as ydl:
                    info = ydl.extract_info(url, download=False)
            except Exception:
                continue
            if not info:
                continue
            stream_url = info.get('url')
            if not stream_url and info.get('formats'):
                for f in info.get('formats', []):
                    if f.get('vcodec') == 'none' and f.get('url'):
                        stream_url = f['url']
                        break
            if stream_url:
                return stream_url
        # Last resort: no format selector; yt-dlp returns all formats, pick first audio-only
        try:
            with yt_dlp.YoutubeDL(base_opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception:
            return None
        if not info:
            return None
        stream_url = info.get('url')
        if not stream_url and info.get('formats'):
            for f in info.get('formats', []):
                if f.get('vcodec') == 'none' and f.get('url'):
                    return f['url']
        return stream_url

    def stream_audio_generator(self, video_id: str, timeout: int = 60) -> Iterator[bytes]:
        """
        Yield audio bytes for a YouTube video (for in-app preview streaming).
        Uses bestaudio format and streams via the direct URL; no file written.
        """
        stream_url = self.get_stream_url(video_id)
        if not stream_url:
            return
        try:
            with requests.get(stream_url, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
        except Exception:
            return
