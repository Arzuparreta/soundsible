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


def run_python(code: str, timeout: float = 60) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True,
                          timeout=timeout, env=ENV, cwd=ROOT)


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
