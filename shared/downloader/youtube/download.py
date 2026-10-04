"""Fetching a video's audio to a file with the yt-dlp CLI."""

from __future__ import annotations

import logging
import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from shared.venv_utils import get_subprocess_python

from ..config import DEFAULT_QUALITY, QUALITY_PROFILES
from .ytdlp import (
    YDL_FORMAT_AUDIO,
    Cookies,
    add_cli_network_args,
    download_resilience_args,
    force_ipv4,
    should_retry_with_cookies,
    yt_proxy,
)

logger = logging.getLogger(__name__)

_PROGRESS_LINE = re.compile(
    r"\[download\]\s+(?P<pct>\d+\.?\d*)%\s+of\s+(?:~\s*)?(?P<total>[\d.]+)(?P<tunit>[KMGT]?i?B)"
    r"(?:\s+at\s+(?P<speed>\S+))?(?:\s+ETA\s+(?P<eta>\S+))?",
    re.IGNORECASE,
)
# Some yt-dlp builds print "100% of 3.21MiB in 00:05", with no speed or ETA.
_PROGRESS_IN = re.compile(
    r"\[download\]\s+(?P<pct>\d+\.?\d*)%\s+of\s+(?:~\s*)?(?P<total>[\d.]+)(?P<tunit>[KMGT]?i?B)\s+in\s+",
    re.IGNORECASE,
)
_UNIT_BYTES = {
    "B": 1,
    "KIB": 1024, "KB": 1024,
    "MIB": 1024**2, "MB": 1024**2,
    "GIB": 1024**3, "GB": 1024**3,
    "TIB": 1024**4, "TB": 1024**4,
}


def _size_str_to_bytes(amount: str, unit: str) -> Optional[int]:
    try:
        value = float(amount)
    except (TypeError, ValueError):
        return None
    factor = _UNIT_BYTES.get((unit or "").strip().upper().replace("İ", "I"))
    return int(value * factor) if factor else None


def parse_progress(line: str) -> Optional[Dict[str, Any]]:
    """A progress update from one line of yt-dlp output, or None."""
    if "[ExtractAudio]" in line or "[Metadata]" in line or "[Merger]" in line:
        return {"phase": "processing"}
    if "Post-processing" in line:
        return {"phase": "processing"}
    m = _PROGRESS_LINE.search(line)
    speed = eta = None
    if m:
        speed = m.group("speed")
        eta = m.group("eta")
    else:
        m = _PROGRESS_IN.search(line)
    if not m:
        return None
    out: Dict[str, Any] = {
        "phase": "downloading",
        "percent": min(100.0, max(0.0, float(m.group("pct")))),
        "speed": speed.strip() if speed else None,
        "eta": eta.strip() if eta else None,
    }
    total_b = _size_str_to_bytes(m.group("total"), m.group("tunit"))
    if total_b is not None:
        out["total_bytes"] = total_b
    return out


def audio_only(path: Path) -> Path:
    """Strip anything that is not the music before this file becomes a track.

    `YDL_FORMAT_AUDIO` ends in `worst[acodec!=none]`, which is the right last
    resort for availability — a song that only exists inside a progressive
    upload is still a song — but what it hands back is a 360p video with the
    audio muxed in. Stored as-is it costs the listener four times the bytes of
    the music, and `--embed-thumbnail`'s 1280x720 PNG then sits in the header,
    where a decoder must read all of it before the first sample. One library
    reached 95 of 95 MP4s like that.

    The clean-up is a remux, so the audio is untouched, and it runs before the
    hash is taken: the file that enters the library is the file it is named
    after, and no track id has to be remapped.
    """
    try:
        from shared.library_repair import repair_file

        result = repair_file(path)
        return Path(result.path) if result else path
    except Exception as exc:  # never let tidying cost a completed download
        logger.debug("Could not strip non-audio streams from %s: %s", path, exc)
        return path


def _ffmpeg_available() -> bool:
    """True when an ffmpeg binary resolves on this host.

    Hosts without one (notably Android, until per-ABI binaries are bundled)
    must skip conversion and post-processing: yt-dlp fails the whole
    download when its --embed-thumbnail/--add-metadata/-x helpers cannot
    exec ffmpeg.
    """
    try:
        from shared.ffmpeg_runtime import resolve_ffmpeg

        return resolve_ffmpeg() is not None
    except Exception:
        return False


def _ytdlp_argv(output_template: str, *, convert_to: Optional[Dict[str, Any]]) -> List[str]:
    """yt-dlp arguments only (no interpreter prefix): the form `_real_main` takes."""
    postprocess = _ffmpeg_available()
    if convert_to and not postprocess:
        logger.info("yt-dlp: no ffmpeg on this host; keeping the native stream instead of converting")
        convert_to = None
    args = ["-f", YDL_FORMAT_AUDIO]
    if convert_to:
        # `best` keeps the stream's own codec. Converting YouTube's Opus or AAC
        # to FLAC stores the same sound at up to twelve times the size.
        codec = convert_to["format"]
        args.extend(["-x", "--audio-format", codec])
        if convert_to.get("bitrate", 0) > 0 and codec == "mp3":
            args.extend(["--audio-quality", str(convert_to["bitrate"])])
    add_cli_network_args(args)
    args.extend(download_resilience_args())
    args.extend([
        # yt-dlp's own default first, as the stream resolver does. The
        # android and ios responses now arrive without their audio URLs
        # (no PO token), and web alone may offer only the 49k AAC
        # (itag 139), which `bestaudio[ext=m4a]` then happily picks.
        "--extractor-args", "youtube:player_client=default,android,ios",
    ])
    if postprocess:
        args.extend([
            "--add-metadata",
            "--embed-thumbnail",
            "--parse-metadata", "playlist_index:%(track_number)s",
        ])
    args.extend([
        "-o", output_template,
        "--retries", "10",
        "--no-warnings",
        "--newline",
        "--progress",
    ])
    return args


def _yt_dlp_args(output_template: str, *, convert_to: Optional[Dict[str, Any]]) -> List[str]:
    """Full CLI form: interpreter prefix plus :func:`_ytdlp_argv`."""
    return [get_subprocess_python(), "-u", "-m", "yt_dlp", *_ytdlp_argv(output_template, convert_to=convert_to)]


def args_exe_hint(args: List[str]) -> str:
    """Interpreter used for a CLI argv, for empty-output diagnostics."""
    return args[0] if args else "<empty argv>"


def download_audio(
    url: str,
    temp_dir: Path,
    cookies: Cookies,
    quality: str,
    progress_callback: Optional[Callable[..., None]] = None,
) -> Path:
    """Download a video's audio into `temp_dir` and return the file.

    Native audio first: no re-encode is faster and fails less with unusual
    uploads. Then the same with cookies, when the failure is one signing in
    can fix. Converting to the quality profile's codec is the last resort.
    Raises with yt-dlp's output when every attempt fails.
    """
    temp_filename = f"temp_{os.getpid()}_{time.time_ns()}_{uuid.uuid4().hex[:6]}"
    output_template = str(temp_dir / f"{temp_filename}.%(ext)s")
    profile = QUALITY_PROFILES.get(quality, QUALITY_PROFILES[DEFAULT_QUALITY])
    cookie_args = cookies.cli_args()

    from shared.venv_utils import has_working_subprocess_python

    if not has_working_subprocess_python():
        return download_audio_api(url, temp_dir, cookies, quality, progress_callback)

    def run(args: List[str]) -> tuple[int, str]:
        output = []
        proc = subprocess.Popen(
            args,
            cwd=str(temp_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        try:
            if proc.stdout:
                for line in proc.stdout:
                    output.append(line)
                    if progress_callback:
                        try:
                            parsed = parse_progress(line.rstrip())
                            if parsed:
                                progress_callback(parsed)
                        except Exception as ex:
                            logger.debug("progress_callback error: %s", ex)
            proc.wait(timeout=600)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
            raise
        return proc.returncode, "".join(output)

    def downloaded() -> Optional[Path]:
        for path in temp_dir.glob(f"{temp_filename}.*"):
            return audio_only(path)
        return None

    native = _yt_dlp_args(output_template, convert_to=None)
    returncode, output = run([*native, url])
    if returncode == 0 and (path := downloaded()):
        return path

    if returncode != 0 and cookie_args and should_retry_with_cookies(output):
        returncode, output = run([*native, *cookie_args, url])
        if returncode == 0 and (path := downloaded()):
            return path

    returncode, output = run([*_yt_dlp_args(output_template, convert_to=profile), *cookie_args, url])
    if returncode == 0 and (path := downloaded()):
        return path

    if not output.strip():
        # A bare exit code with no output is undiagnosable from the queue;
        # record how the CLI was invoked so the next report names the cause.
        output = (
            f"(no output captured; exe={args_exe_hint(native)!r} "
            f"cwd={temp_dir} playback of {url!r} never started)"
        )
    raise Exception(output or f"yt-dlp exited {returncode}")


def _api_progress_hook(progress_callback) -> Callable[..., None]:
    """Translate a yt-dlp progress dict into the queue's update shape."""
    def hook(d: Dict[str, Any]) -> None:
        try:
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes") or 0
                percent = (downloaded / total * 100.0) if total else 0.0
                progress_callback({
                    "phase": "downloading",
                    "percent": min(100.0, max(0.0, percent)),
                    "speed": d.get("speed"),
                    "eta": d.get("eta"),
                    "total_bytes": total,
                })
            elif d.get("status") == "finished":
                progress_callback({"phase": "processing"})
        except Exception as ex:
            logger.debug("progress_callback error: %s", ex)

    return hook


def download_audio_api(
    url: str,
    temp_dir: Path,
    cookies: Cookies,
    quality: str,
    progress_callback: Optional[Callable[..., None]] = None,
) -> Path:
    """Download via the YoutubeDL API, YTDLnis-style: no CLI, no subprocess.

    Hosts without a working subprocess Python (Android) cannot exec
    `python -m yt_dlp`, and emulating the CLI through `_real_main` proved
    fragile (silent exit codes, captured-output games). Driving the library
    directly raises real errors and reports live progress through hooks --
    the same pattern `streams.py` and `search.py` already use in-process.
    Post-processors follow the ffmpeg gate: without a binary there is no
    thumbnail/metadata embedding or conversion; downstream mutagen tagging
    (`embed_metadata`) covers tags without it.
    """
    import yt_dlp

    # Note: quality conversion profiles (-x) need ffmpeg, which hosts on this
    # path do not have; the native stream is kept (same rule as _ytdlp_argv).
    temp_filename = f"temp_{os.getpid()}_{time.time_ns()}_{uuid.uuid4().hex[:6]}"
    outtmpl = str(temp_dir / f"{temp_filename}.%(ext)s")

    def base_opts(with_cookies: bool) -> Dict[str, Any]:
        opts: Dict[str, Any] = {
            "format": YDL_FORMAT_AUDIO,
            "outtmpl": outtmpl,
            "extractor_args": {"youtube": {"player_client": ["default", "android", "ios"]}},
            "retries": 10,
            "socket_timeout": 30,
            "quiet": True,
            "no_warnings": True,
        }
        proxy = yt_proxy()
        if proxy:
            opts["proxy"] = proxy
        elif force_ipv4():
            opts["source_address"] = "0.0.0.0"
        if with_cookies:
            opts.update(cookies.ydl_options())
        if _ffmpeg_available():
            opts["postprocessors"] = [
                {"key": "FFmpegMetadata", "add_metadata": True},
                {"key": "EmbedThumbnail"},
            ]
        if progress_callback:
            opts["progress_hooks"] = [_api_progress_hook(progress_callback)]
        return opts

    def downloaded() -> Optional[Path]:
        for path in temp_dir.glob(f"{temp_filename}.*"):
            return audio_only(path)
        return None

    def attempt(with_cookies: bool) -> None:
        with yt_dlp.YoutubeDL(base_opts(with_cookies)) as ydl:
            ydl.download([url])

    try:
        attempt(False)
        if downloaded():
            return downloaded()  # type: ignore[return-value]
    except Exception as first:
        cookie_opts = cookies.ydl_options()
        if cookie_opts and should_retry_with_cookies(str(first)):
            try:
                attempt(True)
                if downloaded():
                    return downloaded()  # type: ignore[return-value]
            except Exception as second:
                raise Exception(str(second) or str(first))
        raise Exception(str(first) or "yt-dlp download failed")

    raise Exception("yt-dlp produced no file")
