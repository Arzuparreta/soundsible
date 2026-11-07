"""Disposable worker staging with a cross-process liveness lease."""
from contextlib import contextmanager
import logging
import os
from pathlib import Path
import shutil
import tempfile
import time

log = logging.getLogger(__name__)


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
                writer = path / 'writer'
                if writer.exists():
                    with writer.open('r+b') as child:
                        _lock(child)  # parent death does not retire a live writer
                        (path / 'retired').touch()
                else:
                    (path / 'retired').touch()
            shutil.rmtree(path)
        except OSError:
            continue


@contextmanager
def protect(path):
    """The child holds its own lease before touching a staged input/output."""
    directory = Path(path).parent
    if not directory.name.startswith('.job-'):
        yield  # direct entrypoint probes may use an ordinary temporary path
        return
    with (directory / 'writer').open('r+b') as handle:
        _lock(handle)
        if (directory / 'retired').exists():
            raise OSError('Artwork staging retired')
        yield


@contextmanager
def staging(root):
    reconcile(root)
    directory = Path(tempfile.mkdtemp(prefix='.job-', dir=root))
    try:
        (directory / 'writer').write_bytes(b'0')
        with (directory / 'lease').open('w+b') as handle:
            handle.write(b'0')
            handle.flush()
            _lock(handle)
            yield directory / 'result.jpg'
    finally:
        # Reconciliation checks the child's lease too. If reaping failed it
        # must preserve files still owned by that child for a later sweep.
        reconcile(root)
        if directory.exists():
            log.warning('Artwork staging still owned or unavailable: %s', directory)
