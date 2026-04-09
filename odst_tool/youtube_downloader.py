import logging
import os
import shutil
import subprocess
import sys
import time
import re
import uuid
from pathlib import Path
from typing import Optional, Dict, Any, List, Iterator
from urllib.parse import quote, urlparse, parse_qs
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
from shared.venv_utils import get_subprocess_python

logger = logging.getLogger(__name__)

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


def _extract_video_id_from_url(url: str) -> Optional[str]:
    """Extract YouTube video ID from youtube.com or youtu.be URL."""
    if not url or not isinstance(url, str):
        return None
    url = url.strip()
    parsed = urlparse(url)
    if "youtu.be" in parsed.netloc:
        vid = (parsed.path or "").strip("/").split("?")[0].split("/")[0]
        return vid if _is_valid_youtube_video_id(vid) else None
    if "youtube.com" in parsed.netloc:
        qs = parse_qs(parsed.query)
        vid = (qs.get("v") or [None])[0]
        return str(vid) if vid and _is_valid_youtube_video_id(str(vid)) else None
    return None

# Note: Same as A normal CLI download. no extractor_args (see docs/troubleshooting-yt-dlp-formats.md).
YDL_FORMAT_AUDIO = "bestaudio/bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best/worstaudio"


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
        
        # Note: Auto-detect cookies.txt if no cookie source provided
        if not self.cookie_file and not self.cookie_browser:
            try:
                from shared.constants import DEFAULT_CONFIG_DIR
                potential_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "cookies.txt"
                if potential_path.exists():
                    self.cookie_file = str(potential_path)
                    # Note: Print(f"DEBUG auto-detected cookies at {self.cookie_file}")
            except ImportError:
                pass

    def process_track(self, metadata: Dict[str, Any], source: str = "manual") -> Optional[Track]:
        """
        Full workflow for a single track: Search -> Download -> Process -> Return Track.
        """
        metadata = dict(metadata or {})
        metadata.setdefault("title", "Unknown Title")
        metadata.setdefault("artist", "Unknown Artist")
        metadata.setdefault("album", "")
        clean_metadata = metadata

        # Note: Search for video
        video_info = self._search_youtube(clean_metadata)
        
        if not video_info:
            return None
            
        # Note: Rate limit protection sleep random amount
        import time
        import random
        from .config import DOWNLOAD_DELAY_RANGE
        time.sleep(random.uniform(*DOWNLOAD_DELAY_RANGE))
            
        # Note: 3. Download audio
        url = video_info.get('webpage_url') or video_info.get('url')
        temp_file = self._download_audio(url)
        
        if not temp_file:
            return None
            
        try:
            # Note: 4. Process file (hash, metadata, move)
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            
            # Note: Embed metadata (using clean version)
            AudioProcessor.embed_metadata(
                str(temp_file), 
                clean_metadata, 
                clean_metadata.get('album_art_url')
            )
            
            # Note: Verify audio details
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            
            # Note: Move to final location (renaming to hash)
            shutil.move(str(temp_file), str(final_path))
            
            # Note: 5. Create track object
            yt_id = video_info.get('id') if _is_valid_youtube_video_id(video_info.get('id')) else None
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
                local_path=None,
                musicbrainz_id=clean_metadata.get("musicbrainz_id"),
                isrc=clean_metadata.get("isrc"),
                cover_source=clean_metadata.get("cover_source"),
                metadata_modified_by_user=False,
                youtube_id=yt_id
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
        # Note: Check yt-dlp music-specific fields
        if info.get('artist') or info.get('track') or info.get('album'):
            return True
        
        # Note: Check URL domain
        if 'music.youtube.com' in url.lower():
            return True
        
        # Note: Check channel/uploader patterns
        channel = (info.get('channel') or info.get('uploader') or "").lower()
        if not channel:
            return False
        
        # Note: VEVO channels
        if 'vevo' in channel:
            return True
        
        # Note: Topic channels (official music channels)
        if channel.endswith('- topic') or channel.endswith(' - topic'):
            return True
        
        # Note: Known music labels/collectives
        music_keywords = [
            'records', 'music', 'official', 'oficial', 'label',
            '88rising', 'trap nation', 'proximity', 'monstercat',
            'ncs', 'nocopyrightsounds', 'lyrical lemonade'
        ]
        for keyword in music_keywords:
            if keyword in channel:
                return True
        
        # Note: Check category if available
        category = (info.get('categories') or [])
        if isinstance(category, list):
            category_str = ' '.join(category).lower()
            if 'music' in category_str:
                return True
        
        return False

    def process_video(self, url: str, metadata_hint: Optional[Dict[str, Any]] = None, source: str = "youtube_url") -> Optional[Track]:
        """
        Process a direct YouTube URL. Single yt-dlp run (download only), then read metadata from file.
        Matches CLI behavior: one format selection, one download.
        """
        temp_file = self._download_audio(url)
        if not temp_file or not temp_file.exists():
            raise Exception("Download failed: Audio file was not created by yt-dlp. Check if ffmpeg is installed.")

        try:
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            clean_meta = AudioProcessor.get_metadata_from_file(str(temp_file))
            clean_meta.setdefault('title', 'Unknown Title')
            clean_meta.setdefault('artist', 'Unknown Artist')
            clean_meta.setdefault('album', '')
            clean_meta.setdefault('duration_sec', duration or 0)
            clean_meta.setdefault('track_number', 1)
            if isinstance(metadata_hint, dict):
                if metadata_hint.get("title"):
                    clean_meta["title"] = metadata_hint["title"]
                if metadata_hint.get("artist") or metadata_hint.get("channel"):
                    clean_meta["artist"] = metadata_hint.get("artist") or metadata_hint.get("channel")
                if metadata_hint.get("duration_sec") is not None:
                    clean_meta["duration_sec"] = metadata_hint["duration_sec"]
                if metadata_hint.get("album") is not None:
                    clean_meta["album"] = metadata_hint["album"]

            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            shutil.move(str(temp_file), str(final_path))

            video_id = _extract_video_id_from_url(url)
            track = Track(
                id=file_hash,
                title=clean_meta['title'],
                artist=clean_meta['artist'],
                album=clean_meta.get('album') or '',
                album_artist=clean_meta.get('album_artist'),
                duration=duration if duration > 0 else clean_meta.get('duration_sec') or 0,
                file_hash=file_hash,
                original_filename=f"{clean_meta['artist']} - {clean_meta['title']}.{extension}",
                compressed=(self.quality != 'ultra'),
                file_size=size,
                bitrate=bitrate,
                format=extension,
                year=clean_meta.get('year'),
                genre=None,
                track_number=clean_meta.get('track_number') or 1,
                is_local=True,
                local_path=None,
                musicbrainz_id=None,
                isrc=None,
                cover_source="youtube",
                metadata_modified_by_user=False,
                youtube_id=video_id
            )
            return track
        except Exception as e:
            if temp_file and temp_file.exists():
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            raise Exception(f"Post-processing error: {e}")

    def _search_youtube(self, metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Search YouTube using configured strategies.
        Returns video info dict or None.
        """
        queries = []
        
        # Note: Strategy 1 topic search (artist - title official audio)
        q1 = SEARCH_STRATEGY_PRIMARY.format(
            artist=metadata['artist'], 
            title=metadata['title']
        )
        queries.append(q1)
        
        # Note: Strategy 2 fallback (artist - title)
        q2 = SEARCH_STRATEGY_FALLBACK.format(
            artist=metadata['artist'], 
            title=metadata['title']
        )
        queries.append(q2)
        
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True, # Note: Don't download, just get info
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios', 'web'], # Note: Try mobile clients first
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
                    # Note: Search 5 results
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
        
        # Note: 1. Duration check (only if duration is known)
        target_duration = metadata.get('duration_sec', 0)
        if target_duration > 0:
            actual_duration = video_info.get('duration', 0)
            diff = abs(actual_duration - target_duration)
            if diff > DURATION_TOLERANCE_SEC:
                return False, 0.0
        
        # Note: 2. Keyword exclusion
        for keyword in FORBIDDEN_KEYWORDS:
            if keyword in title and keyword not in metadata['title'].lower():
                return False, 0.0

        # Note: 3. Robust word matching
        # Note: We check if most words from our query are present in the video title
        query_text = f"{metadata['artist']} {metadata['title']}".lower()
        query_words = set(re.findall(r'\w+', query_text))
        video_words = set(re.findall(r'\w+', title))
        
        # Note: Remove small generic words from comparison
        stop_words = {'a', 'the', 'of', 'and', 'official', 'audio', 'video', 'music'}
        query_words = query_words - stop_words
        
        if not query_words:
            return True, 1.0 # Note: Should not happen
            
        intersection = query_words.intersection(video_words)
        match_ratio = len(intersection) / len(query_words)
        
        # Note: Use existing threshold
        if match_ratio >= 0.5: # Note: Half of the important words match
            return True, match_ratio
            
        return False, 0.0

    def _calculate_similarity(self, a: str, b: str) -> float:
        return difflib.SequenceMatcher(None, a, b).ratio()

    def _download_audio(self, url: str) -> Optional[Path]:
        """Download via yt-dlp CLI (subprocess) so behavior matches a normal terminal download."""
        import time
        temp_filename = f"temp_{os.getpid()}_{time.time_ns()}_{uuid.uuid4().hex[:6]}"
        output_template = str(self.temp_dir / f"{temp_filename}.%(ext)s")
        profile = QUALITY_PROFILES.get(self.quality, QUALITY_PROFILES[DEFAULT_QUALITY])

        codec = profile['format'] if profile['format'] != 'best' else 'flac'
        args = [
            get_subprocess_python(), "-m", "yt_dlp",
            "-f", YDL_FORMAT_AUDIO,
            "-x",
            "--audio-format", codec,
        ]
        if profile.get('bitrate', 0) > 0 and codec == 'mp3':
            args.extend(["--audio-quality", str(profile['bitrate'])])
        args.extend([
            "--add-metadata",
            "--embed-thumbnail",
            "--parse-metadata", "playlist_index:%(track_number)s",
            "--parse-metadata", "%(track|title)s:%(title)s",
            "-o", output_template,
            "--retries", "10",
            "--no-warnings",
            "--quiet",
        ])
        if self.cookie_file and os.path.exists(self.cookie_file):
            args.extend(["--cookies", self.cookie_file])
        elif self.cookie_browser:
            args.extend(["--cookies-from-browser", self.cookie_browser])
        args.append(url)

        result = subprocess.run(
            args,
            cwd=str(self.temp_dir),
            timeout=600,
            capture_output=True,
            text=True,
        )
        # Note: With cookies, youtube can return a format list that doesn't match or a "page needs to be reloaded" error.
        # In both cases, retry once without cookies (same as a normal terminal fallback).
        combined_output = (result.stderr or "") + (result.stdout or "")
        if result.returncode != 0 and (
            "Requested format is not available" in combined_output
            or "The page needs to be reloaded" in combined_output
        ):
            if self.cookie_file or self.cookie_browser:
                i, no_cookies = 0, []
                while i < len(args):
                    if args[i] in ("--cookies", "--cookies-from-browser") and i + 1 < len(args):
                        i += 2
                        continue
                    no_cookies.append(args[i])
                    i += 1
                result = subprocess.run(
                    no_cookies,
                    cwd=str(self.temp_dir),
                    timeout=600,
                    capture_output=True,
                    text=True,
                )
                combined_output = (result.stderr or "") + (result.stdout or "")
        if result.returncode != 0:
            raise Exception(combined_output or f"yt-dlp exited {result.returncode}")

        ext = codec
        expected_path = self.temp_dir / f"{temp_filename}.{ext}"
        if expected_path.exists():
            return expected_path
        for f in self.temp_dir.glob(f"{temp_filename}.*"):
            return f
        return None

    def search_youtube(self, query: str, max_results: int = 10, use_ytmusic: bool = True) -> List[Dict[str, Any]]:
        """
        Search YouTube or YouTube Music with plain text. Returns yt-dlp-derived dicts:
        id, title, duration, thumbnail, webpage_url, channel, artist (same value from
        channel, uploader, or artist — whichever yt-dlp provides).
        No filtering — pass-through for UI; a proper search layer can be added later.
        use_ytmusic=True: https://music.youtube.com/search?q=...#songs (full playlist
        extract, not flat — flat YTM search omits uploader/channel/artist). No cookies
        on this path: full extract + cookies often yields “Requested format is not
        available”; downloads still use cookies elsewhere.
        use_ytmusic=False: ytsearchN:query with extract_flat (fast; uploader present).
        """
        if not query or not query.strip():
            return []
        query = query.strip()
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extractor_args': {
                'youtube': {'player_client': ['android', 'ios', 'web']}
            }
        }
        if use_ytmusic:
            ydl_opts['extract_flat'] = False
            ydl_opts['playlistend'] = max_results
            ydl_opts['ignoreerrors'] = True
        else:
            ydl_opts['extract_flat'] = True
            if self.cookie_file and os.path.exists(self.cookie_file):
                ydl_opts['cookiefile'] = self.cookie_file
            elif self.cookie_browser:
                ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        if use_ytmusic:
            search_input = f"https://music.youtube.com/search?q={quote(query)}#songs"
        else:
            search_input = f"ytsearch{max_results}:{query}"

        def to_item(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            if not entry:
                return None
            video_id = entry.get('id')
            if not video_id:
                return None
            title = (entry.get('title') or '').strip()
            if not title or title.lower() == 'unknown':
                return None
            webpage_url = entry.get('url') or entry.get('webpage_url') or f"https://www.youtube.com/watch?v={video_id}"
            raw_creator = (
                entry.get('channel')
                or entry.get('uploader')
                or entry.get('artist')
            )
            if raw_creator is None:
                creator = ''
            elif isinstance(raw_creator, str):
                creator = raw_creator.strip()
            elif isinstance(raw_creator, (list, tuple)):
                creator = ', '.join(str(x) for x in raw_creator if x).strip()
            else:
                creator = str(raw_creator).strip()
            return {
                'id': video_id,
                'title': title,
                'duration': entry.get('duration') or 0,
                'thumbnail': entry.get('thumbnail') or (f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg" if video_id else ''),
                'webpage_url': webpage_url,
                'channel': creator,
                'artist': creator,
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
            logger.warning("YouTube search error (use_ytmusic=%s): %s", use_ytmusic, e)
            # Note: No silent fallback -- let the caller decide or propagate the error
            raise e
        return out

    def get_related_videos(self, seed_video_id: str, max_results: int = 25) -> List[Dict[str, Any]]:
        """
        Fetch related/mix videos for a seed from YouTube Music (playlist RD{id}).
        Returns same shape as search_youtube: id, title, duration, thumbnail, webpage_url, channel, artist.
        """
        if not _is_valid_youtube_video_id(seed_video_id):
            return []
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': 'in_playlist',
            'noplaylist': False,
            'extractor_args': {
                'youtube': {'player_client': ['android', 'ios', 'web']}
            }
        }
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        # Note: Watch URL with list=RD direct playlist?list=RD returns "this playlist type is unviewable".
        mix_url = f"https://www.youtube.com/watch?v={seed_video_id}&list=RD{seed_video_id}&start_radio=1"

        def to_item(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            if not entry:
                return None
            video_id = entry.get('id')
            if not video_id:
                return None
            title = (entry.get('title') or '').strip() or 'Unknown'
            webpage_url = entry.get('url') or entry.get('webpage_url') or f"https://www.youtube.com/watch?v={video_id}"
            channel = entry.get('channel') or entry.get('uploader') or ''
            return {
                'id': video_id,
                'title': title,
                'duration': entry.get('duration') or 0,
                'thumbnail': entry.get('thumbnail') or (f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg" if video_id else ''),
                'webpage_url': webpage_url,
                'channel': channel,
                'artist': channel,
            }

        out: List[Dict[str, Any]] = []
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(mix_url, download=False)
            if not result or 'entries' not in result:
                print(f"[Discover] get_related_videos: no entries in result for seed {seed_video_id} (result keys: {list(result.keys()) if result else 'None'})")
                return []
            raw_entries = result['entries']
            if raw_entries is None:
                print(f"[Discover] get_related_videos: entries is None for seed {seed_video_id}")
                return []
            entries_list = list(raw_entries) if not isinstance(raw_entries, list) else raw_entries
            for entry in entries_list[:max_results]:
                item = to_item(entry)
                if item is not None:
                    out.append(item)
        except Exception as e:
            print(f"[Discover] get_related_videos failed for seed {seed_video_id}: {e}")
            return []
        return out

    def get_stream_url(self, video_id: str) -> Optional[str]:
        """Return direct audio stream URL via yt-dlp CLI (-g). Same format and cookie-retry as downloads."""
        if not video_id or not str(video_id).strip():
            return None
        yt_url = f"https://www.youtube.com/watch?v={video_id}"
        args = [
            get_subprocess_python(), "-m", "yt_dlp",
            "-g",
            "-f", YDL_FORMAT_AUDIO,
            "--no-warnings",
            "--quiet",
            yt_url,
        ]
        if self.cookie_file and os.path.exists(self.cookie_file):
            args.extend(["--cookies", self.cookie_file])
        elif self.cookie_browser:
            args.extend(["--cookies-from-browser", self.cookie_browser])
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=30,
            )
            # Note: Same as download: if yt-dlp reports format mismatch or "page needs to be reloaded",
            # retry once without cookies to avoid transient YouTube/STS issues.
            combined_output = (result.stderr or "") + (result.stdout or "")
            if result.returncode != 0 and (
                "Requested format is not available" in combined_output
                or "The page needs to be reloaded" in combined_output
            ):
                if self.cookie_file or self.cookie_browser:
                    no_cookies = []
                    i = 0
                    while i < len(args):
                        if args[i] in ("--cookies", "--cookies-from-browser") and i + 1 < len(args):
                            i += 2
                            continue
                        no_cookies.append(args[i])
                        i += 1
                    result = subprocess.run(
                        no_cookies,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    combined_output = (result.stderr or "") + (result.stdout or "")
            if result.returncode != 0:
                stderr = (combined_output or "").strip() or "(no stderr)"
                print(f"[Preview] yt-dlp -g failed for {video_id}: returncode={result.returncode}, stderr={stderr[:500]}")
                return None
            line = (result.stdout or "").strip().splitlines()
            stream_url = line[0] if line else None
            if not stream_url:
                print(f"[Preview] yt-dlp -g returned no URL for {video_id}")
            return stream_url
        except subprocess.TimeoutExpired:
            print(f"[Preview] yt-dlp -g timed out for {video_id}")
            return None
        except FileNotFoundError:
            print(f"[Preview] yt-dlp not found (python -m yt_dlp) for {video_id}")
            return None

    def get_cover_for_query(self, artist: str, title: str) -> Optional[str]:
        """Fetch only cover (thumbnail) for a track via yt-dlp search. No audio download.
        Returns thumbnail URL or None. Uses extract_info(download=False) so no media is downloaded."""
        if not title or not str(title).strip():
            return None
        query = f"{artist or ''} {title}".strip()
        if not query:
            return None
        try:
            results = self.search_youtube(query, max_results=1, use_ytmusic=True)
            if not results:
                results = self.search_youtube(query, max_results=1, use_ytmusic=False)
            if results and results[0].get("thumbnail"):
                return results[0]["thumbnail"]
            return None
        except Exception:
            return None

    def stream_audio_generator(self, video_id: str, timeout: int = 60) -> Iterator[bytes]:
        """
        Yield audio bytes for a YouTube video (for in-app preview streaming).
        Uses bestaudio format and streams via the direct URL; no file written.
        """
        stream_url = self.get_stream_url(video_id)
        if not stream_url:
            print(f"[Preview] No stream URL for {video_id}; response will be empty")
            return
        try:
            with requests.get(stream_url, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
        except Exception as e:
            print(f"[Preview] Stream fetch failed for {video_id}: {e}")
