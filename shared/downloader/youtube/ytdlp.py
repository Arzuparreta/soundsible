"""How a yt-dlp call reaches YouTube: network path, cookies, retries, formats."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

_FALSE_ENV_VALUES = {"0", "false", "no", "off"}
_SOCKET_TIMEOUT_DEFAULT = "30"
_HTTP_CHUNK_SIZE_DEFAULT = "10M"
_RETRY_SLEEP_DEFAULT = "exp=1:20"

# Prefer audio-only streams. If YouTube exposes only a progressive stream, choose
# the smallest audio-bearing fallback instead of an unnecessarily large video.
YDL_FORMAT_AUDIO = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]"

# Preview-tier selector: prefer the lowest useful audio bitrate first so the
# engine moves the fewest bytes possible during a preview (≈ itag 140 AAC 128k
# or itag 251 Opus 160k). The trailing fallback chain matches YDL_FORMAT_AUDIO
# so any video still resolves even when the abr-banded picks reject everything
# (e.g. Hi-Res lossless-only uploads where yt-dlp reports no abr field).
YDL_FORMAT_AUDIO_PREVIEW = (
    "bestaudio[ext=m4a][abr<=130]/bestaudio[ext=webm][abr<=170]/"
    "worstaudio[ext=m4a]/worstaudio[ext=webm]/worst[acodec!=none]/"
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]"
)


def yt_proxy() -> str:
    """The relay every YouTube request goes through, or "" for none."""
    return os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()


def force_ipv4() -> bool:
    return (os.getenv("SOUNDSIBLE_YTDLP_FORCE_IPV4", "true") or "").strip().lower() not in _FALSE_ENV_VALUES


def apply_network_options(opts: Dict[str, Any]) -> Dict[str, Any]:
    """Route an in-process yt-dlp call through the relay, or over IPv4."""
    from shared.ffmpeg_runtime import apply_ytdlp_ffmpeg_options

    proxy = yt_proxy()
    if proxy:
        opts["proxy"] = proxy
    elif force_ipv4():
        opts["source_address"] = "0.0.0.0"
    apply_ytdlp_ffmpeg_options(opts)
    return opts


def add_cli_network_args(args: List[str]) -> None:
    """The command-line form of `apply_network_options`, for the yt-dlp CLI."""
    proxy = yt_proxy()
    if proxy:
        args.extend(["--proxy", proxy])
    elif force_ipv4():
        args.append("--force-ipv4")


def download_resilience_args() -> List[str]:
    """Return bounded network settings for long-running yt-dlp downloads."""
    socket_timeout = (
        os.getenv("SOUNDSIBLE_YTDLP_SOCKET_TIMEOUT", _SOCKET_TIMEOUT_DEFAULT).strip()
        or _SOCKET_TIMEOUT_DEFAULT
    )
    http_chunk_size = (
        os.getenv("SOUNDSIBLE_YTDLP_HTTP_CHUNK_SIZE", _HTTP_CHUNK_SIZE_DEFAULT).strip()
        or _HTTP_CHUNK_SIZE_DEFAULT
    )
    retry_sleep = (
        os.getenv("SOUNDSIBLE_YTDLP_RETRY_SLEEP", _RETRY_SLEEP_DEFAULT).strip()
        or _RETRY_SLEEP_DEFAULT
    )
    return [
        "--socket-timeout",
        socket_timeout,
        "--http-chunk-size",
        http_chunk_size,
        "--retry-sleep",
        f"http:{retry_sleep}",
        "--retry-sleep",
        f"fragment:{retry_sleep}",
    ]


def should_retry_with_cookies(output: str) -> bool:
    """Whether a failed download is the kind that signing in can fix."""
    lowered = (output or "").lower()
    return any(
        marker in lowered
        for marker in (
            "requested format is not available",
            "the page needs to be reloaded",
            "sign in to confirm",
            "confirm your age",
            "age-restricted",
            "this video is private",
            "http error 403",
        )
    )


@dataclass(frozen=True)
class Cookies:
    """A cookies.txt file, a browser to read cookies from, or neither."""

    file: Optional[str] = None
    browser: Optional[str] = None

    def usable_file(self) -> Optional[str]:
        """The cookies file, when it exists on disk."""
        return self.file if self.file and os.path.exists(self.file) else None

    def ydl_options(self) -> Dict[str, Any]:
        """yt-dlp options for the preferred source: the file, else the browser."""
        if self.usable_file():
            return {"cookiefile": self.file}
        if self.browser:
            return {"cookiesfrombrowser": (self.browser, None, None, None)}
        return {}

    def cli_args(self) -> List[str]:
        """The command-line form of `ydl_options`."""
        if self.usable_file():
            return ["--cookies", self.file]
        if self.browser:
            return ["--cookies-from-browser", self.browser]
        return []
