"""DJ analysis runs in its own process; the engine's loop never carries it."""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from shared.dj import store, weights
from shared.dj.worker import AnalysisFailed, AnalysisProcess

ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(ROOT), os.environ.get("PYTHONPATH")]))}


def fake_worker(body: str) -> list[str]:
    """A child speaking the protocol: `body` maps a request dict to a reply dict."""
    code = textwrap.dedent('''
        import json, os, sys, time
        def reply(request):
        {body}
        for line in sys.stdin:
            sys.stdout.write(json.dumps(reply(json.loads(line))) + "\\n")
            sys.stdout.flush()
    ''').format(body=textwrap.indent(textwrap.dedent(body), "    "))
    return [sys.executable, "-c", code]


def run_python(code: str, timeout: float = 60) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True,
                          timeout=timeout, env=ENV, cwd=ROOT)


def test_the_engine_gets_exactly_the_in_process_analysis(tmp_path):
    import wave

    from test_dj_beat_grid import song

    assert weights.session() is not None, "run scripts/fetch_dj_model.py"
    path = tmp_path / "song.wav"
    song(path, 123.0, seconds=30.0)
    with wave.open(str(path)) as source:
        assert source.getframerate() == 22050
    process = AnalysisProcess()
    try:
        measured = process.measure(path, 30.0)
    finally:
        process.close()
    expected = store._analyse_pcm(path, duration_hint=30.0)
    assert measured["analysed"] is True
    assert json.dumps(measured, sort_keys=True) == json.dumps(expected, sort_keys=True)


def test_waiting_for_a_measurement_keeps_the_cooperative_loop_running():
    # As the daemon runs: patched process, a native (non-cooperative) child
    # busy for 0.6 s while a greenlet keeps ticking.
    command = fake_worker('''
        time.sleep(0.6)
        return {"analysis": {"path": request["path"]}}
    ''')
    result = run_python(f'''
        from shared.cooperative import patch_process
        patch_process()
        import gevent
        from pathlib import Path
        from shared.dj.worker import AnalysisProcess
        ticks = []
        ticker = gevent.spawn(lambda: [ticks.append(gevent.sleep(0.02)) for _ in iter(int, 1)])
        process = AnalysisProcess({command!r})
        assert process.measure(Path("/song"), 1) == {{"path": "/song"}}
        process.close()
        ticker.kill()
        assert len(ticks) >= 15, len(ticks)
    ''')
    assert result.returncode == 0, result.stderr


def test_a_stuck_measurement_is_killed_and_the_next_one_gets_a_new_process():
    command = fake_worker('''
        if request["path"] == "/stuck":
            time.sleep(60)
        return {"analysis": {"pid": os.getpid()}}
    ''')
    process = AnalysisProcess(command, reply_timeout=1)
    try:
        first = process.measure(Path("/ok"), 0)["pid"]
        with pytest.raises(AnalysisFailed, match="no answer"):
            process.measure(Path("/stuck"), 0)
        assert process.measure(Path("/ok"), 0)["pid"] != first
    finally:
        process.close()


def test_a_crash_fails_only_its_own_measurement():
    command = fake_worker('''
        if request["path"] == "/crash":
            os._exit(3)
        return {"analysis": {"pid": os.getpid()}}
    ''')
    process = AnalysisProcess(command)
    try:
        with pytest.raises(AnalysisFailed, match="status 3"):
            process.measure(Path("/crash"), 0)
        assert process.measure(Path("/ok"), 0)["pid"]
    finally:
        process.close()


def test_a_child_that_exited_after_idling_is_replaced_without_losing_the_request():
    # Answers once, then exits cleanly, like the idle exit racing the next request.
    command = fake_worker('''
        print(json.dumps({"analysis": {"pid": os.getpid()}}), flush=True)
        os._exit(0)
    ''')
    process = AnalysisProcess(command)
    try:
        first = process.measure(Path("/a"), 0)["pid"]
        assert process.measure(Path("/b"), 0)["pid"] != first
    finally:
        process.close()


def test_an_error_reply_fails_the_measurement_and_keeps_the_child():
    command = fake_worker('''
        if request["path"] == "/bad":
            return {"error": "ValueError: unreadable"}
        return {"analysis": {"pid": os.getpid()}}
    ''')
    process = AnalysisProcess(command)
    try:
        first = process.measure(Path("/ok"), 0)["pid"]
        with pytest.raises(AnalysisFailed, match="unreadable"):
            process.measure(Path("/bad"), 0)
        assert process.measure(Path("/ok"), 0)["pid"] == first
    finally:
        process.close()


def test_output_printed_during_a_measurement_cannot_corrupt_the_replies():
    # The real child loop, with a measurement that prints from Python and C level.
    code = textwrap.dedent('''
        import os, sys
        from shared.dj import store, worker
        def noisy(path, *, duration_hint):
            print("stray print")
            os.write(1, b"stray fd write\\n")
            return {"path": str(path), "hint": duration_hint}
        store._analyse_pcm = noisy
        raise SystemExit(worker.main())
    ''')
    process = AnalysisProcess([sys.executable, "-c", code])
    try:
        assert process.measure(Path("/song"), 7) == {"path": "/song", "hint": 7.0}
        assert process.measure(Path("/next"), 0) == {"path": "/next", "hint": 0.0}
    finally:
        process.close()


def test_the_child_exits_when_the_engine_goes_away():
    code = "from shared.dj import worker; raise SystemExit(worker.main())"
    child = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=ENV)
    child.stdin.close()
    assert child.wait(timeout=30) == 0


class _Failing:
    def __init__(self):
        self.calls = 0

    def measure(self, path, duration_hint):
        self.calls += 1
        raise AnalysisFailed("stuck")


def test_a_source_the_process_cannot_measure_is_not_retried_until_it_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "_cache_path", lambda: tmp_path / "analysis.sqlite3")
    monkeypatch.setattr(store, "_unmeasurable", {})
    failing = _Failing()
    monkeypatch.setattr(store, "_process", failing)
    source = tmp_path / "song.audio"
    source.write_bytes(b"first")

    assert store.analyse_audio(source, "song", duration_hint=200)["analysed"] is False
    assert store.analyse_audio(source, "song", duration_hint=200)["analysed"] is False
    assert failing.calls == 1
    assert store.cached_analysis(source, "song") is None

    source.write_bytes(b"replaced with other bytes")
    store.analyse_audio(source, "song")
    assert failing.calls == 2


def test_the_engine_measures_through_the_process_once_started(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "_cache_path", lambda: tmp_path / "analysis.sqlite3")
    monkeypatch.setattr(store, "_process", None)
    monkeypatch.setattr(store, "_analyse_pcm", lambda *a, **k: pytest.fail("measured inside the engine"))
    started = []
    monkeypatch.setattr(store, "AnalysisProcess", lambda: started.append(1) or type(
        "Stub", (), {"measure": lambda self, p, d: {"analysed": True, "version": store.ANALYSER_VERSION},
                     "close": lambda self: started.append("closed")})())
    source = tmp_path / "song.audio"
    source.write_bytes(b"audio")
    store.start_analysis_process()
    try:
        assert store.analyse_audio(source, "song")["analysed"] is True
        assert store.cached_analysis(source, "song")["analysed"] is True
    finally:
        store.stop_analysis_process()
    assert started == [1, "closed"]
