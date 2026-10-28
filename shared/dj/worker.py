"""DJ analysis in its own process, never inside the station's server.

Measuring a song decodes it with FFmpeg, runs Beat This! in ONNX Runtime and
does seconds of NumPy work. None of that may run in the engine: its single
cooperative loop stops serving while native code holds it, and the engine's
`fork()` of every subprocess deadlocks against a multi-threaded BLAS call in
flight (`shared.cooperative`). It did: from 2026-10-26 the station froze
until it was restarted by hand, one core at 100 %, right after DJ sessions
asked for analyses.

The engine keeps the cache, the identities and the queue (`store`); this
process only turns a file into an `Analysis`. One child measures one song at
a time and owns everything native. The engine starts it on the first request,
closes it after `IDLE_CLOSE_SECONDS` without work so its model and buffers do
not stay resident, and kills and replaces it when a measurement takes longer
than `JOB_TIMEOUT_SECONDS` or the child dies.

Protocol: one JSON object per line. The engine writes
`{"path": ..., "duration_hint": ...}` to the child's stdin; the child answers
on stdout with `{"analysis": Analysis | null}` (null: no beat model yet) or
`{"error": "..."}`. Anything else the child prints goes to stderr. The child
exits when its stdin closes.

The child reads its next request only between measurements, on its main
thread. A thread left blocked on stdin during a measurement deadlocked the
Windows build: with a synchronous read pending on a pipe, other calls on that
handle wait for the read, and loading NumPy's DLLs makes such a call
(measured on the desktop CI, 2026-10-28).
"""

from __future__ import annotations

import faulthandler
import json
import logging
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

from .contracts import Analysis

logger = logging.getLogger(__name__)

#: The argument a frozen engine executable recognises (see soundsible_engine.py).
FROZEN_FLAG = "--dj-analysis-worker"
#: Longest measurement. A song takes seconds; the first one may also download
#: the 84 MB model. A child still busy after this is stuck, not slow.
JOB_TIMEOUT_SECONDS = 600.0
#: The engine closes the child after this long without a request.
IDLE_CLOSE_SECONDS = 300.0
# The engine's own limit, after the child's: the child dumps its stacks first.
_REPLY_TIMEOUT_SECONDS = JOB_TIMEOUT_SECONDS + 30.0
_STOP_TIMEOUT_SECONDS = 5.0


class AnalysisFailed(RuntimeError):
    """The child gave no analysis for this source: error, crash or timeout."""


def _command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, FROZEN_FLAG]
    return [sys.executable, "-m", "shared.dj.worker"]


def _environment() -> dict[str, str]:
    """The engine's environment plus what it resolved in-process."""
    from shared.ffmpeg_runtime import resolve_ffmpeg
    from shared.runtime import get_cache_dir

    env = dict(os.environ)
    root = str(Path(__file__).resolve().parents[2])
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [root, env.get("PYTHONPATH")]))
    # Runtime directories can come from command-line flags, not only the
    # environment; the child must use the same cache (model download).
    env["SOUNDSIBLE_CACHE_DIR"] = str(get_cache_dir())
    ffmpeg = resolve_ffmpeg()
    if ffmpeg is not None:
        env["SOUNDSIBLE_FFMPEG"] = str(ffmpeg)
    return env


class AnalysisProcess:
    """The engine's handle on the analysis child; one measurement at a time.

    Every wait here is cooperative under gevent (the patched subprocess pipes,
    queue, lock and timer) and an ordinary blocking wait in a threaded process.
    """

    def __init__(self, command: list[str] | None = None, *, reply_timeout: float = _REPLY_TIMEOUT_SECONDS,
                 idle_close: float = IDLE_CLOSE_SECONDS):
        self._command = command
        self._reply_timeout = reply_timeout
        self._idle_close = idle_close
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._replies: queue.Queue | None = None
        self._idle_timer: threading.Timer | None = None
        self._generation = 0

    def measure(self, path: Path, duration_hint: float) -> Analysis | None:
        """The analysis of `path`, or None without a beat model. Raises `AnalysisFailed`."""
        request = (json.dumps({"path": str(path), "duration_hint": float(duration_hint or 0)}) + "\n").encode()
        with self._lock:
            self._generation += 1
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            try:
                return self._exchange(request)
            finally:
                self._arm_idle_close()

    def close(self) -> None:
        with self._lock:
            self._generation += 1
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            self._stop()

    def _exchange(self, request: bytes) -> Analysis | None:
        process, replies = self._running()
        try:
            process.stdin.write(request)
            process.stdin.flush()
        except OSError:
            code = self._stop(kill=True)
            raise AnalysisFailed(f"analysis process exited with status {code}") from None
        try:
            line = replies.get(timeout=self._reply_timeout)
        except queue.Empty:
            self._stop(kill=True)
            raise AnalysisFailed(f"no answer within {self._reply_timeout:.0f} s") from None
        if line is None:
            code = self._stop()
            raise AnalysisFailed(f"analysis process exited with status {code}")
        try:
            reply = json.loads(line)
        except ValueError:
            self._stop(kill=True)
            raise AnalysisFailed("analysis process broke its protocol") from None
        if "error" in reply:
            raise AnalysisFailed(str(reply["error"]))
        return reply.get("analysis")

    def _arm_idle_close(self) -> None:
        if self._process is None:
            return
        generation = self._generation
        timer = threading.Timer(self._idle_close, self._close_if_idle, args=(generation,))
        timer.daemon = True
        self._idle_timer = timer
        timer.start()

    def _close_if_idle(self, generation: int) -> None:
        with self._lock:
            # A measurement since this timer was armed owns the child now.
            if generation == self._generation:
                self._idle_timer = None
                self._stop()

    def _running(self) -> tuple[subprocess.Popen, queue.Queue]:
        if self._process is not None and self._process.poll() is None:
            return self._process, self._replies
        self._stop()
        try:
            process = subprocess.Popen(
                self._command or _command(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                env=_environment(),
            )
        except OSError as exc:
            raise AnalysisFailed(f"analysis process could not be started: {exc}") from exc
        replies: queue.Queue = queue.Queue()
        threading.Thread(target=_pump, args=(process.stdout, replies), name="dj-worker-replies", daemon=True).start()
        self._process, self._replies = process, replies
        return process, replies

    def _stop(self, *, kill: bool = False) -> int | None:
        """End the current child: politely (stdin closes, it exits) or at once."""
        process, self._process, self._replies = self._process, None, None
        if process is None:
            return None
        if kill:
            process.kill()
        try:
            process.stdin.close()
        except OSError:
            pass
        try:
            return process.wait(timeout=_STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait()


def _pump(stream, replies: queue.Queue) -> None:
    """Every line the child answers, then None once its stdout closes."""
    try:
        for line in iter(stream.readline, b""):
            replies.put(line)
    except (OSError, ValueError):
        pass
    finally:
        replies.put(None)


def main() -> int:
    """The child: measure each requested file until stdin closes."""
    # Before NumPy loads: one core for background analysis, as ONNX Runtime
    # already has, and no BLAS thread pool at all.
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    # The protocol owns the real stdout; anything a library prints, from
    # Python or C, lands on stderr instead.
    replies = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                        format="dj-analysis-worker %(levelname)s %(name)s: %(message)s")

    from . import store

    requests = sys.stdin.buffer
    while True:
        line = requests.readline()
        if not line:
            return 0
        # A measurement that never ends dumps where it is stuck and exits;
        # the engine starts a new child for the next request.
        faulthandler.dump_traceback_later(JOB_TIMEOUT_SECONDS, exit=True, file=sys.stderr)
        try:
            request = json.loads(line)
            reply = {"analysis": store._analyse_pcm(Path(request["path"]),
                                                    duration_hint=float(request.get("duration_hint") or 0))}
        except Exception as exc:
            logger.warning("Analysis failed: %s", line.decode("utf-8", "replace").strip()[:300], exc_info=True)
            reply = {"error": f"{type(exc).__name__}: {exc}"[:500]}
        finally:
            faulthandler.cancel_dump_traceback_later()
        replies.write(json.dumps(reply, separators=(",", ":")) + "\n")
        replies.flush()


if __name__ == "__main__":
    raise SystemExit(main())
