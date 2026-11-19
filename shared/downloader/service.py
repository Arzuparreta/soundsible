"""The download pool: its folder, its library.json, YouTube and the cloud."""

import json
import threading
from pathlib import Path
from typing import Optional

from shared.atomic_file import replace_contents
from shared.file_revision import publication_lock, revision, signature
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

    def _load_library(self) -> LibraryMetadata:
        library, token = self.read_snapshot()
        self._manifest_revision = token
        return library

    def read_snapshot(self):
        """An independent model/token for a long operation such as cloud sync."""
        with publication_lock(self.library_path) as generation:
            return self._read_locked(generation)

    def _read_locked(self, generation):
        seen = signature(self.library_path)
        if self.library_path.exists():
            # Corrupt/unreadable state is not an empty library to overwrite.
            with self.library_path.open(encoding="utf-8") as stream:
                library = LibraryMetadata.from_dict(json.load(stream))
        else:
            library = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
        token = revision(self.library_path)
        self._known = generation, seen, token
        return library, token

    def _revision_locked(self, generation):
        """The manifest's content digest, reading its bytes only if they may have changed.

        `_known` is what this pool last saw under the publication lock. If no
        other hold came between that one and this one, no cooperating writer
        (the Station's exports, another pool) published here; an unchanged
        signature rules out the others. The signature is taken before reading,
        so a write landing during the read is caught by the next check.
        """
        seen = signature(self.library_path)
        known = getattr(self, '_known', None)
        if known is not None and known[0] + 1 == generation and known[1] == seen:
            token = known[2]
        else:
            token = revision(self.library_path)
        self._known = generation, seen, token
        return token

    @serialized
    def commit_track(self, track) -> None:
        """Add acquired audio to the latest pool manifest, never a stale snapshot."""
        with self._lock, publication_lock(self.library_path) as generation:
            if (not hasattr(self, 'library') or
                    self._revision_locked(generation) != getattr(self, '_manifest_revision', object())):
                # Somebody else published: their file, podcasts included, is the base.
                self.library, self._manifest_revision = self._read_locked(generation)
            existing = self.library.get_track_by_hash(track.file_hash)
            if existing:
                self.library.remove_track(existing.id)
            self.library.add_track(track)
            self._publish_locked(generation)

    @serialized
    def replace_snapshot(self, library, expected_revision):
        """Publish a long operation only against the exact snapshot it read.

        Podcast subscriptions and episodes belong to the Station, which writes
        them into this same file: the current file's are kept.
        """
        with self._lock, publication_lock(self.library_path) as generation:
            current = self._revision_locked(generation)
            if current != expected_revision:
                raise LibraryPersistenceError('library_conflict')
            if current == getattr(self, '_manifest_revision', object()):
                # This pool loaded or published the current file: its podcast
                # fields are the file's.
                podcasts = self.library.podcast_subscriptions, self.library.podcast_episode_cache
            else:
                podcasts = self._disk_podcasts()
            if podcasts is not None:
                library.podcast_subscriptions, library.podcast_episode_cache = podcasts
            previous = getattr(self, 'library', None), getattr(self, '_manifest_revision', None)
            self.library, self._manifest_revision = library, expected_revision
            try:
                self._publish_locked(generation)
            except BaseException:
                self.library, self._manifest_revision = previous
                raise

    def _disk_podcasts(self):
        """The file's podcast fields, or None to keep the model's.

        Malformed JSON reads as no podcasts, as the full model reader did; an
        unreadable file or valid JSON that is not a library keeps the model's.
        """
        if not self.library_path.exists():
            return None
        try:
            with open(self.library_path, encoding="utf-8") as stream:
                return read_podcast_fields(stream)
        except Exception:
            return None

    def _publish_locked(self, generation):
        # Same portable bytes, without a second full JSON document in RAM.
        # Streamed into a temporary: the Station reads this file meanwhile.
        writer = LibraryJSONWriter(self.library)
        replace_contents(self.library_path, writer)
        self._manifest_revision = writer.digest.digest()
        self._known = generation, signature(self.library_path), self._manifest_revision
