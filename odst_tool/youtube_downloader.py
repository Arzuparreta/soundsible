"""The engine's handle on YouTube: one output folder, one set of cookies.

The work lives in `odst_tool.youtube`; this class binds it to where files
go and which cookies to use, and acquires tracks from search, from a video
or from a file already on disk.
"""

import logging
import os
import random
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from shared.constants import DEFAULT_CONFIG_DIR
from shared.models import Track
from shared.stream_resolution import ResolvedStream

from .audio_utils import AudioProcessor
from .config import DEFAULT_OUTPUT_DIR, DEFAULT_QUALITY, DOWNLOAD_DELAY_RANGE, TRACKS_DIR
from .youtube import download, search, streams
from .youtube.ids import is_valid_video_id, video_id_from_url
from .youtube.tracks import store_track, video_metadata, with_canonical_mbid
from .youtube.ytdlp import Cookies

logger = logging.getLogger(__name__)


class YouTubeDownloader:
    """Searches, streams and downloads from YouTube into one library folder."""

    def __init__(
        self,
        output_dir: Path = DEFAULT_OUTPUT_DIR,
        cookie_browser: Optional[str] = None,
        cookie_file: Optional[str] = None,
        quality: str = DEFAULT_QUALITY,
    ):
        self.output_dir = output_dir
        self.tracks_dir = output_dir / TRACKS_DIR
        self.tracks_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir = output_dir / "temp"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.cookie_browser = cookie_browser
        self.cookie_file = cookie_file
        self.quality = quality

        if not self.cookie_file and not self.cookie_browser:
            detected = Path(DEFAULT_CONFIG_DIR).expanduser() / "cookies.txt"
            if detected.exists():
                self.cookie_file = str(detected)
                logger.debug("Auto-detected cookies at %s", self.cookie_file)

    @property
    def cookies(self) -> Cookies:
        return Cookies(file=self.cookie_file, browser=self.cookie_browser)

    # Finding and resolving

    def search_youtube(
        self,
        query: str,
        max_results: int = 10,
        use_ytmusic: bool = True,
        enrich_missing: bool = True,
    ) -> List[Dict[str, Any]]:
        return search.search_youtube(
            query, self.cookies,
            max_results=max_results, use_ytmusic=use_ytmusic, enrich_missing=enrich_missing,
        )

    def search_match_candidates(self, artist: str, title: str, max_results: int = 8) -> List[Dict[str, Any]]:
        return search.search_match_candidates(artist, title, self.cookies, max_results=max_results)

    def get_related_videos(self, seed_video_id: str, max_results: int = 25, enrich: bool = True) -> List[Dict[str, Any]]:
        return search.get_related_videos(seed_video_id, self.cookies, max_results=max_results, enrich=enrich)

    def peek_brief(self, url_or_id: str) -> Optional[Dict[str, Any]]:
        return search.peek_brief(url_or_id, self.cookies)

    def get_resolved_stream(self, video_id: str, *, skip_fast_path: bool = False) -> Optional[ResolvedStream]:
        return streams.get_resolved_stream(video_id, self.cookies, skip_fast_path=skip_fast_path)

    # Acquiring

    def _download_audio(self, url: str, progress_callback: Optional[Callable[..., None]] = None) -> Path:
        return download.download_audio(url, self.temp_dir, self.cookies, self.quality, progress_callback)

    def _store(self, temp_file: Path, meta: Dict[str, Any], duration: int, bitrate: int, *,
               youtube_id: Optional[str], cover_source: Optional[str]) -> Track:
        return store_track(
            temp_file, meta, self.tracks_dir,
            duration=duration, bitrate=bitrate, compressed=(self.quality != "ultra"),
            youtube_id=youtube_id, cover_source=cover_source,
        )

    def process_track(self, metadata: Dict[str, Any]) -> Optional[Track]:
        """Search for a song by artist and title, then download the best match."""
        meta = dict(metadata or {})
        meta.setdefault("title", "Unknown Title")
        meta.setdefault("artist", "Unknown Artist")
        meta.setdefault("album", "")
        with_canonical_mbid(meta)

        video_info = search.find_track(meta, self.cookies)
        if not video_info:
            return None
        time.sleep(random.uniform(*DOWNLOAD_DELAY_RANGE))
        temp_file = self._download_audio(video_info.get("webpage_url") or video_info.get("url"))
        try:
            AudioProcessor.embed_metadata(str(temp_file), meta, meta.get("album_art_url"))
            duration, bitrate, _size = AudioProcessor.get_audio_details(str(temp_file))
            video_id = video_info.get("id")
            return self._store(
                temp_file, meta, duration, bitrate,
                youtube_id=video_id if is_valid_video_id(video_id) else None,
                cover_source=meta.get("cover_source"),
            )
        except Exception as e:
            logger.warning("Error processing downloaded file %s: %s", meta.get("title", "unknown"), e)
            if temp_file.exists():
                os.remove(temp_file)
            return None

    def process_video(
        self,
        url: str,
        metadata_hint: Optional[Dict[str, Any]] = None,
        progress_callback: Optional[Callable[..., None]] = None,
    ) -> Optional[Track]:
        """Download one YouTube video and read what it is from the file itself."""
        def report(update: Dict[str, Any]) -> None:
            if progress_callback:
                try:
                    progress_callback(update)
                except Exception:
                    pass

        report({"phase": "preparing"})
        temp_file = self._download_audio(url, progress_callback=progress_callback)
        if not temp_file.exists():
            raise Exception("Download failed: Audio file was not created by yt-dlp. Check if ffmpeg is installed.")

        try:
            report({"phase": "processing", "percent": 92.0})
            duration, bitrate, _size = AudioProcessor.get_audio_details(str(temp_file))
            meta = video_metadata(
                AudioProcessor.get_metadata_from_file(str(temp_file)),
                metadata_hint,
                duration,
                peek=lambda: search.peek_video_metadata(url, self.cookies),
            )
            try:
                # No cover URL: keep the artwork yt-dlp embedded; mqdefault would replace it.
                AudioProcessor.embed_metadata(str(temp_file), meta, None)
            except Exception as e:
                logger.warning("Could not re-embed metadata on downloaded file: %s", e)
            report({"phase": "processing", "percent": 97.0})
            meta["track_number"] = meta.get("track_number") or 1
            return self._store(
                temp_file, meta, duration, bitrate,
                youtube_id=video_id_from_url(url), cover_source="youtube",
            )
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
        meta = dict(clean_meta or {})
        meta.setdefault("title", "Unknown Title")
        meta.setdefault("artist", "Unknown Artist")
        meta.setdefault("album", "")
        meta.setdefault("duration_sec", 0)
        meta.setdefault("track_number", 1)
        with_canonical_mbid(meta)
        try:
            duration, bitrate, _size = AudioProcessor.get_audio_details(str(temp_file))
            try:
                AudioProcessor.embed_metadata(str(temp_file), meta, cover_art_url)
            except Exception as e:
                logger.warning("Could not embed metadata on local file: %s", e)
            meta["track_number"] = meta.get("track_number") or 1
            return self._store(
                temp_file, meta, duration, bitrate,
                youtube_id=youtube_id, cover_source=cover_source,
            )
        except Exception as e:
            if temp_file.exists():
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            logger.error("finalize_local_audio_file failed: %s", e)
            return None
