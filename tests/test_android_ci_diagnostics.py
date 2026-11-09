from pathlib import Path
import os
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from android_live_fixture import relay_peer_diagnostics
import android as android_script


def test_relay_diagnostics_preserve_counters_without_credentials():
    observed = relay_peer_diagnostics({
        "state": "read", "peerConnectionEstablished": True,
        "inboundRTPPackets": 100, "outboundRTPPackets": 90,
        "inboundRTPPacketsLost": 10, "inboundRTPPacketsJitter": .025,
        "query": "token=private", "remoteAddr": "private", "localCandidate": "private",
        "outboundBytes": "not a counter",
    })
    assert observed == {
        "state": "read", "peerConnectionEstablished": True,
        "inboundRTPPackets": 100, "outboundRTPPackets": 90,
        "inboundRTPPacketsLost": 10, "inboundRTPPacketsJitter": .025,
    }


def test_fixture_wifi_setup_recovers_adb_cold_boot_without_repeating_tests(monkeypatch, tmp_path):
    monkeypatch.setattr(android_script, 'sdk', lambda: tmp_path)
    monkeypatch.setattr(android_script.time, 'sleep', lambda _: None)
    responses = iter([
        subprocess.CompletedProcess([], 1, '', 'adb: device offline'),
        subprocess.CompletedProcess([], 255, '', ''),
        subprocess.CompletedProcess([], 0, '', ''),
    ])
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return next(responses)
    monkeypatch.setattr(android_script.subprocess, 'run', run)
    android_script.enable_fixture_network('emulator-5554')
    assert len(calls) == 3
    assert all(args[0][-6:] == ['-s', 'emulator-5554', 'shell', 'svc', 'wifi', 'enable'] for args in calls)
    assert all(0 < args[1]['timeout'] <= 5 for args in calls)


def test_emulator_probe_recovers_observed_closed_and_empty_255_failures(monkeypatch, tmp_path):
    monkeypatch.setattr(android_script, 'sdk', lambda: tmp_path)
    monkeypatch.setattr(android_script.time, 'sleep', lambda _: None)
    responses = iter([
        subprocess.CompletedProcess([], 1, '', 'error: closed'),
        subprocess.CompletedProcess([], 255, '', ''),
        subprocess.CompletedProcess([], 0, '1\n', ''),
    ])
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return next(responses)
    monkeypatch.setattr(android_script.subprocess, 'run', run)
    android_script.require_emulator('emulator-5554')
    assert len(calls) == 3
    assert all(command[-5:] == ['-s', 'emulator-5554', 'shell', 'getprop', 'ro.kernel.qemu']
               and 0 < kwargs['timeout'] <= 5 for command, kwargs in calls)


@pytest.mark.parametrize('code,output', [(0, '0'), (0, ''), (1, 'Permission denied'),
                                         (255, 'SecurityException'), (1, 'device unauthorized'),
                                         (1, 'unexpected error')])
def test_emulator_probe_rejects_non_emulator_and_permanent_errors_immediately(monkeypatch, tmp_path, code, output):
    monkeypatch.setattr(android_script, 'sdk', lambda: tmp_path)
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, code, output if code == 0 else '', output if code else '')
    monkeypatch.setattr(android_script.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='not a verified emulator' if code == 0 else 'Cannot verify emulator'):
        android_script.require_emulator('selected-device')
    assert len(calls) == 1


@pytest.mark.parametrize('failure', ['closed', 'timeout'])
def test_emulator_probe_deadline_preserves_failure(monkeypatch, tmp_path, failure):
    monkeypatch.setattr(android_script, 'sdk', lambda: tmp_path)
    now = [0.]
    monkeypatch.setattr(android_script.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(android_script.time, 'sleep', lambda seconds: now.__setitem__(0, now[0] + seconds))
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        if failure == 'timeout':
            now[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        return subprocess.CompletedProcess(command, 1, '', 'error: closed')
    monkeypatch.setattr(android_script.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='deadline exceeded.*' + ('timed out' if failure == 'timeout' else 'error: closed')):
        android_script.require_emulator('emulator-5554', timeout=1)
    assert len(calls) == (1 if failure == 'timeout' else 2)
    assert now[0] <= 1


@pytest.mark.parametrize('failure', ['offline', 'timeout', 'permission'])
def test_fixture_wifi_setup_is_bounded_and_keeps_the_cause(monkeypatch, tmp_path, failure):
    monkeypatch.setattr(android_script, 'sdk', lambda: tmp_path)
    now = [0.]
    monkeypatch.setattr(android_script.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(android_script.time, 'sleep', lambda seconds: now.__setitem__(0, now[0] + seconds))
    calls = []
    def run(command, **kwargs):
        calls.append(1)
        if failure == 'timeout':
            now[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        return subprocess.CompletedProcess(command, 255 if failure == 'permission' else 1, '',
                                           'Permission denied' if failure == 'permission' else 'adb: device offline')
    monkeypatch.setattr(android_script.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='Permission denied' if failure == 'permission' else 'deadline exceeded'):
        android_script.enable_fixture_network('emulator-5554', timeout=1)
    assert len(calls) == (1 if failure in ('permission', 'timeout') else 2)
    assert now[0] <= 1


@pytest.mark.parametrize("shard,failed_phase,code", [(6, "integration", 7), (0, "smoke", 9), (6, "none", 0)])
def test_shard_keeps_early_logs_and_original_exit_status(tmp_path, shard, failed_phase, code):
    binary = tmp_path / "bin"
    binary.mkdir()
    adb = binary / "adb"
    adb.write_text("#!/bin/sh\necho early-audio-evidence\n")
    adb.chmod(0o755)
    python = binary / "python"
    # Wait for evidence that the background stream started; independent of scheduling.
    python.write_text(f"""#!/bin/sh
while ! test -s android/build/emulator.log; do sleep .01; done
printf '%s\\n' "$2" >> phases
if [ "$2" = '{failed_phase}' ]; then exit {code}; fi
exit 0
""")
    python.chmod(0o755)
    script = Path(__file__).resolve().parents[1] / "scripts/android_ci_shard.sh"
    result = subprocess.run(["bash", str(script), str(shard), "8"], cwd=tmp_path,
                            env={**os.environ, "PATH": f"{binary}:{os.environ['PATH']}"}, timeout=5)
    assert result.returncode == code
    log = (tmp_path / "android/build/emulator.log").read_text()
    assert "early-audio-evidence" in log
    assert f"exit={code}" in log
    if failed_phase == "smoke":
        assert (tmp_path / "phases").read_text() == "smoke\n"
