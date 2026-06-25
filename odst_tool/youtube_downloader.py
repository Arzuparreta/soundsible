import logging
import os
import shutil
import subprocess
import sys
import time
import re
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional, Dict, Any, List, Iterator, Callable
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

_FALSE_ENV_VALUES = {"0", "false", "no", "off"}
_YTDLP_SOCKET_TIMEOUT_DEFAULT = "30"
_YTDLP_HTTP_CHUNK_SIZE_DEFAULT = "10M"
_YTDLP_RETRY_SLEEP_DEFAULT = "exp=1:20"


def _yt_dlp_force_ipv4() -> bool:
    return (os.getenv("SOUNDSIBLE_YTDLP_FORCE_IPV4", "true") or "").strip().lower() not in _FALSE_ENV_VALUES


def _add_ytdlp_cli_network_args(args: List[str]) -> None:
    yt_proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
    if yt_proxy:
        args.extend(["--proxy", yt_proxy])
    elif _yt_dlp_force_ipv4():
        args.append("--force-ipv4")


def _ytdlp_download_resilience_args() -> List[str]:
    """Return bounded network settings for long-running yt-dlp downloads."""
    socket_timeout = (
        os.getenv("SOUNDSIBLE_YTDLP_SOCKET_TIMEOUT", _YTDLP_SOCKET_TIMEOUT_DEFAULT).strip()
        or _YTDLP_SOCKET_TIMEOUT_DEFAULT
    )
    http_chunk_size = (
        os.getenv("SOUNDSIBLE_YTDLP_HTTP_CHUNK_SIZE", _YTDLP_HTTP_CHUNK_SIZE_DEFAULT).strip()
        or _YTDLP_HTTP_CHUNK_SIZE_DEFAULT
    )
    retry_sleep = (
        os.getenv("SOUNDSIBLE_YTDLP_RETRY_SLEEP", _YTDLP_RETRY_SLEEP_DEFAULT).strip()
        or _YTDLP_RETRY_SLEEP_DEFAULT
    )
    return [
        "--socket-timeout",
        socket_timeout,
        "--http-chunk-size",
        http_chunk_size,
        "--retry-sleep",
        f"http:{retry_sleep}",
        "--retry-sleep",
        f"fragment:{retry_sleep}",
    ]


def _should_retry_download_with_cookies(output: str) -> bool:
    lowered = (output or "").lower()
    return any(
        marker in lowered
        for marker in (
            "requested format is not available",
            "the page needs to be reloaded",
            "sign in to confirm",
            "confirm your age",
            "age-restricted",
            "this video is private",
            "http error 403",
        )
    )


def _apply_ytdlp_network_options(opts: Dict[str, Any]) -> Dict[str, Any]:
    from shared.ffmpeg_runtime import apply_ytdlp_ffmpeg_options

    yt_proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
    if yt_proxy:
        opts["proxy"] = yt_proxy
    elif _yt_dlp_force_ipv4():
        opts["source_address"] = "0.0.0.0"
    apply_ytdlp_ffmpeg_options(opts)
    return opts


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


def _is_garbage_embedded_title(value: Any) -> bool:
    """True if tags look like a placeholder (e.g. yt-dlp parse-metadata mistakes)."""
    if value is None:
        return True
    t = str(value).strip().lower()
    if not t:
        return True
    return t in (
        "title",
        "track",
        "unknown",
        "unknown title",
        "audio",
        "video",
        "untitled",
    )


def _strip_hint_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


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

# Prefer audio-only streams. If YouTube exposes only a progressive stream, choose
# the smallest audio-bearing fallback instead of an unnecessarily large video.
YDL_FORMAT_AUDIO = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]"

_YTDLP_PROGRESS_LINE = re.compile(
    r"\[download\]\s+(?P<pct>\d+\.?\d*)%\s+of\s+(?:~\s*)?(?P<total>[\d.]+)(?P<tunit>[KMGT]?i?B)"
    r"(?:\s+at\s+(?P<speed>\S+))?(?:\s+ETA\s+(?P<eta>\S+))?",
    re.IGNORECASE,
)
# Note: Some yt-dlp builds use "100% of 3.21MiB in 00:05" (no at/ETA on that line).
_YTDLP_PROGRESS_IN = re.compile(
    r"\[download\]\s+(?P<pct>\d+\.?\d*)%\s+of\s+(?:~\s*)?(?P<total>[\d.]+)(?P<tunit>[KMGT]?i?B)\s+in\s+",
    re.IGNORECASE,
)


def _size_str_to_bytes(amount: str, unit: str) -> Optional[int]:
    try:
        v = float(amount)
    except (TypeError, ValueError):
        return None
    u = (unit or "").strip().upper().replace("İ", "I")
    if u in ("B",):
        return int(v)
    if u in ("KIB", "KB"):
        return int(v * 1024)
    if u in ("MIB", "MB"):
        return int(v * 1024**2)
    if u in ("GIB", "GB"):
        return int(v * 1024**3)
    if u in ("TIB", "TB"):
        return int(v * 1024**4)
    return None


def _parse_ytdlp_download_progress(line: str) -> Optional[Dict[str, Any]]:
    if "[ExtractAudio]" in line or "[Metadata]" in line or "[Merger]" in line:
        return {"phase": "processing"}
    if "Post-processing" in line:
        return {"phase": "processing"}
    m = _YTDLP_PROGRESS_LINE.search(line)
    speed = None
    eta = None
    if m:
        speed = m.group("speed")
        eta = m.group("eta")
    else:
        m = _YTDLP_PROGRESS_IN.search(line)
    if not m:
        return None
    pct = float(m.group("pct"))
    total_b = _size_str_to_bytes(m.group("total"), m.group("tunit"))
    out: Dict[str, Any] = {
        "phase": "downloading",
        "percent": min(100.0, max(0.0, pct)),
        "speed": speed.strip() if speed else None,
        "eta": eta.strip() if eta else None,
    }
    if total_b is not None:
        out["total_bytes"] = total_b
    return out


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
                    logger.debug("Auto-detected cookies at %s", self.cookie_file)
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
            logger.warning("Error processing downloaded file %s: %s", metadata.get("title", "unknown"), e)
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

    def process_video(
        self,
        url: str,
        metadata_hint: Optional[Dict[str, Any]] = None,
        source: str = "youtube_url",
        progress_callback: Optional[Callable[..., None]] = None,
    ) -> Optional[Track]:
        """
        Process a direct YouTube URL. Single yt-dlp run (download only), then read metadata from file.
        Matches CLI behavior: one format selection, one download.
        """
        if progress_callback:
            try:
                progress_callback({"phase": "preparing"})
            except Exception:
                pass
        temp_file = self._download_audio(url, progress_callback=progress_callback)
        if not temp_file or not temp_file.exists():
            raise Exception("Download failed: Audio file was not created by yt-dlp. Check if ffmpeg is installed.")

        try:
            if progress_callback:
                try:
                    progress_callback({"phase": "processing", "percent": 92.0})
                except Exception:
                    pass
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            video_id = _extract_video_id_from_url(url)
            clean_meta = AudioProcessor.get_metadata_from_file(str(temp_file))
            if _is_garbage_embedded_title(clean_meta.get("title")):
                clean_meta["title"] = ""
            if _is_garbage_embedded_title(clean_meta.get("artist")):
                clean_meta["artist"] = ""
            clean_meta.setdefault('album', '')
            clean_meta.setdefault('duration_sec', duration or 0)
            clean_meta.setdefault('track_number', 1)
            if isinstance(metadata_hint, dict):
                ht = _strip_hint_str(metadata_hint.get("title"))
                if ht and not _is_garbage_embedded_title(ht):
                    clean_meta["title"] = ht
                ha = _strip_hint_str(metadata_hint.get("artist"))
                hc = _strip_hint_str(metadata_hint.get("channel"))
                artist_hint = ha or hc
                if artist_hint:
                    clean_meta["artist"] = artist_hint
                if metadata_hint.get("duration_sec") is not None:
                    clean_meta["duration_sec"] = metadata_hint["duration_sec"]
                if metadata_hint.get("album") is not None:
                    alb = _strip_hint_str(metadata_hint.get("album"))
                    clean_meta["album"] = alb
            if _is_garbage_embedded_title(clean_meta.get("title")) or _is_garbage_embedded_title(
                clean_meta.get("artist")
            ):
                peek = self._peek_video_metadata(url)
                if peek:
                    pt = _strip_hint_str(peek.get("track") or peek.get("title"))
                    if pt and not _is_garbage_embedded_title(pt):
                        clean_meta["title"] = pt
                    pa = _strip_hint_str(
                        peek.get("artist") or peek.get("channel") or peek.get("uploader") or ""
                    )
                    if pa and (_is_garbage_embedded_title(clean_meta.get("artist")) or not clean_meta.get("artist")):
                        clean_meta["artist"] = pa
                    if not clean_meta.get("album") and peek.get("album"):
                        clean_meta["album"] = _strip_hint_str(peek.get("album"))
            clean_meta.setdefault('title', 'Unknown Title')
            clean_meta.setdefault('artist', 'Unknown Artist')
            clean_meta.setdefault('album', '')
            clean_meta.setdefault('duration_sec', duration or 0)
            clean_meta.setdefault('track_number', 1)

            try:
                AudioProcessor.embed_metadata(
                    str(temp_file),
                    clean_meta,
                    _yt_thumbnail_url(video_id),
                )
            except Exception as e:
                logger.warning("Could not re-embed metadata on downloaded file: %s", e)

            try:
                size = os.path.getsize(str(temp_file))
            except OSError:
                pass

            if progress_callback:
                try:
                    progress_callback({"phase": "processing", "percent": 97.0})
                except Exception:
                    pass
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            shutil.move(str(temp_file), str(final_path))

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

    def finalize_local_audio_file(
        self,
        temp_file: Path,
        clean_meta: Dict[str, Any],
        *,
        cover_art_url: Optional[str] = None,
        youtube_id: Optional[str] = None,
        cover_source: str = "manual",
    ) -> Optional[Track]:
        """Process an already-downloaded audio file (e.g. podcast enclosure) into a library Track."""
        if not temp_file or not temp_file.exists():
            return None
        clean_meta = dict(clean_meta or {})
        clean_meta.setdefault("title", "Unknown Title")
        clean_meta.setdefault("artist", "Unknown Artist")
        clean_meta.setdefault("album", "")
        clean_meta.setdefault("duration_sec", 0)
        clean_meta.setdefault("track_number", 1)
        try:
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            try:
                AudioProcessor.embed_metadata(
                    str(temp_file),
                    clean_meta,
                    cover_art_url,
                )
            except Exception as e:
                logger.warning("Could not embed metadata on local file: %s", e)
            try:
                size = os.path.getsize(str(temp_file))
            except OSError:
                pass
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = (temp_file.suffix[1:] or "mp3").lower()
            if not extension:
                extension = "mp3"
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            shutil.move(str(temp_file), str(final_path))
            return Track(
                id=file_hash,
                title=clean_meta["title"],
                artist=clean_meta["artist"],
                album=clean_meta.get("album") or "",
                album_artist=clean_meta.get("album_artist"),
                duration=duration if duration > 0 else int(clean_meta.get("duration_sec") or 0),
                file_hash=file_hash,
                original_filename=f"{clean_meta['artist']} - {clean_meta['title']}.{extension}",
                compressed=(self.quality != "ultra"),
                file_size=size,
                bitrate=bitrate,
                format=extension,
                year=clean_meta.get("year"),
                genre=clean_meta.get("genre"),
                track_number=clean_meta.get("track_number") or 1,
                is_local=True,
                local_path=None,
                musicbrainz_id=None,
                isrc=None,
                cover_source=cover_source,
                metadata_modified_by_user=False,
                youtube_id=youtube_id,
                media_kind=clean_meta.get("media_kind"),
                podcast_feed_id=clean_meta.get("podcast_feed_id"),
                podcast_episode_guid=clean_meta.get("podcast_episode_guid"),
                podcast_rss_url=clean_meta.get("podcast_rss_url"),
            )
        except Exception as e:
            if temp_file.exists():
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            logger.error("finalize_local_audio_file failed: %s", e)
            return None

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
        _apply_ytdlp_network_options(ydl_opts)
        
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
                        logger.debug("Found match: %s (Score: %.2f)", best_match.get("title"), highest_score)
                        return best_match
                        
                except Exception as e:
                    logger.warning("Search error for %s: %s", query, e)
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

    def _download_audio(
        self, url: str, progress_callback: Optional[Callable[..., None]] = None
    ) -> Optional[Path]:
        """Download via yt-dlp CLI (subprocess).

        Strategy: try native audio first (no re-encode — faster, fewer failures
        with non-standard YouTube videos). Only re-encode if the native attempt
        fails or the quality profile explicitly demands a specific codec.
        """
        import time
        temp_filename = f"temp_{os.getpid()}_{time.time_ns()}_{uuid.uuid4().hex[:6]}"
        output_template = str(self.temp_dir / f"{temp_filename}.%(ext)s")
        profile = QUALITY_PROFILES.get(self.quality, QUALITY_PROFILES[DEFAULT_QUALITY])

        def _build_args(native: bool = False) -> list[str]:
            args = [
                get_subprocess_python(), "-u", "-m", "yt_dlp",
                "-f", YDL_FORMAT_AUDIO,
            ]
            if not native:
                codec = profile['format'] if profile['format'] != 'best' else 'flac'
                args.extend(["-x", "--audio-format", codec])
                if profile.get('bitrate', 0) > 0 and codec == 'mp3':
                    args.extend(["--audio-quality", str(profile['bitrate'])])
            _add_ytdlp_cli_network_args(args)
            args.extend(_ytdlp_download_resilience_args())
            args.extend([
                "--extractor-args", "youtube:player_client=android,ios,web",
                "--add-metadata",
                "--embed-thumbnail",
                "--parse-metadata", "playlist_index:%(track_number)s",
                "-o", output_template,
                "--retries", "10",
                "--no-warnings",
                "--newline",
                "--progress",
            ])
            return args

        cookie_args = []
        if self.cookie_file and os.path.exists(self.cookie_file):
            cookie_args = ["--cookies", self.cookie_file]
        elif self.cookie_browser:
            cookie_args = ["--cookies-from-browser", self.cookie_browser]

        def _with_cookie_args(args_list):
            if not cookie_args:
                return list(args_list)
            return [*args_list[:-1], *cookie_args, args_list[-1]]

        def _run_stream(args_list):
            combined_chunks = []
            proc = subprocess.Popen(
                args_list,
                cwd=str(self.temp_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
            try:
                if proc.stdout:
                    for line in proc.stdout:
                        combined_chunks.append(line)
                        if progress_callback:
                            try:
                                parsed = _parse_ytdlp_download_progress(line.rstrip())
                                if parsed:
                                    progress_callback(parsed)
                            except Exception as ex:
                                logger.debug("progress_callback error: %s", ex)
                proc.wait(timeout=600)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except OSError:
                    pass
                raise
            return proc.returncode, "".join(combined_chunks)

        # — Attempt 1: native audio (no re-encode) — fastest, most reliable —
        native_args = _build_args(native=True) + [url]
        returncode, combined_output = _run_stream(native_args)
        if returncode == 0:
            ext = None
            for f in self.temp_dir.glob(f"{temp_filename}.*"):
                return f
            # yt-dlp sometimes names with a different extension; try common ones
            for ext in ("m4a", "webm", "opus", "mp3", "ogg", "aac"):
                p = self.temp_dir / f"{temp_filename}.{ext}"
                if p.exists():
                    return p

        # — Attempt 2: cookies (native) —
        if returncode != 0 and cookie_args and _should_retry_download_with_cookies(combined_output):
            returncode, combined_output = _run_stream(_with_cookie_args(native_args))
            if returncode == 0:
                for f in self.temp_dir.glob(f"{temp_filename}.*"):
                    return f

        # — Attempt 3: re-encode (with -x, cookies if available) —
        encode_args = _build_args(native=False) + [url]
        final_args = _with_cookie_args(encode_args) if cookie_args else encode_args
        returncode, combined_output = _run_stream(final_args)
        if returncode == 0:
            for f in self.temp_dir.glob(f"{temp_filename}.*"):
                return f

        # — All attempts exhausted —
        raise Exception(combined_output or f"yt-dlp exited {returncode}")

    def _peek_video_metadata(self, url: str) -> Dict[str, Any]:
        """Single extract_info (no download) to recover title/artist when embedded tags are wrong.

        Try without cookies first: browser cookie jars can make yt-dlp fail format resolution for
        metadata-only extracts ("Requested format is not available") while public URLs work anonymously.
        Fall back to cookies.txt then browser cookies for age-restricted / signed-in cases.
        """
        base: Dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": {"youtube": {"player_client": ["android", "ios", "web"]}},
        }
        _apply_ytdlp_network_options(base)
        attempts: List[Dict[str, Any]] = [dict(base)]
        if self.cookie_file and os.path.exists(self.cookie_file):
            attempts.append({**base, "cookiefile": self.cookie_file})
        if self.cookie_browser:
            attempts.append({**base, "cookiesfrombrowser": (self.cookie_browser, None, None, None)})
        last_err: Optional[Exception] = None
        for opts in attempts:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                if isinstance(info, dict) and info:
                    return info
            except Exception as e:
                last_err = e
                logger.debug("peek_video_metadata attempt failed for %s: %s", url, e)
        if last_err:
            logger.warning("peek_video_metadata failed for %s: %s", url, last_err)
        return {}

    def peek_brief(self, url_or_id: str) -> Optional[Dict[str, Any]]:
        """Lightweight YouTube metadata for UI (no download). Same general shape as search_youtube rows."""
        raw = (url_or_id or "").strip()
        if not raw:
            return None
        if raw.startswith("http://") or raw.startswith("https://"):
            url = raw
        elif _is_valid_youtube_video_id(raw):
            url = f"https://www.youtube.com/watch?v={raw}"
        else:
            return None
        info = self._peek_video_metadata(url)
        if not info:
            return None
        vid_raw = info.get("id") or _extract_video_id_from_url(url)
        vid_s = str(vid_raw).strip() if vid_raw is not None else ""
        title = (info.get("track") or info.get("title") or "").strip() or "Unknown"
        raw_creator = info.get("artist") or info.get("channel") or info.get("uploader")
        if raw_creator is None:
            channel = ""
        elif isinstance(raw_creator, str):
            channel = raw_creator.strip()
        elif isinstance(raw_creator, (list, tuple)):
            channel = ", ".join(str(x) for x in raw_creator if x).strip()
        else:
            channel = str(raw_creator).strip()
        duration = int(info.get("duration") or 0)
        thumb = (info.get("thumbnail") or "").strip()
        if not thumb and vid_s and _is_valid_youtube_video_id(vid_s):
            thumb = _yt_thumbnail_url(vid_s) or ""
        webpage = (info.get("webpage_url") or "").strip()
        if vid_s and _is_valid_youtube_video_id(vid_s):
            webpage = f"https://www.youtube.com/watch?v={vid_s}"
        elif not webpage:
            webpage = url
        out_id = vid_s if _is_valid_youtube_video_id(vid_s) else vid_raw
        return {
            "id": out_id,
            "title": title,
            "duration": duration,
            "thumbnail": thumb,
            "webpage_url": webpage,
            "channel": channel,
            "artist": channel,
        }

    def search_youtube(
        self,
        query: str,
        max_results: int = 10,
        use_ytmusic: bool = True,
        enrich_missing: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Search YouTube or YouTube Music with plain text. Returns yt-dlp-derived dicts:
        id, title, duration, thumbnail, webpage_url, channel, artist (same value from
        channel, uploader, or artist — whichever yt-dlp provides).
        No filtering — pass-through for UI; a proper search layer can be added later.
        use_ytmusic=True: https://music.youtube.com/search?q=...#songs with extract_flat
        (fast; channel/artist may be empty). Full per-video extract was very slow (~tens of
        seconds) and often set url= relative paths that broke clients expecting absolute
        watch URLs. No cookies on this path; downloads still use cookies elsewhere.
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
        _apply_ytdlp_network_options(ydl_opts)
        if use_ytmusic:
            ydl_opts['extract_flat'] = True
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
            vid_s = str(video_id).strip()
            if _is_valid_youtube_video_id(vid_s):
                webpage_url = f"https://www.youtube.com/watch?v={vid_s}"
            else:
                raw = (entry.get('webpage_url') or entry.get('url') or '').strip()
                if raw.startswith('http://') or raw.startswith('https://'):
                    webpage_url = raw
                elif raw.startswith('/'):
                    webpage_url = f"https://www.youtube.com{raw}"
                elif raw:
                    webpage_url = f"https://www.youtube.com/{raw.lstrip('/')}"
                else:
                    webpage_url = f"https://www.youtube.com/watch?v={vid_s}"
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

        def enrich_missing_creators(items: List[Dict[str, Any]]) -> None:
            missing = [
                item
                for item in items
                if not (item.get("artist") or item.get("channel") or "").strip()
                and _is_valid_youtube_video_id(str(item.get("id") or "").strip())
            ]
            if not missing:
                return

            def fetch_brief(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
                try:
                    return self.peek_brief(str(item.get("id") or ""))
                except Exception as exc:
                    logger.debug("YouTube Music search metadata enrichment failed for %s: %s", item.get("id"), exc)
                    return None

            max_workers = min(4, len(missing))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {executor.submit(fetch_brief, item): item for item in missing}
                for future in as_completed(futures):
                    item = futures[future]
                    brief = future.result()
                    if not brief:
                        continue
                    creator = (brief.get("artist") or brief.get("channel") or "").strip()
                    if creator:
                        item["artist"] = creator
                        item["channel"] = creator
                    if not item.get("duration"):
                        item["duration"] = brief.get("duration") or 0
                    if not item.get("thumbnail"):
                        item["thumbnail"] = brief.get("thumbnail") or item.get("thumbnail") or ""

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
            if use_ytmusic and enrich_missing:
                enrich_missing_creators(out)
        except Exception as e:
            logger.warning("YouTube search error (use_ytmusic=%s): %s", use_ytmusic, e)
            # Note: No silent fallback -- let the caller decide or propagate the error
            raise e
        return out

    def get_related_videos(self, seed_video_id: str, max_results: int = 25) -> List[Dict[str, Any]]:
        """
        Fetch related/mix videos for a seed from YouTube.
        Tries the fastest approach first (search by metadata), then falls back
        to the RD mix playlist extraction.

        Returns same shape as search_youtube: id, title, duration, thumbnail, webpage_url, channel, artist.
        """
        if not _is_valid_youtube_video_id(seed_video_id):
            return []

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

        def _try_extract(ydl_opts: dict, url: str) -> List[Dict[str, Any]]:
            out = []
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(url, download=False)
            if not result or 'entries' not in result:
                logger.debug(
                    "[Discover] get_related_videos: no entries in result (keys: %s)",
                    list(result.keys()) if result else "None",
                )
                return []
            raw_entries = result['entries']
            if raw_entries is None:
                return []
            entries_list = list(raw_entries) if not isinstance(raw_entries, list) else raw_entries
            for entry in entries_list[:max_results]:
                item = to_item(entry)
                if item is not None:
                    out.append(item)
            return out

        base_opts = {
            'quiet': True,
            'no_warnings': True,
            'socket_timeout': 12,
            'extractor_args': {
                'youtube': {'player_client': ['android', 'ios', 'web']}
            }
        }
        _apply_ytdlp_network_options(base_opts)
        if self.cookie_file and os.path.exists(self.cookie_file):
            base_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            base_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

        # — Attempt 1 (fastest): YouTube Music search by video metadata —
        try:
            info = self._peek_video_metadata(f"https://www.youtube.com/watch?v={seed_video_id}")
            if info:
                raw_title = info.get('track') or info.get('title') or ''
                raw_artist = info.get('artist') or info.get('channel') or info.get('uploader') or ''
                title = str(raw_title).strip()
                artist = str(raw_artist).strip() if isinstance(raw_artist, (str, list, tuple)) else ''
                if isinstance(artist, (list, tuple)):
                    artist = ', '.join(str(x) for x in artist if x)
                query = f"{title} {artist}".strip()
                if query:
                    results = self.search_youtube(query, max_results=max_results, use_ytmusic=True)
                    results = [r for r in results if str(r.get('id', '')) != seed_video_id]
                    if results:
                        return results
        except Exception as e:
            logger.debug("[Discover] get_related_videos search fallback failed: %s", e)

        # — Attempt 2: RD mix playlist (flat extraction) —
        mix_url = f"https://www.youtube.com/watch?v={seed_video_id}&list=RD{seed_video_id}&start_radio=1"
        opts_flat = {**base_opts, 'extract_flat': 'in_playlist', 'noplaylist': False}
        try:
            results = _try_extract(opts_flat, mix_url)
            if results:
                return results
        except Exception as e:
            logger.debug("[Discover] get_related_videos RD flat failed: %s", e)

        # — Attempt 3: RD mix without flat extraction (full) —
        opts_full = {**base_opts, 'noplaylist': False}
        try:
            results = _try_extract(opts_full, mix_url)
            if results:
                return results
        except Exception as e:
            logger.debug("[Discover] get_related_videos RD full failed: %s", e)

        return []

    def get_stream_url(self, video_id: str) -> Optional[str]:
        """Return direct audio stream URL via yt-dlp CLI (-g)."""
        if not video_id or not str(video_id).strip():
            return None
        yt_url = f"https://www.youtube.com/watch?v={video_id}"

        def _try(args_list: List[str], timeout: int = 30) -> Optional[str]:
            try:
                result = subprocess.run(args_list, capture_output=True, text=True, timeout=timeout)
                rc, out, err = result.returncode, result.stdout or "", result.stderr or ""
                combined = (err or "") + (out or "")
                if rc == 0:
                    line = (out or "").strip().splitlines()
                    url = line[0] if line else None
                    if url:
                        return url
                if "Requested format is not available" in combined:
                    return None
                if "Sign in to confirm" in combined:
                    return None
                logger.warning("[Preview] yt-dlp failed for %s: rc=%s stderr=%s", video_id, rc, (combined.strip() or "no stderr")[:300])
                return "__ERROR__"
            except subprocess.TimeoutExpired:
                return None

        common = [
            get_subprocess_python(), "-m", "yt_dlp", "-g",
            "-f", YDL_FORMAT_AUDIO, "--no-warnings", "--quiet",
        ]

        # Attempt 1: HTTP proxy (SOUNDSIBLE_YT_PROXY env var)
        # Routes yt-dlp through a residential IP (e.g. Tailscale desktop).
        yt_proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "")
        if yt_proxy:
            result = _try(common + ["--proxy", yt_proxy, yt_url], timeout=90)
            if result == "__ERROR__":
                return None
            if result:
                return result

        # Attempt 2: cookies via IPv6
        if self.cookie_file and os.path.exists(self.cookie_file):
            result = _try(common + ["-6", "--cookies", self.cookie_file, yt_url])
            if result == "__ERROR__":
                return None
            if result:
                return result

        # Attempt 3: Android client via IPv4 (residential IPs, direct)
        result = _try(common + ["--force-ipv4", "--extractor-args", "youtube:player_client=android,ios", yt_url])
        if result == "__ERROR__":
            return None
        if result:
            return result

        # Attempt 4: cookies via IPv4
        if self.cookie_file and os.path.exists(self.cookie_file):
            result = _try(common + ["--force-ipv4", "--cookies", self.cookie_file, yt_url])
            if result == "__ERROR__":
                return None
            if result:
                return result

        logger.warning("[Preview] All attempts failed for %s.", video_id)
        return None
        yt_url = f"https://www.youtube.com/watch?v={video_id}"

        def _run(args_list: List[str]) -> tuple[int, str, str]:
            result = subprocess.run(args_list, capture_output=True, text=True, timeout=30)
            return result.returncode, result.stdout or "", result.stderr or ""

        def _try_ytdlp(args_list: List[str]) -> Optional[str]:
            try:
                rc, out, err = _run(args_list)
                combined = (err or "") + (out or "")
                if rc == 0:
                    line = (out or "").strip().splitlines()
                    url = line[0] if line else None
                    if url:
                        return url
                # Recoverable: try next strategy
                if "Requested format is not available" in combined:
                    return None
                if "Sign in to confirm" in combined:
                    return None
                logger.warning("[Preview] yt-dlp -g failed for %s: rc=%s stderr=%s", video_id, rc, (combined.strip() or "no stderr")[:300])
                return "__ERROR__"
            except subprocess.TimeoutExpired:
                return None

        common = [
            get_subprocess_python(), "-m", "yt_dlp", "-g",
            "-f", YDL_FORMAT_AUDIO, "--no-warnings", "--quiet",
        ]

        # Attempt 1: cookies via IPv6 (matches cookie origin — VPS)
        if self.cookie_file and os.path.exists(self.cookie_file):
            result = _try_ytdlp(common + ["-6", "--cookies", self.cookie_file, yt_url])
            if result == "__ERROR__":
                return None
            if result:
                return result

        # Attempt 2: Android client via IPv4 (residential IPs, sometimes VPS)
        result = _try_ytdlp(common + ["--force-ipv4", "--extractor-args", "youtube:player_client=android,ios", yt_url])
        if result == "__ERROR__":
            return None
        if result:
            return result

        # Attempt 3: cookies via IPv4 (fallback)
        if self.cookie_file and os.path.exists(self.cookie_file):
            result = _try_ytdlp(common + ["--force-ipv4", "--cookies", self.cookie_file, yt_url])
            if result == "__ERROR__":
                return None
            if result:
                return result

        # Attempt 4: Tor SOCKS5 proxy (bypasses datacenter IP blocks)
        result = _try_ytdlp(common + ["--proxy", "socks5://127.0.0.1:9050", yt_url])
        if result == "__ERROR__":
            return None
        if result:
            return result

        logger.warning("[Preview] All resolution methods failed for %s", video_id)
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
            logger.debug("[Preview] No stream URL for %s; response will be empty", video_id)
            return
        try:
            with requests.get(stream_url, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
        except Exception as e:
            logger.warning("[Preview] Stream fetch failed for %s: %s", video_id, e)
