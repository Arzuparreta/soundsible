"""Persistent artwork originals; disposable, bounded presentation variants.

The index and objects live together in data/artwork and must be backed up
 together. Nothing here fetches audio or depends on a user's library snapshot.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import io
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import threading

from PIL import Image, ImageOps
from collections import OrderedDict

from shared.runtime import get_cache_dir, get_data_dir
from shared.sqlite_revision import install_revision, read_revision

SIZES = (160, 320, 640, 960, 1280)
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
_REF_BATCH_SIZE = 500
TRANSFORM = "jpeg90-v1"


def open_image(data: bytes) -> Image.Image:
    if len(data) > MAX_BYTES:
        raise ValueError("Artwork exceeds byte limit")
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > MAX_PIXELS:
            raise ValueError("Artwork exceeds pixel limit")
        return ImageOps.exif_transpose(image).convert("RGB")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".artwork-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class ArtworkStore:
    def __init__(self, root: Path, cache: Path):
        self.root, self.cache = Path(root), Path(cache)
        self.root.mkdir(parents=True, exist_ok=True)
        from shared.artwork_variants import VariantCache
        self._variants = VariantCache(self.cache, self.root)
        self._generation = threading.BoundedSemaphore(16)
        self._dimensions = OrderedDict()
        self._locks = [threading.Lock() for _ in range(64)]
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS objects (
                    hash TEXT PRIMARY KEY, width INTEGER, height INTEGER,
                    format TEXT, bytes INTEGER
                );
                CREATE TABLE IF NOT EXISTS refs (
                    track_id TEXT PRIMARY KEY, hash TEXT, source TEXT,
                    revision INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS overrides (
                    account TEXT, track_id TEXT, hash TEXT, source TEXT,
                    revision INTEGER NOT NULL, PRIMARY KEY(account,track_id)
                );
                CREATE TABLE IF NOT EXISTS recovery (
                    track_id TEXT PRIMARY KEY, state TEXT, attempts INTEGER DEFAULT 0,
                    next_try REAL DEFAULT 0, detail TEXT
                );
            """)

            install_revision(db, ("objects", "refs", "overrides"))
            from shared.sqlite_changes import install_changes
            install_changes(db, (('refs', 'track', 'track_id'), ('overrides', 'track', 'track_id'), ('objects', 'object', 'hash')))
            db.execute('CREATE INDEX IF NOT EXISTS refs_hash ON refs(hash)')

    def change_state(self):
        from shared.sqlite_changes import cursor
        with self.connect() as db:
            db.execute('BEGIN')
            return {'token': read_revision(db), 'cursor': cursor(db).to_list()}

    def changed_tracks(self, previous, expected):
        from shared.sqlite_changes import Cursor, changes_since, MAX_KEYS
        with self.connect() as db:
            db.execute('BEGIN')
            if read_revision(db) != expected['token']:
                return None
            events = changes_since(db, Cursor.parse(previous['cursor']), Cursor.parse(expected['cursor']))
            if events is None:
                return None
            ids = {key for kind, key, operation in events if kind == 'track'}
            objects = [key for kind, key, operation in events if kind == 'object']
            for offset in range(0, len(objects), 500):
                batch = objects[offset:offset + 500]
                ids.update(row[0] for row in db.execute(
                    f'SELECT track_id FROM refs WHERE hash IN ({",".join("?" for _ in batch)}) LIMIT ?',
                    [*batch, MAX_KEYS + 1]))
                if len(ids) > MAX_KEYS:
                    return None
            return ids

    def public_revision(self) -> str:
        with self.connect() as db:
            return read_revision(db)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.root / "index.sqlite3", timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def put(self, data: bytes) -> str:
        digest = hashlib.sha256(data).hexdigest()
        path = self.root / 'objects' / digest
        with self.connect() as db:
            known = db.execute('SELECT width,height FROM objects WHERE hash=?', (digest,)).fetchone()
        if known and path.is_file():
            self._remember_dimensions(digest, *known)
            return digest
        from shared.artwork_worker import image_info
        info = image_info(data, self.cache)
        if not path.exists():
            atomic_write(path, data)
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO objects VALUES (?, ?, ?, ?, ?)',
                       (digest, info['width'], info['height'], info['format'], len(data)))
        self._remember_dimensions(digest, info['width'], info['height'])
        return digest

    def _remember_dimensions(self, digest, width, height):
        self._dimensions[digest] = (width, height)
        self._dimensions.move_to_end(digest)
        if len(self._dimensions) > 256:
            self._dimensions.popitem(last=False)

    def ref(self, track_id: str):
        with self.connect() as db:
            row = db.execute("SELECT refs.*, width, height, format, bytes FROM refs "
                             "LEFT JOIN objects ON objects.hash=refs.hash WHERE track_id=?", (track_id,)).fetchone()
        return dict(row) if row else None

    def bind(self, track_id: str, digest: str | None, source: str | None,
             *, expected_revision: int | None = None, only_missing: bool = False) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM refs WHERE track_id=?", (track_id,)).fetchone()
            if only_missing and row:
                return False
            if expected_revision is not None and (row["revision"] if row else 0) != expected_revision:
                return False
            if row and row["hash"] == digest and row["source"] == source:
                return True
            db.execute("INSERT INTO refs VALUES (?, ?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET "
                       "hash=excluded.hash, source=excluded.source, revision=excluded.revision",
                       (track_id, digest, source, (row["revision"] + 1) if row else 1))
            db.execute('UPDATE recovery SET next_try=0 WHERE track_id=?', (track_id,))
        return True

    def effective_ref(self, track_id):
        """Account choices shadow a shared source; tombstones are real refs."""
        from shared.user_context import current_user_id
        account = current_user_id()
        if not account:
            return self.ref(track_id)
        with self.connect() as db:
            row = db.execute(
                'WITH choice AS ('
                'SELECT track_id,hash,source,revision,account,1 AS priority FROM overrides WHERE account=? AND track_id=? '
                'UNION ALL SELECT track_id,hash,source,revision,NULL AS account,0 AS priority FROM refs WHERE track_id=?) '
                'SELECT choice.*,width,height,format,bytes FROM choice LEFT JOIN objects ON objects.hash=choice.hash '
                'ORDER BY priority DESC LIMIT 1', (account, track_id, track_id)).fetchone()
        return dict(row) if row else None

    def effective_path(self, track_id):
        ref = self.effective_ref(track_id)
        if not ref or not ref['hash']:
            return None
        path = self.root / 'objects' / ref['hash']
        return str(path) if path.is_file() else None

    def bind_override(self, track_id, digest, source, *, automatic=False, expected_revision=None, selection_token=None, selection_lease=None):
        from shared.user_context import require_user_id
        account = require_user_id()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT source,revision FROM overrides WHERE account=? AND track_id=?',
                             (account, track_id)).fetchone()
            # Automatic acquisition cannot overwrite a manual choice or removal.
            if selection_token:
                choice = db.execute('SELECT token,lease FROM selections WHERE account=? AND track_id=?',
                                    (account, track_id)).fetchone()
                if not choice or choice[0] != selection_token or choice[1] != selection_lease:
                    return False
            if automatic and row and row['source'] in ('manual', 'none'):
                return False
            if expected_revision is not None and (row['revision'] if row else 0) != expected_revision:
                return False
            db.execute('INSERT INTO overrides VALUES (?,?,?,?,?) ON CONFLICT(account,track_id) '
                       'DO UPDATE SET hash=excluded.hash,source=excluded.source,revision=excluded.revision',
                       (account, track_id, digest, source, row['revision'] + 1 if row else 1))
            if selection_token:
                db.execute('UPDATE selections SET attempts=-1,next_try=1e20,lease=NULL '
                           'WHERE account=? AND track_id=? AND token=? AND lease=?',
                           (account, track_id, selection_token, selection_lease))
        return True

    def remap(self, aliases: dict[str, str]) -> None:
        # Copy before the library transaction; retain the old reference so a
        # failed transaction or another account still using it remains valid.
        from shared.user_context import current_user_id
        account = current_user_id()
        with self.connect() as db:
            for old, new in aliases.items():
                if account and db.execute("SELECT 1 FROM sqlite_master WHERE name='selections'").fetchone():
                    db.execute('INSERT INTO selections SELECT account,?,video_id,token,attempts,next_try,issued,NULL '
                               'FROM selections WHERE account=? AND track_id=? ON CONFLICT(account,track_id) DO UPDATE SET '
                               'video_id=excluded.video_id,token=excluded.token,attempts=excluded.attempts,'
                               'next_try=excluded.next_try,issued=excluded.issued,lease=NULL '
                               'WHERE issued<excluded.issued', (new, account, old))
                if account:
                    db.execute('INSERT OR IGNORE INTO overrides SELECT account,?,hash,source,revision '
                               'FROM overrides WHERE account=? AND track_id=?', (new, account, old))
                db.execute("INSERT OR IGNORE INTO refs SELECT ?, hash, source, revision FROM refs WHERE track_id=?",
                           (new, old))

    def path(self, track_id: str) -> str | None:
        ref = self.ref(track_id)
        if not ref or not ref["hash"]:
            return None
        path = self.root / "objects" / ref["hash"]
        return str(path) if path.is_file() else None

    def open_variant(self, digest: str, size: int, square: bool = False):
        """Return an open file; caller owns it until the HTTP response closes."""
        if size not in SIZES or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Invalid artwork variant")
        deadline = time.monotonic() + 30
        dimensions = self._dimensions.get(digest)
        if dimensions is None:
            with self.connect() as db:
                row = db.execute('SELECT width,height FROM objects WHERE hash=?', (digest,)).fetchone()
            if row:
                dimensions = tuple(row)
                self._remember_dimensions(digest, *dimensions)
        if dimensions:
            edge = min(dimensions) if square else max(dimensions)
            size = next((bucket for bucket in SIZES if bucket >= min(size, edge)), SIZES[-1])
        name = f"{digest}-{size}-{'square' if square else 'original'}-{TRANSFORM}.jpg"

        def generate(output):
            from shared.artwork_worker import generate as render
            render(self.root / 'objects' / digest, output, size, square,
                   deadline=deadline, staging_dir=self.cache / '.image-workers')

        if self._variants.safe:
            hit = self._variants._recent_hit(name)
            if hit:
                return hit
        if not self._generation.acquire(blocking=False):
            raise OSError('Artwork admission full')
        try:
            lock = self._locks[int(digest[:2], 16) % len(self._locks)]
            if not lock.acquire(timeout=max(0, deadline - time.monotonic())):
                raise OSError('Artwork queue deadline exceeded')
            try:
                return self._variants.open(name, generate, deadline=deadline)
            finally:
                lock.release()
        finally:
            self._generation.release()

    def variant(self, digest: str, size: int, square: bool = False) -> Path:
        """Compatibility path lookup; HTTP must use open_variant to pin reads."""
        variant = self.open_variant(digest, size, square)
        try:
            path = self.cache / variant.etag
            if not path.is_file():
                raise OSError("Variant not retained; use open_variant")
            return path
        finally:
            variant.file.close()

    def annotate(self, tracks: list[dict]) -> None:
        ids = list(dict.fromkeys(track.get("id") for track in tracks if isinstance(track.get("id"), str)))
        if not ids:
            return
        refs = {}
        with self.connect() as db:
            # All batches see the same artwork revisions, just as one SELECT
            # did, without materializing references outside the requested set.
            db.execute("BEGIN")
            for offset in range(0, len(ids), _REF_BATCH_SIZE):
                batch = ids[offset:offset + _REF_BATCH_SIZE]
                placeholders = ",".join("?" for _ in batch)
                refs.update((row["track_id"], dict(row)) for row in db.execute(
                    "SELECT track_id, refs.hash, revision, width, height FROM refs "
                    "LEFT JOIN objects ON refs.hash=objects.hash "
                    f"WHERE refs.track_id IN ({placeholders})", batch))
            from shared.user_context import current_user_id
            account = current_user_id()
            if account:
                for offset in range(0, len(ids), _REF_BATCH_SIZE):
                    batch = ids[offset:offset + _REF_BATCH_SIZE]
                    placeholders = ','.join('?' for _ in batch)
                    refs.update((row['track_id'], dict(row)) for row in db.execute(
                        'SELECT track_id,overrides.hash,revision,width,height FROM overrides '
                        'LEFT JOIN objects ON objects.hash=overrides.hash '
                        f'WHERE account=? AND track_id IN ({placeholders})', [account, *batch]))
        from shared.user_context import current_user_id
        scope = hashlib.sha256((current_user_id() or 'shared').encode()).hexdigest()[:16]
        for track in tracks:
            ref = refs.get(track.get('id'))
            if ref:
                track['artwork_scope'] = scope
                track['artwork_revision'] = f"{ref['hash'] or 'none'}-{ref['revision']}"
                track['artwork_width'] = ref['width']
                track['artwork_height'] = ref['height']


_stores: dict[tuple[Path, Path], ArtworkStore] = {}
_store_lock = threading.Lock()


def artwork_store() -> ArtworkStore:
    key = (get_data_dir() / "artwork", get_cache_dir() / "artwork")
    with _store_lock:
        if key not in _stores:
            _stores[key] = ArtworkStore(*key)
        return _stores[key]


_YT_IMAGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0"
_image_session = None
_image_session_lock = threading.Lock()


def download_image(url: str) -> bytes | None:
    """Fetch an image, or None. YouTube's thumbnail hosts get a browser UA."""
    global _image_session
    if not url:
        return None
    import requests
    from urllib.parse import urlparse

    host = (urlparse(url).netloc or "").lower()
    headers = None
    if "ytimg.com" in host or "youtube.com" in host or "img.youtube" in host:
        headers = {"User-Agent": _YT_IMAGE_USER_AGENT}
    with _image_session_lock:
        if _image_session is None:
            _image_session = requests.Session()
    try:
        response = _image_session.get(url, timeout=10, headers=headers)
        response.raise_for_status()
        return response.content
    except Exception:
        return None
