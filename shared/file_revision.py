"""Cross-process publication lock, its hold generations, and file revisions."""
from contextlib import contextmanager
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


def revision(path):
    return read_revision(path)[1]


def _identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def signature(path):
    """Identity, size and timestamps of `path`, or None when it is missing or unreadable.

    A replacement gives the path a new inode; an in-place rewrite changes the
    modification and change times.
    """
    try:
        return _identity(os.stat(path))
    except OSError:
        return None


class _Hashing(io.RawIOBase):
    def __init__(self, raw):
        self.raw = raw
        self.digest = sha256()

    def readable(self):
        return True

    def readinto(self, buffer):
        count = self.raw.readinto(buffer)
        self.digest.update(memoryview(buffer)[:count])
        return count


def read_revision(path, parse=None):
    """`(signature, digest, parse(text))` of one open file: all three describe the same bytes.

    `parse` receives the file as UTF-8 text; whatever it leaves unread is
    still hashed. A missing file gives `(None, None, None)` and is not parsed.
    """
    try:
        raw = Path(path).open('rb', buffering=0)
    except FileNotFoundError:
        return None, None, None
    with raw:
        seen = _identity(os.fstat(raw.fileno()))
        hashing = _Hashing(raw)
        stream = io.BufferedReader(hashing, 64 * 1024)
        result = None
        if parse is not None:
            text = io.TextIOWrapper(stream, encoding='utf-8')
            try:
                result = parse(text)
            finally:
                text.detach()  # Leave `stream` open to hash what parse left.
        while stream.read(64 * 1024):
            pass
        return seen, hashing.digest.digest(), result


class Hold:
    """One outermost hold of a directory's publication lock.

    `generation` counts the publications made in the directory, by any
    process, through `shared.atomic_file`. It is None when the counter cannot
    be read or written; locking still works then, and a holder comparing
    generations just cannot rely on it. A new lock file starts counting at a
    random value, so it cannot replay a generation remembered from an old one.
    """

    def __init__(self, handle):
        self._handle = handle
        try:
            handle.seek(1)
            stored = handle.read(8)
            self.generation = int.from_bytes(stored, 'little') if len(stored) == 8 else None
        except OSError:
            self.generation = None

    def published(self):
        """Count one publication made under this hold."""
        handle = self._handle
        try:
            handle.seek(1)
            stored = handle.read(8)
            value = int.from_bytes(stored if len(stored) == 8 else os.urandom(8), 'little')
            # The handle appends: cut back to the locked byte, then append.
            handle.truncate(1)
            handle.write(((value + 1) % 2**64).to_bytes(8, 'little'))
            handle.flush()
            self.generation = (value + 1) % 2**64
        except OSError:
            self.generation = None


@contextmanager
def publication_lock(path):
    """Exclusive publication rights for every file in `path`'s directory.

    Yields the outermost `Hold`; nested holds on the same thread share it.
    """
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
            held = _local.held = {}
        if key in held:
            yield held[key]
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
            try:
                held[key] = Hold(handle)
                yield held[key]
            finally:
                held.pop(key, None)
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
