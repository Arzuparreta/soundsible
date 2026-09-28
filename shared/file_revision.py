"""Cross-process publication lock and bounded fingerprints for portable files."""
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
