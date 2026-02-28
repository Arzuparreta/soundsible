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
from .metadata_harmonizer import MetadataHarmonizer

# Only this source skips harmonization; all others use canonical metadata (MusicBrainz/iTunes).
SOURCE_RAW_YOUTUBE = "youtube_search"


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
        Full workflow for a single track: Search -> Download -> Process -> Return Track
        """
        # 1. Harmonize metadata (Standardize source)
        metadata = dict(metadata or {})
        metadata.setdefault("metadata_decision_id", uuid.uuid4().hex)
        clean_metadata = MetadataHarmonizer.harmonize(metadata, source=source)
        
        # 2. Search for video
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
                metadata_source_authority=clean_metadata.get("metadata_source_authority"),
                metadata_confidence=clean_metadata.get("metadata_confidence"),
                metadata_decision_id=clean_metadata.get("metadata_decision_id"),
                metadata_state=clean_metadata.get("metadata_state"),
                metadata_query_fingerprint=clean_metadata.get("metadata_query_fingerprint"),
                cover_source=clean_metadata.get("cover_source"),
                metadata_modified_by_user=False
            )
            track.review_candidates = clean_metadata.get("review_candidates") or {}
            track.premium_cover_failed = clean_metadata.get("premium_cover_failed", False)
            track.fallback_cover_url = clean_metadata.get("fallback_cover_url") or clean_metadata.get("album_art_url")
            
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
        
        # Known music labels/collectives (from MetadataHarmonizer.COLLECTIVES)
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
        raw_meta = {
            'title': title,
            'artist': artist,
            'album': album,
            'album_art_url': info.get('thumbnail') or (MetadataHarmonizer.get_best_yt_thumbnail(video_id) if video_id else None),
            'duration_sec': duration,
            'release_date': info.get('upload_date'),
            'track_number': info.get('track_number', 1),
            'channel': channel,
            'uploader': uploader,
            'description': info.get('description') or "",
            'metadata_decision_id': uuid.uuid4().hex,
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
            if metadata_hint.get("metadata_decision_id"):
                raw_meta["metadata_decision_id"] = metadata_hint.get("metadata_decision_id")
        # Raw YouTube path: only SOURCE_RAW_YOUTUBE skips harmonization (user chose "YouTube" toggle).
        # All other sources (ytmusic_search, youtube_url, etc.) use canonical metadata below.
        if source == SOURCE_RAW_YOUTUBE:
            raw_meta["title"] = video_title
            raw_meta["artist"] = channel
            raw_meta["album"] = "Downloaded from YouTube"
            # Fallback: ensure normal YouTube downloads get a cover (YT miniature) so they are not saved without cover
            yt_thumb = info.get("thumbnail") or (MetadataHarmonizer.get_best_yt_thumbnail(video_id) if video_id else None)
            if yt_thumb:
                raw_meta["album_art_url"] = yt_thumb
            clean_meta = raw_meta
        else:
            # Harmonize (Standardize + MusicBrainz/iTunes lookup)
            clean_meta = MetadataHarmonizer.harmonize(raw_meta, source=source)
        
        # 2. Download
        temp_file = self._download_audio(url)
        
        if not temp_file or not temp_file.exists():
            raise Exception("Download failed: Audio file was not created by yt-dlp. Check if ffmpeg is installed.")
            
        try:
            # 3. Process
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            
            # Embed metadata
            AudioProcessor.embed_metadata(
                str(temp_file), 
                clean_meta, 
                clean_meta.get('album_art_url')
            )
            
            # Verify audio details
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            
            # Move
            shutil.move(str(temp_file), str(final_path))
            
            # Create Track
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
                metadata_source_authority=clean_meta.get("metadata_source_authority"),
                metadata_confidence=clean_meta.get("metadata_confidence"),
                metadata_decision_id=clean_meta.get("metadata_decision_id"),
                metadata_state=clean_meta.get("metadata_state"),
                metadata_query_fingerprint=clean_meta.get("metadata_query_fingerprint"),
                cover_source=clean_meta.get("cover_source") if source != SOURCE_RAW_YOUTUBE else "youtube",
                metadata_modified_by_user=False,
                download_source=source
            )
            track.review_candidates = clean_meta.get("review_candidates") or {}
            track.premium_cover_failed = clean_meta.get("premium_cover_failed", False)
            track.fallback_cover_url = clean_meta.get("fallback_cover_url") or clean_meta.get("album_art_url")
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
        
        # Base options
        ydl_opts = {
            'format': 'ba/b',
            'retries': 10,
            'fragment_retries': 10,
            'outtmpl': output_template,
            'quiet': True,
            'no_warnings': True,
            'extractor_args': {
                'youtube': {
                    'player_client': ['web', 'android', 'mweb'],
                }
            }
        }
        
        if profile['bitrate'] > 0:
            ydl_opts['postprocessors'] = [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': profile['format'],
                'preferredquality': str(profile['bitrate']),
            }]
        else:
            ydl_opts['postprocessors'] = [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'flac',
            }]
        
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
                    'format': 'bestaudio/best',
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
        Search YouTube or YouTube Music with plain text. Returns a list of
        minimal entries for UI: id, title, duration, thumbnail, webpage_url, channel.
        use_ytmusic=True: uses URL that triggers yt-dlp extractor "youtube:music:search_url" (see --list-extractors).
        use_ytmusic=False: uses "youtube:search" via ytsearch prefix.
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

        # youtube:music:search_url (from yt-dlp --list-extractors) is triggered by this URL
        if use_ytmusic:
            search_input = f"https://music.youtube.com/search?q={quote(query)}"
        else:
            # youtube:search via ytsearchN:query
            search_input = f"ytsearch{max_results}:{query}"

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
                if not entry:
                    continue
                video_id = entry.get('id')
                if not video_id:
                    continue
                webpage_url = entry.get('url') or entry.get('webpage_url') or f"https://www.youtube.com/watch?v={video_id}"
                out.append({
                    'id': video_id,
                    'title': entry.get('title') or 'Unknown',
                    'duration': entry.get('duration') or 0,
                    'thumbnail': entry.get('thumbnail') or (f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg" if video_id else ''),
                    'webpage_url': webpage_url,
                    'channel': entry.get('channel') or entry.get('uploader') or ''
                })
        except Exception as e:
            if use_ytmusic:
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        result = ydl.extract_info(f"ytsearch{max_results}:{query}", download=False)
                    if result and 'entries' in result:
                        for entry in result['entries']:
                            if not entry:
                                continue
                            video_id = entry.get('id')
                            if not video_id:
                                continue
                            webpage_url = entry.get('url') or entry.get('webpage_url') or f"https://www.youtube.com/watch?v={video_id}"
                            out.append({
                                'id': video_id,
                                'title': entry.get('title') or 'Unknown',
                                'duration': entry.get('duration') or 0,
                                'thumbnail': entry.get('thumbnail') or (f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg" if video_id else ''),
                                'webpage_url': webpage_url,
                                'channel': entry.get('channel') or entry.get('uploader') or ''
                            })
                    print(f"YouTube Music search failed, used YouTube fallback: {e}")
                except Exception as e2:
                    print(f"YouTube search error (fallback): {e2}")
            else:
                print(f"YouTube search error: {e}")
        return out

    def stream_audio_generator(self, video_id: str, timeout: int = 60) -> Iterator[bytes]:
        """
        Yield audio bytes for a YouTube video (for in-app preview streaming).
        Uses bestaudio format and streams via the direct URL; no file written.
        """
        url = f"https://www.youtube.com/watch?v={video_id}"
        ydl_opts = {
            'format': 'bestaudio/best',
            'quiet': True,
            'no_warnings': True,
            'extractor_args': {
                'youtube': {'player_client': ['web', 'android', 'mweb']}
            }
        }
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        stream_url = None
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if not info:
                return
            stream_url = info.get('url')
            if not stream_url and info.get('formats'):
                for f in info.get('formats', []):
                    if f.get('vcodec') == 'none' and f.get('url'):
                        stream_url = f['url']
                        break
            if not stream_url:
                return
        except Exception:
            return

        try:
            with requests.get(stream_url, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
        except Exception:
            return
