"""Cross-process publication lock, its hold generations, and file revisions."""
from contextlib import contextmanager
from hashlib import sha256
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
    digest = sha256()
    try:
        with Path(path).open('rb') as stream:
            for block in iter(lambda: stream.read(64 * 1024), b''):
                digest.update(block)
    except FileNotFoundError:
        return None
    return digest.digest()


def signature(path):
    """Identity, size and timestamps of `path`, or None when it is missing.

    A replacement gives the path a new inode; an in-place rewrite changes the
    modification and change times.
    """
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return None
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _advance(handle):
    """Count this hold in the lock file; returns the new generation.

    The counter starts at a random value, so a recreated lock file cannot
    replay generations a writer remembers from the old one.
    """
    handle.seek(1)
    stored = handle.read(8)
    value = int.from_bytes(stored if len(stored) == 8 else os.urandom(8), 'little')
    value = (value + 1) % 2**64
    # The handle appends: cut back to the locked byte, then append the counter.
    handle.truncate(1)
    handle.write(value.to_bytes(8, 'little'))
    handle.flush()
    return value


@contextmanager
def publication_lock(path):
    """Exclusive publication rights for every file in `path`'s directory.

    Yields the hold's generation. Every outermost hold, by any process,
    advances it by one, so a writer whose next hold is its previous generation
    plus one knows no cooperating writer touched the directory in between.
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
                held[key] = _advance(handle)
                yield held[key]
            finally:
                held.pop(key, None)
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
