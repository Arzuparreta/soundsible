"""Disposable worker staging with a cross-process liveness lease."""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import tempfile
import time


def _lock(handle):
    handle.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def reconcile(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    for path in root.glob('.job-*'):
        if path.is_symlink() or not path.is_dir():
            continue
        try:
            lease = path / 'lease'
            if not lease.exists():
                if time.time() - path.stat().st_mtime > 60:
                    shutil.rmtree(path)
                continue
            if lease.is_symlink():
                continue
            with lease.open('r+b') as handle:
                _lock(handle)  # an active parent prevents cleanup
            shutil.rmtree(path)
        except OSError:
            continue


@contextmanager
def staging(root):
    reconcile(root)
    directory = Path(tempfile.mkdtemp(prefix='.job-', dir=root))
    try:
        with (directory / 'lease').open('w+b') as handle:
            handle.write(b'0')
            handle.flush()
            _lock(handle)
            yield directory / 'result.jpg'
    finally:
        shutil.rmtree(directory, ignore_errors=True)
