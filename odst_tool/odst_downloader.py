"""ODST downloader: YouTube search + download + library + cloud."""

from pathlib import Path
from typing import Optional

import threading
import json
from shared.library_lifecycle import serialized, LibraryPersistenceError
from shared.file_revision import publication_lock, revision
from shared.atomic_file import replace_contents, text_pieces
from .config import DEFAULT_WORKERS, LIBRARY_FILENAME, DEFAULT_QUALITY
from .models import LibraryMetadata
from .library_podcasts import read_podcast_fields
from .youtube_downloader import YouTubeDownloader
from .cloud_sync import CloudSync


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
        self.library = self._load_library()
        self.downloader = YouTubeDownloader(
            self.output_dir, cookie_browser=cookie_browser, cookie_file=cookie_file, quality=quality
        )

    def _load_library(self) -> LibraryMetadata:
        library, token = self.read_snapshot()
        self._manifest_revision = token
        return library

    def read_snapshot(self):
        """An independent model/token for a long operation such as cloud sync."""
        with publication_lock(self.library_path):
            if self.library_path.exists():
                # Corrupt/unreadable state is not an empty library to overwrite.
                with self.library_path.open(encoding="utf-8") as stream:
                    library = LibraryMetadata.from_dict(json.load(stream))
            else:
                library = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
            return library, revision(self.library_path)

    @serialized
    def commit_track(self, track) -> None:
        """Add acquired audio to the latest pool manifest, never a stale snapshot."""
        with self._lock, publication_lock(self.library_path):
            if (not hasattr(self, 'library') or
                    revision(self.library_path) != getattr(self, '_manifest_revision', object())):
                self.library = self._load_library()
            existing = self.library.get_track_by_hash(track.file_hash)
            if existing:
                self.library.remove_track(existing.id)
            self.library.add_track(track)
            self._save_library_locked()

    @serialized
    def replace_snapshot(self, library, expected_revision):
        """Publish a long operation only against the exact snapshot it read."""
        with self._lock, publication_lock(self.library_path):
            if revision(self.library_path) != expected_revision:
                raise LibraryPersistenceError('library_conflict')
            previous = self.library, self._manifest_revision
            self.library, self._manifest_revision = library, expected_revision
            try:
                self._save_library_locked()
            except BaseException:
                self.library, self._manifest_revision = previous
                raise

    @serialized
    def save_library(self) -> None:
        with self._lock, publication_lock(self.library_path):
            self._save_library_locked()

    def _save_library_locked(self):
        current = revision(self.library_path)
        if hasattr(self, "_manifest_revision") and current != self._manifest_revision:
            raise LibraryPersistenceError("library_conflict")
        # Preserve podcast subscription metadata written by the Station API (same library.json).
        if self.library_path.exists():
            try:
                with open(self.library_path, "r") as rf:
                    subscriptions, cache = read_podcast_fields(rf)
                self.library.podcast_subscriptions = subscriptions
                self.library.podcast_episode_cache = cache
            except Exception:
                pass
        # Same portable bytes, without a second full JSON document in RAM.
        # Streamed into a temporary: the Station reads this file meanwhile.
        replace_contents(self.library_path, text_pieces(self.library.iter_json()))
        self._manifest_revision = revision(self.library_path)

    @serialized
    def add_track(self, track) -> None:
        with self._lock:
            self.library.add_track(track)
