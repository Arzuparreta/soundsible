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
import threading

from PIL import Image, ImageOps

from shared.runtime import get_cache_dir, get_data_dir

SIZES = (160, 320, 640, 960, 1280)
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
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
        self._generation = threading.BoundedSemaphore(2)
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
                CREATE TABLE IF NOT EXISTS recovery (
                    track_id TEXT PRIMARY KEY, state TEXT, attempts INTEGER DEFAULT 0,
                    next_try REAL DEFAULT 0, detail TEXT
                );
            """)

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
        image = open_image(data)
        digest = hashlib.sha256(data).hexdigest()
        path = self.root / "objects" / digest
        if not path.exists():
            atomic_write(path, data)
        with Image.open(io.BytesIO(data)) as original:
            fmt = original.format
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO objects VALUES (?, ?, ?, ?, ?)",
                       (digest, image.width, image.height, fmt, len(data)))
        return digest

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
        return True

    def remap(self, aliases: dict[str, str]) -> None:
        # Copy before the library transaction; retain the old reference so a
        # failed transaction or another account still using it remains valid.
        with self.connect() as db:
            for old, new in aliases.items():
                db.execute("INSERT OR IGNORE INTO refs SELECT ?, hash, source, revision FROM refs WHERE track_id=?",
                           (new, old))

    def path(self, track_id: str) -> str | None:
        ref = self.ref(track_id)
        if not ref or not ref["hash"]:
            return None
        path = self.root / "objects" / ref["hash"]
        return str(path) if path.is_file() else None

    def variant(self, digest: str, size: int, square: bool = False) -> Path:
        if size not in SIZES or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Invalid artwork variant")
        path = self.cache / f"{digest}-{size}-{'square' if square else 'original'}-{TRANSFORM}.jpg"
        with self._locks[int(digest[:2], 16) % len(self._locks)]:
            if path.is_file():
                return path
            with self._generation:
                image = open_image((self.root / "objects" / digest).read_bytes())
                if square:
                    edge = min(image.size)
                    left, top = (image.width - edge) // 2, (image.height - edge) // 2
                    image = image.crop((left, top, left + edge, top + edge))
                image.thumbnail((size, size), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                image.save(buffer, "JPEG", quality=90, optimize=True)
                atomic_write(path, buffer.getvalue())
        return path

    def annotate(self, tracks: list[dict]) -> None:
        if not tracks:
            return
        with self.connect() as db:
            refs = {row['track_id']: dict(row) for row in db.execute(
                "SELECT track_id, refs.hash, revision, width, height FROM refs LEFT JOIN objects ON refs.hash=objects.hash")}
        for track in tracks:
            ref = refs.get(track.get('id'))
            if ref:
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
