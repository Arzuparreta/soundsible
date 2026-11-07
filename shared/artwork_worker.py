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
import uuid

FROZEN_FLAG = '--artwork-worker'
TIMEOUT = 30
IDLE_SECONDS = 60
MAX_PENDING = 16


class ImageBusy(OSError):
    pass


def check_operation(deadline, stop=None):
    from shared.process_runner import check_cancelled
    check_cancelled()
    if (stop and stop.is_set()) or time.monotonic() >= deadline:
        raise OSError('Artwork worker deadline exceeded or cancelled')


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
    def __init__(self, command=None, timeout=TIMEOUT, idle=IDLE_SECONDS, pending=MAX_PENDING):
        self.command, self.timeout, self.idle = command, timeout, idle
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(pending)
        self.process = None
        self.reader = None
        self.reader_stop = None
        self.broken = False
        self.timer = None
        self.generation = 0

    def render(self, source, output, size, square, *, deadline=None, staging_dir=None, operation='transform', stop=None, video_id=None):
        deadline = min(deadline or float("inf"), time.monotonic() + self.timeout)
        if not self.slots.acquire(blocking=False):
            raise ImageBusy('Artwork queue full')
        try:
            if not self.lock.acquire(timeout=max(0, deadline - time.monotonic())):
                raise OSError('Artwork queue deadline exceeded')
            try:
                self.generation += 1
                if self.timer:
                    self.timer.cancel()
                check_operation(deadline, stop)
                return self._render(source, output, size, square, deadline, staging_dir, operation, stop, video_id)
            finally:
                self.timer = threading.Timer(self.idle, self._idle_close, (self.generation,))
                self.timer.daemon = True
                self.timer.start()
                self.lock.release()
        finally:
            self.slots.release()

    def _render(self, source, output, size, square, deadline, staging_dir, operation, stop, video_id):
        from shared.artwork_staging import staging
        root = Path(staging_dir) if staging_dir else Path(source).parent / '.image-workers'
        with staging(root) as target:
            return self._exchange(source, output, size, square, deadline, target, operation, stop, video_id)

    def _exchange(self, source, output, size, square, deadline, target, operation, stop, video_id):
        try:
            if self.broken or self.process is None or self.process.poll() is not None:
                self._stop()
                command = self.command or ([sys.executable, FROZEN_FLAG] if getattr(sys, 'frozen', False)
                                           else [sys.executable, '-m', 'shared.artwork_worker'])
                env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1]),
                       'OPENBLAS_NUM_THREADS': '1'}
                self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                env=env)
                self.broken = False
                self.replies = queue.Queue(maxsize=1)
                self.reader_stop = threading.Event()
                process, replies, reader_stop = self.process, self.replies, self.reader_stop

                def read():
                    try:
                        while not reader_stop.is_set():
                            line = process.stdout.readline(4097)
                            while not reader_stop.is_set():
                                try:
                                    replies.put(line, timeout=.1)
                                    break
                                except queue.Full:
                                    pass
                            if not line or len(line) > 4096:
                                return
                    except (OSError, ValueError):
                        pass
                self.reader = threading.Thread(target=read, name='image-replies', daemon=True)
                self.reader.start()
            check_operation(deadline, stop)
            identifier = uuid.uuid4().hex
            request = {'source': str(source), 'target': str(target), 'size': size, 'square': square,
                       'operation': operation, 'id': identifier, 'video_id': video_id,
                       'timeout': min(TIMEOUT, max(.1, deadline - time.monotonic()))}
            payload = (json.dumps(request) + '\n').encode()
            if len(payload) > 4096:
                raise OSError('Artwork request exceeds protocol limit')
            self.process.stdin.write(payload)
            self.process.stdin.flush()
            while True:
                check_operation(deadline, stop)
                try:
                    reply = self.replies.get(timeout=min(.1, max(0, deadline - time.monotonic())))
                    break
                except queue.Empty:
                    pass
            check_operation(deadline, stop)
            result = json.loads(reply) if len(reply) <= 4096 and reply else {}
            if not isinstance(result, dict) or not result.get('ok') or result.get('id') != identifier:
                raise OSError('Artwork worker failed')
            if operation == 'inspect':
                return result['image']
            if operation == 'fetch':
                from shared.artwork import MAX_BYTES
                data = b''
                if result['http']['status'] == 200:
                    with open(target, 'rb') as image:
                        data = image.read(MAX_BYTES + 1)
                    if len(data) > MAX_BYTES or len(data) != result['http']['bytes']:
                        raise OSError('Invalid artwork body')
                check_operation(deadline, stop)
                return {**result['http'], 'data': data}
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
        process = self.process
        if process:
            self.broken = True
            if self.reader_stop:
                self.reader_stop.set()
            try:
                process.kill()
            except OSError:
                pass
            process.wait(timeout=5)
            process.stdin.close()
            if self.reader:
                self.reader.join(timeout=1)
                if self.reader.is_alive():
                    raise OSError('Artwork IPC reader did not stop')
            process.stdout.close()
            self.process, self.reader, self.reader_stop = None, None, None

    def close(self):
        with self.lock:
            self.generation += 1
            if self.timer:
                self.timer.cancel()
            self._stop()


worker = ImageProcess()
http_worker = ImageProcess(timeout=15, pending=1)
atexit.register(worker.close)
atexit.register(http_worker.close)


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
    from contextlib import ExitStack
    from shared.artwork_staging import protect
    target = None
    try:
        for line in sys.stdin.buffer:
            request = {}
            try:
                request = json.loads(line)
                target = request['target']
                faulthandler.dump_traceback_later(min(TIMEOUT, max(.1, request.get('timeout', TIMEOUT))), exit=True)
                with ExitStack() as leases:
                    leases.enter_context(protect(target))
                    if request.get('operation') != 'fetch':
                        leases.enter_context(protect(request['source']))
                    if request.get('operation') == 'inspect':
                        reply = {'ok': True, 'image': inspect_image(request['source'])}
                    elif request.get('operation') == 'fetch':
                        from shared.artwork_http import fetch
                        reply = {'ok': True, 'http': fetch(request['source'], target, request.get('video_id'))}
                    else:
                        transform(request['source'], target, request['size'], request['square'])
                        reply = {'ok': True}
            except Exception as exc:
                reply = {'ok': False, 'error': type(exc).__name__}
            finally:
                faulthandler.cancel_dump_traceback_later()
            if request.get('id'):
                reply['id'] = request['id']
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
