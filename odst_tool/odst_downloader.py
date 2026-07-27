"""ODST downloader: YouTube search + download + library + cloud."""

from pathlib import Path
from typing import Optional

import threading
from .config import DEFAULT_WORKERS, LIBRARY_FILENAME, DEFAULT_COOKIE_BROWSER, DEFAULT_QUALITY
from .models import LibraryMetadata
from .youtube_downloader import YouTubeDownloader
from .cloud_sync import CloudSync
from shared.runtime import get_runtime_config


class ODSTDownloader:
    """YouTube search, download, library, and cloud sync. Used by the webapp."""

    def __init__(
        self,
        output_dir: Path,
        workers: int = DEFAULT_WORKERS,
        cookie_browser: Optional[str] = None,
        cookie_file: Optional[str] = None,
        quality: str = DEFAULT_QUALITY,
    ):
        self.output_dir = Path(output_dir)
        self.workers = workers
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

        self.cloud = CloudSync(self.output_dir)
        self.library_path = self.output_dir / LIBRARY_FILENAME
        self._portable = get_runtime_config().instance_dir is not None
        self._state_db = None
        if self._portable:
            from shared.database import instance_db

            self._state_db = instance_db()
        self.library = self._load_library()
        self.downloader = YouTubeDownloader(
            self.output_dir, cookie_browser=cookie_browser, cookie_file=cookie_file, quality=quality
        )

    def _load_library(self) -> LibraryMetadata:
        if self._portable:
            raw = self._state_db.get_instance_state("physical_catalog", None)
            if isinstance(raw, dict):
                return LibraryMetadata.from_dict(raw)
            return LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
        if self.library_path.exists():
            try:
                with open(self.library_path, "r") as f:
                    return LibraryMetadata.from_json(f.read())
            except Exception:
                pass
        return LibraryMetadata(
            version=1,
            tracks=[],
            playlists={},
            settings={},
        )

    def save_library(self) -> None:
        with self._lock:
            if self._portable:
                self._state_db.set_instance_state(
                    "physical_catalog",
                    {
                        "version": self.library.version,
                        "tracks": [track.to_dict() for track in self.library.tracks],
                        "playlists": self.library.playlists,
                        "settings": self.library.settings,
                        "last_updated": self.library.last_updated,
                        "podcast_subscriptions": self.library.podcast_subscriptions,
                        "podcast_episode_cache": self.library.podcast_episode_cache,
                    },
                )
                return
            # Preserve podcast subscription metadata written by the Station API (same library.json).
            if self.library_path.exists():
                try:
                    with open(self.library_path, "r") as rf:
                        disk = LibraryMetadata.from_json(rf.read())
                    self.library.podcast_subscriptions = disk.podcast_subscriptions
                    self.library.podcast_episode_cache = disk.podcast_episode_cache
                except Exception:
                    pass
            with open(self.library_path, "w") as f:
                f.write(self.library.to_json())

    def add_track(self, track) -> None:
        with self._lock:
            self.library.add_track(track)
