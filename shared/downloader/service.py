"""The download pool: its folder, its library.json, YouTube and the cloud."""

import json
import threading
from pathlib import Path
from typing import NamedTuple, Optional

from shared.atomic_file import replace_contents
from shared.file_revision import HAS_STAT_CHANGE_TIME, publication_lock, read_revision, signature
from shared.library_lifecycle import LibraryPersistenceError, serialized
from shared.models import LibraryMetadata
from shared.library_json import LibraryJSONWriter

from .cloud_sync import CloudSync
from .config import DEFAULT_QUALITY, LIBRARY_FILENAME
from .library_podcasts import read_podcast_fields
from .youtube_downloader import YouTubeDownloader

_UNKNOWN = object()


class _Seen(NamedTuple):
    """The pool manifest as observed under the publication lock."""
    generation: Optional[int]
    signature: Optional[tuple]
    digest: Optional[bytes]


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
        with publication_lock(self.library_path) as hold:
            return self._read_locked(hold)

    # Two different facts are kept, and must not be confused:
    # - `_manifest_revision`: digest of the file the resident model came from
    #   (loaded or published by this pool);
    # - `_seen`: the file as last observed under the lock, whoever wrote it.

    def _read_locked(self, hold):
        # Model, digest and signature all come from one open descriptor.
        # Corrupt/unreadable state is not an empty library to overwrite.
        signature_, token, library = read_revision(
            self.library_path, lambda text: LibraryMetadata.from_dict(json.load(text)))
        if library is None:
            library = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
        self._seen = _Seen(hold.generation, signature_, token)
        return library, token

    def _unread_revision(self, hold):
        """The digest last seen, if the file provably has not changed since; else _UNKNOWN.

        Nothing published in this directory since (same generation) rules out
        cooperating writers (the Station's exports, another pool); an
        unchanged signature rules out the others.
        """
        seen = getattr(self, '_seen', None)
        if (HAS_STAT_CHANGE_TIME and seen is not None and hold.generation is not None
                and seen.generation == hold.generation
                and seen.signature is not None and seen.signature == signature(self.library_path)):
            return seen.digest
        return _UNKNOWN

    def _revision_locked(self, hold):
        """The manifest's content digest, reading its bytes only if they may have changed."""
        token = self._unread_revision(hold)
        if token is _UNKNOWN:
            signature_, token, _ = read_revision(self.library_path)
            self._seen = _Seen(hold.generation, signature_, token)
        return token

    @serialized
    def commit_track(self, track) -> None:
        """Add acquired audio to the latest pool manifest, never a stale snapshot."""
        with self._lock, publication_lock(self.library_path) as hold:
            current = getattr(self, '_manifest_revision', _UNKNOWN)
            observed = _UNKNOWN
            if current is not _UNKNOWN and hasattr(self, 'library'):
                observed = self._unread_revision(hold) if HAS_STAT_CHANGE_TIME else self._revision_locked(hold)
            if observed is _UNKNOWN or observed != current:
                # One pass: hash and parse together, adopting the file unless
                # it is the one the model came from. Another writer's file,
                # podcasts included, is then the base; otherwise in-memory
                # edits are kept.
                library, token = self._read_locked(hold)
                if not hasattr(self, 'library') or token != current:
                    self.library, self._manifest_revision = library, token
            existing = self.library.get_track_by_hash(track.file_hash)
            if existing:
                self.library.remove_track(existing.id)
            self.library.add_track(track)
            self._publish_locked(hold)

    @serialized
    def replace_snapshot(self, library, expected_revision):
        """Publish a long operation only against the exact snapshot it read.

        Podcast subscriptions and episodes belong to the Station, which writes
        them into this same file: the current file's are kept. With no file,
        the snapshot's own stand.
        """
        with self._lock, publication_lock(self.library_path) as hold:
            current = self._revision_locked(hold)
            if current != expected_revision:
                raise LibraryPersistenceError('library_conflict')
            if current is None:
                podcasts = None
            elif current == getattr(self, '_manifest_revision', _UNKNOWN):
                # The resident model came from the current file: its podcast
                # fields are the file's.
                podcasts = self.library.podcast_subscriptions, self.library.podcast_episode_cache
            else:
                podcasts = self._disk_podcasts()
            if podcasts is not None:
                library.podcast_subscriptions, library.podcast_episode_cache = podcasts
            previous = getattr(self, 'library', None), getattr(self, '_manifest_revision', _UNKNOWN)
            self.library, self._manifest_revision = library, expected_revision
            try:
                self._publish_locked(hold)
            except BaseException:
                self.library, self._manifest_revision = previous
                raise

    def _disk_podcasts(self):
        """The file's podcast fields, or None to keep the model's.

        Malformed JSON reads as no podcasts, as the full model reader did; an
        unreadable file or valid JSON that is not a library keeps the model's.
        """
        try:
            with open(self.library_path, encoding="utf-8") as stream:
                return read_podcast_fields(stream)
        except Exception:
            return None

    def _publish_locked(self, hold):
        # Same portable bytes, without a second full JSON document in RAM.
        # Streamed into a temporary: the Station reads this file meanwhile.
        writer = LibraryJSONWriter(self.library)
        published = replace_contents(self.library_path, writer)
        self._manifest_revision = writer.digest.digest()
        # Remember the file only if the path named the bytes just written
        # when they landed (same device, inode, size and modification time);
        # a later write by anyone changes the signature the next commit sees.
        self._seen = (_Seen(hold.generation, published, self._manifest_revision)
                      if published is not None and published[:4] == writer.written else None)
