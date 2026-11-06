"""Deadline-bound child execution with bounded diagnostics and cancellation."""
from contextlib import contextmanager
from contextvars import ContextVar
from collections import deque
import os
import queue
import signal
import subprocess
import threading
import time

from shared.work import check as check_work

_cancel_probe = ContextVar('acquisition_cancel_probe', default=None)


class AcquisitionCancelled(BaseException):
    """Unwind provider fallback loops; an obsolete attempt must not retry."""


@contextmanager
def acquisition_scope(probe):
    token = _cancel_probe.set(probe)
    try:
        yield
    finally:
        _cancel_probe.reset(token)


def check_cancelled():
    check_work()
    probe = _cancel_probe.get()
    if probe and probe():
        raise AcquisitionCancelled()


OUTPUT_BYTES = 64 * 1024


def stop_tree(process):
    """The child may own FFmpeg, or a descendant may still own its stdout."""
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(process.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        try:
            process.kill()
        except OSError:
            pass


def run(args, *, deadline, cwd=None, on_line=None):
    """One budget includes pipe reading, silence, descendants and child exit.

    The pump's bounded chunks also bound a child printing without newlines.
    Callback lines are capped; diagnostics retain a byte tail plus retry causes.
    """
    check_cancelled()
    if deadline <= time.monotonic():
        raise subprocess.TimeoutExpired(args, 0)
    process = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               env={**os.environ, 'PYTHONUNBUFFERED': '1'},
                               start_new_session=os.name != 'nt',
                               creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP | 4) if os.name == 'nt' else 0)
    job = None
    if os.name == 'nt':
        try:
            from shared.windows_job import ProcessJob
            job = ProcessJob(process)
        except BaseException:
            process.kill()
            process.wait(timeout=5)
            process.stdout.close()
            raise
    chunks = queue.Queue(maxsize=8)
    stopped = threading.Event()

    def pump():
        try:
            while not stopped.is_set():
                chunk = process.stdout.read1(4096)
                while not stopped.is_set():
                    try:
                        chunks.put(chunk, timeout=.1)
                        break
                    except queue.Full:
                        pass
                if not chunk:
                    return
        except (OSError, ValueError):
            if not stopped.is_set():
                chunks.put(b'')

    reader = threading.Thread(target=pump, name='download-output', daemon=True)
    reader.start()
    tail = deque(maxlen=16)
    pending = b''
    markers = set()
    eof = False
    try:
        while not eof or process.poll() is None:
            check_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(args, 0)
            try:
                chunk = chunks.get(timeout=min(.2, remaining))
            except queue.Empty:
                continue
            if not chunk:
                eof = True
                continue
            tail.append(chunk)
            text = (pending + chunk).decode('utf-8', 'replace')
            for marker in ('requested format is not available', 'the page needs to be reloaded',
                           'sign in to confirm', 'confirm your age', 'age-restricted',
                           'this video is private', 'http error 403'):
                if marker in text.lower():
                    markers.add(marker)
            lines = (pending + chunk).split(b'\n')
            pending = lines.pop()[-4096:]
            if on_line:
                for line in lines:
                    on_line(line[-4096:].decode('utf-8', 'replace'))
        return process.returncode, '\n'.join(sorted(markers)) + '\n' + b''.join(tail).decode('utf-8', 'replace')
    finally:
        stopped.set()
        # Even an exited parent can leave a descendant holding the pipe open.
        if job is not None:
            job.close()
        else:
            stop_tree(process)
        process.wait(timeout=5)
        process.stdout.close()
        reader.join(timeout=1)
