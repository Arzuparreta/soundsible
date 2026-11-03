from pathlib import Path
import os
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from android_live_fixture import relay_peer_diagnostics


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
