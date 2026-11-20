"""Cross-process publication lock and bounded fingerprints for portable files."""
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
import io
import os
import errno
import time
from pathlib import Path
import threading
import weakref

_guard = threading.Lock()
_locks = weakref.WeakValueDictionary()
_local = threading.local()


def _digest(stream):
    digest = sha256()
    for block in iter(lambda: stream.read(64 * 1024), b''):
        digest.update(block)
    return digest.digest()


def revision(path):
    try:
        with Path(path).open('rb') as stream:
            return _digest(stream)
    except FileNotFoundError:
        return None


@dataclass(frozen=True)
class FileRevision:
    digest: bytes
    size: int


class _HashingReader(io.RawIOBase):
    def __init__(self, raw):
        self.raw = raw
        self.digest = sha256()

    def readable(self):
        return True

    def readinto(self, buffer):
        count = self.raw.readinto(buffer)
        self.digest.update(memoryview(buffer)[:count])
        return count


def read_revision(path, parse, *, known: FileRevision | None = None):
    """Return the revision and parsed value from one file descriptor.

    The parser consumes the complete text stream, as json.load does.
    When the digest matches `known`, return that revision and no parsed value.
    Size is only a hint to skip a hash-only pass when the bytes must differ.
    When absent, return neither a revision nor a parsed value.
    """
    try:
        raw = Path(path).open('rb', buffering=0)
    except FileNotFoundError:
        return None, None
    with raw:
        if known is not None and known.size == os.fstat(raw.fileno()).st_size:
            if _digest(raw) == known.digest:
                return known, None
            raw.seek(0)
        hashing = _HashingReader(raw)
        with io.TextIOWrapper(io.BufferedReader(hashing, 64 * 1024), encoding='utf-8') as text:
            value = parse(text)
            return FileRevision(hashing.digest.digest(), raw.tell()), value


@contextmanager
def publication_lock(path):
    # Lock the directory rather than the replaced inode. Resolve symlinks so
    # two spellings of a local provider destination coordinate as well.
    parent = Path(path).resolve().parent
    key = str(parent)
    with _guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _locks[key] = lock
    with lock:
        held = getattr(_local, 'held', None)
        if held is None:
            held = _local.held = set()
        if key in held:
            yield
            return
        parent.mkdir(parents=True, exist_ok=True)
        with (parent / '.soundsible-write.lock').open('a+b') as handle:
            if handle.tell() == 0:
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                while True:
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                            raise
                        time.sleep(.01)
            else:
                import fcntl
                while True:
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        # time.sleep is cooperative in the patched engine and
                        # an ordinary bounded wait in standalone/native callers.
                        time.sleep(.01)
            held.add(key)
            try:
                yield
            finally:
                held.remove(key)
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
