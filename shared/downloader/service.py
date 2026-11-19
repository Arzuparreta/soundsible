"""The download pool: its folder, its library.json, YouTube and the cloud."""

import json
import threading
from pathlib import Path
from typing import Optional

from shared.atomic_file import replace_contents
from shared.file_revision import FileRevision, publication_lock, read_revision
from shared.library_lifecycle import LibraryPersistenceError, serialized
from shared.models import LibraryMetadata
from shared.library_json import LibraryJSONWriter

from .cloud_sync import CloudSync
from .config import DEFAULT_QUALITY, LIBRARY_FILENAME
from .library_podcasts import read_podcast_fields
from .youtube_downloader import YouTubeDownloader

class Downloader:
    """The shared pool every account downloads into.

    Files land in `output_dir/tracks` under their content hash and are listed
    in the pool's own library.json; accounts then hold them by id.
    """

    def __init__(
        self,
        output_dir: Path,
        cookie_browser: Optional[str] = None,
        cookie_file: Optional[str] = None,
        quality: str = DEFAULT_QUALITY,
    ):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

        self.cloud = CloudSync(self.output_dir)
        self.library_path = self.output_dir / LIBRARY_FILENAME
        self.library = self._load_library()
        self.downloader = YouTubeDownloader(
            self.output_dir, cookie_browser=cookie_browser, cookie_file=cookie_file, quality=quality
        )

    @staticmethod
    def _empty_library():
        return LibraryMetadata(version=1, tracks=[], playlists={}, settings={})

    def _load_library(self) -> LibraryMetadata:
        with publication_lock(self.library_path):
            self._manifest, library = self._read_locked()
        return library if library is not None else self._empty_library()

    def read_snapshot(self):
        """An independent model/token for a long operation such as cloud sync."""
        with publication_lock(self.library_path):
            manifest, library = self._read_locked()
        if manifest is None:
            return self._empty_library(), None
        return library, manifest.digest

    def _read_locked(self, known=None):
        return read_revision(self.library_path, lambda text: LibraryMetadata.from_dict(json.load(text)), known=known)

    @serialized
    def commit_track(self, track) -> None:
        """Add acquired audio to the latest pool manifest, never a stale snapshot."""
        with self._lock, publication_lock(self.library_path):
            known = getattr(self, '_manifest', None)
            manifest, library = self._read_locked(known)
            if library is None:
                # A matching digest lets us keep the resident model. A removed
                # file is a new empty manifest, even if we had a model for it.
                library = getattr(self, 'library', None) if manifest == known else None
                if library is None:
                    library = self._empty_library()
            existing = library.get_track_by_hash(track.file_hash)
            if existing:
                library.remove_track(existing.id)
            library.add_track(track)
            self._publish_locked(library)

    @serialized
    def replace_snapshot(self, library, expected_revision):
        """Publish a long operation only against the exact snapshot it read.

        Podcast subscriptions and episodes belong to the Station. Read them
        from the same bytes checked against the expected revision.
        """
        with self._lock, publication_lock(self.library_path):
            manifest, podcasts = read_revision(self.library_path, self._read_podcasts)
            current = manifest.digest if manifest is not None else None
            if current != expected_revision:
                raise LibraryPersistenceError('library_conflict')
            if podcasts is not None:
                library.podcast_subscriptions, library.podcast_episode_cache = podcasts
            self._publish_locked(library)

    @staticmethod
    def _read_podcasts(stream):
        try:
            return read_podcast_fields(stream)
        except (TypeError, OverflowError, UnicodeError):
            # Valid but unsupported library data keeps the candidate fields.
            # Syntax errors use the reader's legacy empty podcast defaults.
            return None

    def _publish_locked(self, library):
        # Same portable bytes, encoded in bounded blocks and replaced under
        # the same directory lock as the Station's export.
        writer = LibraryJSONWriter(library)
        replace_contents(self.library_path, writer)
        self.library = library
        self._manifest = FileRevision(writer.digest.digest(), writer.size)
