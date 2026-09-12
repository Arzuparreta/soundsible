"""Offline contract tests; YouTube is contacted only by the separate workflow."""
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import Mock

import pytest

from scripts import acquisition_canary as canary


def test_retry_and_recovery():
    runner = Mock(side_effect=[{"ok": False}, {"ok": True}])
    sleep = Mock()
    report = canary.run_canary(canary.DEFAULT_VIDEO_ID, "abc", run_attempt=runner, sleep=sleep)
    assert report["ok"] and report["recovered_on_retry"]
    assert len(report["attempts"]) == 2
    sleep.assert_called_once_with(30)


@pytest.mark.parametrize("ok, count", [(True, 1), (False, 2)])
def test_retry_budget(ok, count):
    runner = Mock(return_value={"ok": ok})
    report = canary.run_canary(canary.DEFAULT_VIDEO_ID, "abc", run_attempt=runner, sleep=Mock())
    assert report["ok"] is ok
    assert runner.call_count == count


@pytest.mark.parametrize("text, category", [
    ("Sign in to confirm you're not a bot", "authentication_challenge"),
    ("Video unavailable", "unavailable_fixture"),
    ("Connection timed out", "network_timeout"),
    ("Requested format is not available", "download_extraction_failure"),
    ("something unexpected", "unknown"),
])
def test_error_categories(text, category):
    assert canary.classify_error(text) == category


def test_report_sanitizes_sensitive_data():
    result = canary.sanitize("HTTP Error 403 https://host/audio?sig=SECRET\nAuthorization: Bearer SECRET\nCookie: SECRET\nProxy: SECRET\n" + "a" * 5000)
    assert "SECRET" not in result
    assert len(result) <= 4000


def test_isolated_environment(tmp_path, monkeypatch):
    for key in ("SOUNDSIBLE_YT_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "YT_DLP_OPTIONS", "PYTHONPATH", "OUTPUT_DIR"):
        monkeypatch.setenv(key, "personal-secret")
    env = canary.isolated_environment(tmp_path)
    assert "personal-secret" not in json.dumps(env)
    assert env["PYTHON_DOTENV_DISABLED"] == "1"
    assert env["SOUNDSIBLE_CONFIG_DIR"] == str(tmp_path / "config")
    assert env["XDG_CONFIG_HOME"] == str(tmp_path / "config")


@pytest.mark.parametrize("name", [None, "missing", "empty"])
def test_missing_audio(tmp_path, name):
    path = tmp_path / name if name else None
    if name == "empty":
        path.touch()
    with pytest.raises(ValueError, match="missing or empty"):
        canary.validate_audio(path)


def test_decode_real_audio_and_reject_garbage(tmp_path):
    import shutil
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg and ffprobe required")
    path = tmp_path / "test.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", str(path)], check=True)
    assert canary.validate_audio(path)["decoded_seconds"] == 5
    path.write_bytes(b"not audio")
    with pytest.raises(subprocess.CalledProcessError):
        canary.validate_audio(path)


def test_zero_exit_but_short_decode_is_rejected(tmp_path, monkeypatch):
    path = tmp_path / "audio"
    path.write_bytes(b"content")
    monkeypatch.setattr(canary.subprocess, "run", Mock(side_effect=[
        Mock(stdout=json.dumps({"streams": [{"codec_type": "audio"}], "format": {"duration": "10"}})),
        Mock(stdout=b"short"),
    ]))
    with pytest.raises(ValueError, match="did not decode"):
        canary.validate_audio(path)


def test_worker_uses_production_downloader_without_cookie_discovery(tmp_path, monkeypatch):
    from odst_tool.youtube_downloader import YouTubeDownloader
    download = Mock(return_value=tmp_path / "audio")
    monkeypatch.setattr(YouTubeDownloader, "_download_audio", download)
    monkeypatch.setattr(canary, "validate_audio", Mock(return_value={"decoded_seconds": 5}))
    assert canary.worker(canary.DEFAULT_VIDEO_ID, tmp_path)["ok"]
    download.assert_called_once_with(f"https://www.youtube.com/watch?v={canary.DEFAULT_VIDEO_ID}", ignore_config=True)
    download.side_effect = RuntimeError("HTTP Error 403 https://secret/url")
    result = canary.worker(canary.DEFAULT_VIDEO_ID, tmp_path)
    assert result["category"] == "download_extraction_failure"
    assert "https://secret" not in result["detail"]


def test_timeout_kills_worker_and_child_and_cleans_directory(tmp_path, monkeypatch):
    real_popen = subprocess.Popen
    child_pid = tmp_path / "child.pid"
    seen = []

    def launch(_args, **kwargs):
        seen.append(Path(kwargs["cwd"]))
        code = "import subprocess,sys,time,pathlib; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
        return real_popen([sys.executable, "-c", code, str(child_pid)], **kwargs)

    monkeypatch.setattr(canary.subprocess, "Popen", launch)
    result = canary.attempt(canary.DEFAULT_VIDEO_ID, timeout=1)
    assert result["category"] == "network_timeout"
    assert not seen[0].exists()
    pid = int(child_pid.read_text())
    stat = Path(f"/proc/{pid}/stat")
    # A killed child can briefly remain a zombie until init reaps it.
    assert not stat.exists() or stat.read_text().split()[2] == "Z"


def test_main_failure_writes_report_and_exits_nonzero(tmp_path, monkeypatch):
    report = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["canary", "--report", str(report)])
    monkeypatch.setattr(canary, "run_canary", lambda *args: {"ok": False, "attempts": [{"category": "invalid_audio"}]})
    assert canary.main() == 1
    assert json.loads(report.read_text())["attempts"][0]["category"] == "invalid_audio"


@pytest.mark.parametrize("ignore_config", [True, False])
def test_download_configuration_is_opt_in(tmp_path, monkeypatch, ignore_config):
    from odst_tool import youtube_downloader as yd
    calls = []

    def popen(args, **kwargs):
        calls.append(args)
        output = Path(args[args.index("-o") + 1].replace("%(ext)s", "m4a"))
        output.write_bytes(b"audio")
        return Mock(stdout=[], returncode=0)

    monkeypatch.setattr(yd.subprocess, "Popen", popen)
    monkeypatch.setattr(yd, "_audio_only", lambda path: path)
    downloader = yd.YouTubeDownloader(tmp_path, cookie_file=str(tmp_path / "absent"))
    assert downloader._download_audio("https://www.youtube.com/watch?v=YE7VzlLtp-4", ignore_config=ignore_config)
    assert ("--ignore-config" in calls[0]) is ignore_config
    assert "--cookies" not in calls[0]
