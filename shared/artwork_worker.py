"""A single lazy image transformer, isolated from the cooperative HTTP hub.

Only paths and scalar parameters cross the pipe. Cache admission and publication
remain in the parent; no quota lock or database transaction waits for this child.
"""
import atexit
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

FROZEN_FLAG = '--artwork-worker'
TIMEOUT = 30
IDLE_SECONDS = 60
MAX_PENDING = 16


def transform(source, target, size, square):
    from shared.artwork import open_image
    from PIL import Image
    with open_image(Path(source).read_bytes()) as original:
        image = original
        if square:
            edge = min(image.size)
            left, top = (image.width - edge) // 2, (image.height - edge) // 2
            image = image.crop((left, top, left + edge, top + edge))
        try:
            image.thumbnail((size, size), Image.Resampling.LANCZOS)
            image.save(target, 'JPEG', quality=90, optimize=True)
        finally:
            if image is not original:
                image.close()


def inspect_image(source):
    from shared.artwork import open_image
    from PIL import Image
    with open_image(Path(source).read_bytes()) as image:
        width, height = image.size
    with Image.open(source) as image:
        return {'width': width, 'height': height, 'format': image.format}


class ImageProcess:
    def __init__(self, command=None, timeout=TIMEOUT, idle=IDLE_SECONDS):
        self.command, self.timeout, self.idle = command, timeout, idle
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(MAX_PENDING)
        self.process = None
        self.timer = None
        self.generation = 0

    def render(self, source, output, size, square, *, deadline=None, staging_dir=None, operation='transform'):
        deadline = min(deadline or float("inf"), time.monotonic() + self.timeout)
        if not self.slots.acquire(blocking=False):
            raise OSError('Artwork queue full')
        try:
            if not self.lock.acquire(timeout=max(0, deadline - time.monotonic())):
                raise OSError('Artwork queue deadline exceeded')
            try:
                self.generation += 1
                if self.timer:
                    self.timer.cancel()
                return self._render(source, output, size, square, deadline, staging_dir, operation)
            finally:
                self.timer = threading.Timer(self.idle, self._idle_close, (self.generation,))
                self.timer.daemon = True
                self.timer.start()
                self.lock.release()
        finally:
            self.slots.release()

    def _render(self, source, output, size, square, deadline, staging_dir, operation):
        from shared.artwork_staging import staging
        root = Path(staging_dir) if staging_dir else Path(source).parent / '.image-workers'
        with staging(root) as target:
            return self._exchange(source, output, size, square, deadline, target, operation)

    def _exchange(self, source, output, size, square, deadline, target, operation):
        try:
            if self.process is None or self.process.poll() is not None:
                self._stop()
                command = self.command or ([sys.executable, FROZEN_FLAG] if getattr(sys, 'frozen', False)
                                           else [sys.executable, '-m', 'shared.artwork_worker'])
                env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1]),
                       'OPENBLAS_NUM_THREADS': '1'}
                self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                env=env)
                self.replies = queue.Queue(maxsize=1)
                process, replies = self.process, self.replies

                def read():
                    try:
                        while True:
                            line = process.stdout.readline(4097)
                            replies.put(line)
                            if not line or len(line) > 4096:
                                return
                    except (OSError, ValueError):
                        pass
                threading.Thread(target=read, name='image-replies', daemon=True).start()
            request = {'source': str(source), 'target': str(target), 'size': size, 'square': square, 'operation': operation}
            self.process.stdin.write((json.dumps(request) + '\n').encode())
            self.process.stdin.flush()
            try:
                reply = self.replies.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                raise OSError('Artwork worker deadline exceeded') from None
            result = json.loads(reply) if len(reply) <= 4096 and reply else {}
            if not result.get('ok'):
                raise OSError('Artwork worker failed')
            if operation == 'inspect':
                return result['image']
            with open(target, 'rb') as image:
                import shutil
                shutil.copyfileobj(image, output, 64 * 1024)
        except BaseException:
            self._stop()
            raise

    def _idle_close(self, generation):
        with self.lock:
            if generation == self.generation:
                self._stop()

    def _stop(self):
        process, self.process = self.process, None
        if process:
            try:
                process.kill()
            except OSError:
                pass
            process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()

    def close(self):
        with self.lock:
            self.generation += 1
            if self.timer:
                self.timer.cancel()
            self._stop()


worker = ImageProcess()
atexit.register(worker.close)


def generate(source, output, size, square, *, deadline=None, staging_dir=None):
    # CLI utilities with ordinary threads do not own the HTTP hub. Preserve
    # their low startup cost; production boot always patches before imports.
    from gevent import monkey
    if monkey.is_module_patched('socket'):
        worker.render(source, output, size, square, deadline=deadline, staging_dir=staging_dir)
    else:
        transform(source, output, size, square)


def image_info(data, cache):
    from gevent import monkey
    from shared.artwork_staging import staging
    # The byte limit is checked before any staging or decode, including CLI.
    from shared.artwork import MAX_BYTES
    if len(data) > MAX_BYTES:
        raise ValueError('Artwork exceeds byte limit')
    with staging(Path(cache) / '.image-workers') as source:
        source.write_bytes(data)
        if monkey.is_module_patched('socket'):
            return worker.render(source, None, 0, False, staging_dir=Path(cache) / '.image-workers', operation='inspect')
        return inspect_image(source)


def main():
    import faulthandler
    target = None
    try:
        for line in sys.stdin.buffer:
            try:
                request = json.loads(line)
                target = request['target']
                faulthandler.dump_traceback_later(TIMEOUT, exit=True)
                if request.get('operation') == 'inspect':
                    reply = {'ok': True, 'image': inspect_image(request['source'])}
                else:
                    transform(request['source'], target, request['size'], request['square'])
                    reply = {'ok': True}
            except Exception:
                reply = {'ok': False}
            finally:
                faulthandler.cancel_dump_traceback_later()
            sys.stdout.write(json.dumps(reply) + '\n')
            sys.stdout.flush()
    finally:
        # The parent owns normal cleanup. EOF/BrokenPipe after parent death
        # cannot retain a decoded image or an output file indefinitely.
        if target:
            Path(target).unlink(missing_ok=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
