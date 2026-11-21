"""The engine process: no BLAS thread pool beside fork(), and a loop that cannot stall silently."""
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ENV = {key: value for key, value in os.environ.items() if key != "OPENBLAS_NUM_THREADS"}
ENV["PYTHONPATH"] = os.pathsep.join(filter(None, [str(ROOT), os.environ.get("PYTHONPATH")]))


def run_python(code: str, timeout: float = 60, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True,
                          timeout=timeout, env={**ENV, **(env or {})}, cwd=ROOT)


def isolated_dirs(root: Path) -> dict:
    return {f"SOUNDSIBLE_{name}_DIR": str(root / name.lower()) for name in ("CONFIG", "DATA", "CACHE", "LOG")}


@pytest.mark.skipif(not hasattr(os, "fork"), reason="gevent forks only where fork exists")
def test_forking_beside_numpy_matrix_products_never_hangs():
    # The 2026-10-28 freeze: gevent's fork() on the loop while native threads
    # ran NumPy products deadlocked in OpenBLAS's atfork handler. Without the
    # thread limit this hangs within seconds; faulthandler turns a hang into a
    # failure instead of a stuck test run.
    result = run_python('''
        from shared.cooperative import patch_process
        patch_process()
        import faulthandler, subprocess, sys, time
        import gevent
        import numpy as np
        a = np.random.rand(1024, 513).astype(np.float32)
        b = np.random.rand(513, 128).astype(np.float32)
        end = time.monotonic() + 4
        def products():
            while time.monotonic() < end:
                a @ b
        jobs = [gevent.get_hub().threadpool.spawn(products) for _ in range(3)]
        faulthandler.dump_traceback_later(30, exit=True)
        forks = 0
        while time.monotonic() < end:
            subprocess.run(["true"], check=True)
            forks += 1
        gevent.joinall(jobs)
        faulthandler.cancel_dump_traceback_later()
        assert forks > 50, forks
    ''')
    assert result.returncode == 0, result.stderr[-3000:]


@pytest.mark.skipif(not Path("/proc/self/task").is_dir(), reason="counts threads through /proc")
def test_the_engine_process_starts_no_blas_threads():
    result = run_python('''
        import os
        from shared.cooperative import patch_process
        patch_process()
        before = len(os.listdir("/proc/self/task"))
        import numpy as np
        np.ones((512, 512)) @ np.ones((512, 512))
        assert len(os.listdir("/proc/self/task")) == before, os.listdir("/proc/self/task")
    ''')
    assert result.returncode == 0, result.stderr


def test_a_stalled_loop_dumps_every_thread_and_exits_with_failure():
    result = run_python('''
        from shared.cooperative import patch_process, start_loop_watchdog
        patch_process()
        import gevent
        from gevent import monkey
        start_loop_watchdog(1.0, rearm_seconds=0.1)
        gevent.sleep(2)  # A loop that runs is never interrupted.
        print("healthy", flush=True)
        def stuck_in_native_code():
            monkey.get_original("time", "sleep")(30)
        stuck_in_native_code()
    ''')
    assert result.stdout.strip() == "healthy"
    assert result.returncode == 1
    assert "Timeout" in result.stderr
    assert "stuck_in_native_code" in result.stderr


def test_a_disarmed_watchdog_lets_a_slow_shutdown_finish():
    result = run_python('''
        from shared.cooperative import patch_process, start_loop_watchdog, stop_loop_watchdog
        patch_process()
        import gevent
        from gevent import monkey
        start_loop_watchdog(0.5, rearm_seconds=0.1)
        gevent.sleep(0.3)
        stop_loop_watchdog()
        monkey.get_original("time", "sleep")(1.5)
    ''')
    assert result.returncode == 0, result.stderr


def test_the_watchdog_needs_a_cooperative_process():
    result = run_python('''
        import time
        from shared.cooperative import start_loop_watchdog
        start_loop_watchdog(0.2)
        time.sleep(0.6)
    ''')
    assert result.returncode == 0, result.stderr


# #492: blocking file and SQLite work must leave the loop running. Each test
# arms the watchdog for 1 s and blocks for 1.5 s inside the work: run on the
# hub, the process exits with status 1 before the work returns.

def test_off_loop_work_leaves_the_loop_running_and_returns_its_result():
    result = run_python('''
        from shared.cooperative import patch_process, start_loop_watchdog, off_loop
        patch_process()
        import gevent
        from gevent import monkey
        blocking_sleep = monkey.get_original("time", "sleep")
        start_loop_watchdog(1.0, rearm_seconds=0.1)
        gevent.sleep(0.2)  # Armed.
        ticks = []
        ticker = gevent.spawn(lambda: [ticks.append(gevent.sleep(0.05)) for _ in range(1000)])
        def blocking(value):
            blocking_sleep(1.5)
            return value
        assert off_loop(blocking, 42) == 42
        assert len(ticks) > 10, len(ticks)
        def failing():
            raise ValueError("from the thread")
        try:
            off_loop(failing)
        except ValueError as exc:
            assert str(exc) == "from the thread"
        else:
            raise AssertionError("the thread's exception was lost")
        ticker.kill()
    ''')
    assert result.returncode == 0, result.stderr[-3000:]


def test_an_interrupted_caller_still_waits_for_its_off_loop_work():
    # The work may hold a pooled connection mid-transaction; the caller must
    # not return it while the thread still runs.
    result = run_python('''
        from shared.cooperative import patch_process, off_loop
        patch_process()
        import gevent
        from gevent import monkey
        blocking_sleep = monkey.get_original("time", "sleep")
        finished = []
        def work():
            blocking_sleep(0.5)
            finished.append(True)
        caller = gevent.spawn(off_loop, work)
        gevent.sleep(0.1)
        caller.kill(block=True)
        assert finished == [True], finished
        assert isinstance(caller.value, gevent.GreenletExit), caller.value
    ''')
    assert result.returncode == 0, result.stderr[-3000:]


def test_a_slow_whole_library_save_does_not_stall_the_loop(tmp_path):
    result = run_python(f'''
        from shared.cooperative import patch_process, start_loop_watchdog
        patch_process()
        import gevent
        from gevent import monkey
        from shared import library_search
        from shared.database import DatabaseManager
        from shared.models import LibraryMetadata, Track
        blocking_sleep = monkey.get_original("time", "sleep")
        original_sync = library_search.sync
        def slow_sync(conn):
            blocking_sleep(1.5)  # Slow storage inside the transaction.
            return original_sync(conn)
        library_search.sync = slow_sync
        db = DatabaseManager({str(tmp_path / "library.db")!r})
        tracks = [Track(id=f"t{{i}}", title=f"Song {{i}}", artist="Artist", album="Album", duration=180,
                        file_hash=f"t{{i}}", original_filename=f"t{{i}}.flac", file_size=10, bitrate=900,
                        format="flac") for i in range(50)]
        start_loop_watchdog(1.0, rearm_seconds=0.1)
        gevent.sleep(0.2)  # Armed.
        ticks = []
        ticker = gevent.spawn(lambda: [ticks.append(gevent.sleep(0.05)) for _ in range(1000)])
        assert db.replace_library(LibraryMetadata(version=1, tracks=tracks, playlists={{}}, settings={{}})) == 1
        assert len(ticks) > 10, len(ticks)
        assert len(db.load_library_metadata().tracks) == 50
        ticker.kill()
    ''', env=isolated_dirs(tmp_path))
    assert result.returncode == 0, result.stderr[-3000:]


def test_slow_cover_extraction_does_not_stall_the_loop(tmp_path):
    source = tmp_path / "song.mp3"
    source.write_bytes(b"not really audio")
    result = run_python(f'''
        from shared.cooperative import patch_process, start_loop_watchdog
        patch_process()
        import os
        from types import SimpleNamespace
        import gevent
        from gevent import monkey
        from shared.audio_files import AudioProcessor
        from player.cover_manager import CoverFetchManager
        blocking_sleep = monkey.get_original("time", "sleep")
        def slow_read(path):
            blocking_sleep(1.5)  # A tag read from a slow network share.
            return b"cover"
        AudioProcessor.extract_cover_art = staticmethod(slow_read)
        manager = CoverFetchManager()
        track = SimpleNamespace(id="song", title="Song")
        start_loop_watchdog(1.0, rearm_seconds=0.1)
        gevent.sleep(0.2)  # Armed.
        ticks = []
        ticker = gevent.spawn(lambda: [ticks.append(gevent.sleep(0.05)) for _ in range(1000)])
        manager._process_track(track, {str(source)!r})
        assert len(ticks) > 10, len(ticks)
        ticker.kill()
        with open(os.path.join(manager.covers_dir, "song.jpg"), "rb") as handle:
            assert handle.read() == b"cover"
    ''', env=isolated_dirs(tmp_path))
    assert result.returncode == 0, result.stderr[-3000:]
