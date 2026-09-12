#!/usr/bin/env python3
"""Isolated, bounded smoke test of the production YouTube audio downloader."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

DEFAULT_VIDEO_ID = "YE7VzlLtp-4"  # Blender's Big Buck Bunny; also an upstream yt-dlp fixture.
ROOT = Path(__file__).resolve().parents[1]


def classify_error(message: str) -> str:
    lower = message.lower()
    for category, markers in (
        ("authentication_challenge", ("sign in", "not a bot", "confirm your age", "age-restricted")),
        ("unavailable_fixture", ("video unavailable", "private video", "video is private", "removed", "not available in your country")),
        ("network_timeout", ("timed out", "timeout")),
        ("download_extraction_failure", ("yt-dlp", "requested format", "http error", "unable to extract")),
    ):
        if any(marker in lower for marker in markers):
            return category
    return "unknown"


def sanitize(message: str) -> str:
    # Never retain URLs, header values or credential-bearing diagnostic lines.
    message = re.sub(r"https?://\S+", "[URL redacted]", message)
    message = re.sub(r"(?im)^.*(?:cookie|authorization|token|password|proxy|headers?).*$", "[sensitive line redacted]", message)
    message = re.sub(r"\x1b\[[0-9;]*m", "", message)
    return message[-4000:]


def isolated_environment(directory: Path) -> dict[str, str]:
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "SYSTEMROOT") if key in os.environ}
    env.update({
        "PYTHONPATH": str(ROOT), "PYTHON_DOTENV_DISABLED": "1",
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
        "OUTPUT_DIR": str(directory / "music"), "TMPDIR": str(directory),
        "XDG_CONFIG_HOME": str(directory / "config"),
        "XDG_CACHE_HOME": str(directory / "cache"),
        "XDG_DATA_HOME": str(directory / "data"),
    })
    for kind in ("CONFIG", "CACHE", "DATA", "LOG", "MUSIC"):
        env[f"SOUNDSIBLE_{kind}_DIR"] = str(directory / kind.lower())
    return env


def validate_audio(path: Path | None) -> dict:
    if path is None or not path.is_file() or path.stat().st_size == 0:
        raise ValueError("Downloader returned missing or empty audio")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, check=True, timeout=20,
    )
    metadata = json.loads(probe.stdout)
    streams = [s for s in metadata.get("streams", []) if s.get("codec_type") == "audio"]
    duration = float(metadata.get("format", {}).get("duration", 0))
    if not streams or not math.isfinite(duration) or duration < 5:
        raise ValueError("Output must contain an audio stream lasting at least five seconds")
    # Count decoded PCM bytes: ffmpeg may exit zero on truncated files, so its
    # return code alone cannot prove five seconds were actually decoded.
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-map", "0:a:0",
         "-t", "5", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
        capture_output=True, check=True, timeout=30,
    )
    if len(decoded.stdout) < 5 * 8000 * 2:
        raise ValueError("Output did not decode five seconds of audio")
    return {"bytes": path.stat().st_size, "duration_seconds": duration, "decoded_seconds": 5}


def worker(video_id: str, directory: Path) -> dict:
    sys.path.insert(0, str(ROOT))
    # Legacy ODST config creates Path.home()-relative directories on import.
    # Scope those to this disposable process without changing HOME itself.
    with patch.object(Path, "home", return_value=directory):
        from odst_tool.youtube_downloader import YouTubeDownloader
        downloader = YouTubeDownloader(output_dir=directory / "music", cookie_file=str(directory / "absent-cookies"))
        try:
            path = downloader._download_audio(f"https://www.youtube.com/watch?v={video_id}", ignore_config=True)
        except Exception as exc:
            return {"ok": False, "category": classify_error(str(exc)), "detail": sanitize(str(exc))}
        try:
            return {"ok": True, "validation": validate_audio(path)}
        except Exception as exc:
            detail = str(exc)
            if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
                detail += "\n" + (exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else exc.stderr)
            return {"ok": False, "category": "invalid_audio", "detail": sanitize(detail)}


def attempt(video_id: str, timeout: float = 240) -> dict:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="soundsible-canary-") as temporary:
        directory = Path(temporary)
        result_file = directory / "result.json"
        with (directory / "worker.log").open("w+") as log:
            proc = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--worker", str(directory), "--video-id", video_id],
                cwd=directory, env=isolated_environment(directory),
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
            )
            try:
                proc.wait(timeout=timeout)
                if result_file.exists():
                    result = json.loads(result_file.read_text())
                else:
                    log.seek(0, os.SEEK_END)
                    log.seek(max(0, log.tell() - 8000))
                    result = {"ok": False, "category": "unknown", "detail": sanitize(log.read())}
            except subprocess.TimeoutExpired:
                result = {"ok": False, "category": "network_timeout", "detail": f"Attempt exceeded the {timeout:g}-second deadline"}
            finally:
                # Descendants may survive their parent; kill the whole session
                # before deleting its files, even on supervisor exceptions.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
    result["elapsed_seconds"] = round(time.monotonic() - started, 3)
    return result


def run_canary(video_id: str, commit: str, *, run_attempt=attempt, sleep=time.sleep) -> dict:
    versions = {"python": sys.version.split()[0]}
    for package in ("yt-dlp", "curl-cffi"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "not installed"
    try:
        versions["ffmpeg"] = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
    except (OSError, subprocess.TimeoutExpired, IndexError):
        versions["ffmpeg"] = "unavailable"
    attempts = []
    for number in range(2):
        if number:
            sleep(30)
        started = time.monotonic()
        try:
            attempts.append(run_attempt(video_id))
        except Exception as exc:
            attempts.append({"ok": False, "category": "unknown", "detail": sanitize(str(exc)),
                             "elapsed_seconds": round(time.monotonic() - started, 3)})
        if attempts[-1]["ok"]:
            break
    return {"commit": commit, "video_id": video_id, "versions": versions,
            "ok": attempts[-1]["ok"], "recovered_on_retry": len(attempts) == 2 and attempts[-1]["ok"], "attempts": attempts}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video-id", default=DEFAULT_VIDEO_ID)
    parser.add_argument("--report", type=Path, default=Path("acquisition-canary.json"))
    parser.add_argument("--commit", default="unknown")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", args.video_id):
        parser.error("--video-id must be an eleven-character YouTube video ID")
    if args.worker:
        result = worker(args.video_id, args.worker)
        (args.worker / "result.json").write_text(json.dumps(result))
        return 0 if result["ok"] else 1
    if os.name != "posix":
        parser.error("Run in the production Docker image on non-POSIX hosts")
    report = run_canary(args.video_id, args.commit)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
