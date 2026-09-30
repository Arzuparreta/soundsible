"""Real patched-process verification: durable flushes must not block the hub."""
import os
from pathlib import Path
import subprocess
import sys


def test_flush_yields_preserves_errors_and_owns_descriptor(tmp_path):
    script = r'''
from gevent import monkey
monkey.patch_all()
import gevent
import os
from pathlib import Path
import sys
from shared import atomic_file

sleep = monkey.get_original('time', 'sleep')
real_fsync = os.fsync
path = Path(sys.argv[1]) / 'library.json'
path.write_text('old')
started = []

def slow(fd):
    started.append(fd)
    sleep(.15)
    real_fsync(fd)

atomic_file.os.fsync = slow
writer = gevent.spawn(atomic_file.publish, path, atomic_file.text_pieces(['new']))
ticks = 0
while not writer.ready():
    gevent.sleep(.01)
    ticks += 1
writer.get()
assert ticks >= 5, ticks
assert path.read_text() == 'new'
try:
    os.fstat(started[-1])
except OSError:
    pass
else:
    raise AssertionError('native worker leaked descriptor')

def failure(fd):
    sleep(.03)
    raise OSError('disk failed')
atomic_file.os.fsync = failure
try:
    atomic_file.publish(path, atomic_file.text_pieces(['broken']))
except OSError:
    pass
else:
    raise AssertionError('fsync failure was swallowed')
assert path.read_text() == 'new'
assert not list(path.parent.glob('.library.json.*'))

# Hold the native flush until cancellation has been checked. Fixed sleeps
# cannot prove completion on a busy CI runner (real fsync may take longer).
release_flush = monkey.get_original('_thread', 'allocate_lock')()
release_flush.acquire()

def blocked(fd):
    started.append(fd)
    with release_flush:
        real_fsync(fd)

atomic_file.os.fsync = blocked
started.clear()
writer = gevent.spawn(atomic_file.publish, path, atomic_file.text_pieces(['cancelled']))
while not started:
    gevent.sleep(.001)
writer.kill()
assert path.read_text() == 'new'
# The native worker keeps a valid descriptor despite cancellation/temporary cleanup.
os.fstat(started[0])
release_flush.release()
with gevent.Timeout(5):
    gevent.get_hub().threadpool.join()
try:
    os.fstat(started[0])
except OSError:
    pass
else:
    raise AssertionError('cancelled flush leaked descriptor')
assert not list(path.parent.glob('.library.json.*'))
'''
    result = subprocess.run([sys.executable, '-c', script, str(tmp_path)],
                            cwd=Path(__file__).resolve().parents[1],
                            env={**os.environ, 'PYTHONPATH': '.'}, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr


def test_external_publication_lock_does_not_block_patched_hub(tmp_path):
    script = r'''
from gevent import monkey
monkey.patch_all()
import gevent
from pathlib import Path
import subprocess
import sys
from shared.file_revision import publication_lock
path = Path(sys.argv[1]) / 'library.json'
child = subprocess.Popen([sys.executable, '-c', ''' + '"""' + r'''
import sys, time
from shared.file_revision import publication_lock
with publication_lock(sys.argv[1]):
    print('locked', flush=True)
    time.sleep(.3)
''' + '"""' + r''', str(path)], stdout=subprocess.PIPE, text=True)
assert child.stdout.readline().strip() == 'locked'
def acquire():
    with publication_lock(path):
        pass
job = gevent.spawn(acquire)
ticks = 0
while not job.ready():
    gevent.sleep(.01)
    ticks += 1
job.get()
assert child.wait() == 0
assert ticks > 5, ticks
'''
    result = subprocess.run([sys.executable, '-c', script, str(tmp_path)],
                            cwd=Path(__file__).resolve().parents[1],
                            env={**os.environ, 'PYTHONPATH': '.'}, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
