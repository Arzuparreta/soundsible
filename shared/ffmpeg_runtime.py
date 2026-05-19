"""
Resolve FFmpeg for consumer desktop bundles and dev installs.

Search order:
  1. SOUNDSIBLE_FFMPEG (explicit path to binary)
  2. Sibling of the running executable (Tauri externalBin / sidecar layout)
  3. PyInstaller _MEIPASS (when bundled inside the sidecar)
  4. packaging/vendor/ffmpeg-* (dev builds from fetch-ffmpeg.sh)
  5. PATH (shutil.which)

configure_ffmpeg() sets PATH, FFMPEG_BINARY, and returns a status dict for /api/health.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Any, Optional

_RESOLVED: Optional[Path] = None
_STATUS: dict[str, Any] = {"available": False, "path": None, "source": None}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _executable_dir() -> Path:
    return Path(sys.executable).resolve().parent


def _iter_candidates() -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []

    env_path = (os.getenv("SOUNDSIBLE_FFMPEG") or "").strip()
    if env_path:
        out.append(("env", Path(env_path)))

    exe_dir = _executable_dir()
    for name in ("ffmpeg", "ffmpeg.exe"):
        out.append(("sibling", exe_dir / name))

    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        base = Path(meipass)
        for name in ("ffmpeg", "ffmpeg.exe"):
            out.append(("bundle", base / name))

    vendor = _repo_root() / "desktop-shell" / "packaging" / "vendor"
    if vendor.is_dir():
        for child in sorted(vendor.glob("ffmpeg*")):
            if child.is_file() and os.access(child, os.X_OK):
                out.append(("vendor", child))

    which = shutil.which("ffmpeg")
    if which:
        out.append(("path", Path(which)))

    return out


def resolve_ffmpeg() -> Optional[Path]:
    """Return the first usable ffmpeg binary, or None."""
    global _RESOLVED
    if _RESOLVED is not None:
        return _RESOLVED

    for source, path in _iter_candidates():
        if path.is_file() and os.access(path, os.X_OK):
            _RESOLVED = path.resolve()
            _STATUS.update(
                {
                    "available": True,
                    "path": str(_RESOLVED),
                    "source": source,
                }
            )
            return _RESOLVED

    _RESOLVED = None
    _STATUS.update({"available": False, "path": None, "source": None})
    return None


def ffmpeg_status() -> dict[str, Any]:
    """Status block for /api/health (does not mutate PATH)."""
    resolve_ffmpeg()
    return dict(_STATUS)


def configure_ffmpeg() -> dict[str, Any]:
    """
    Resolve ffmpeg and wire environment for subprocess, ffmpeg-python, and yt-dlp.
    Safe to call multiple times.
    """
    path = resolve_ffmpeg()
    if path is None:
        return ffmpeg_status()

    bin_dir = str(path.parent)
    os.environ["SOUNDSIBLE_FFMPEG"] = str(path)
    os.environ["FFMPEG_BINARY"] = str(path)
    current_path = os.environ.get("PATH", "")
    if bin_dir not in current_path.split(os.pathsep):
        os.environ["PATH"] = bin_dir + os.pathsep + current_path
    return ffmpeg_status()


def ffmpeg_executable() -> str:
    """Path to ffmpeg for argv-style subprocess calls."""
    path = resolve_ffmpeg()
    if path is None:
        return "ffmpeg"
    return str(path)


def ytdlp_ffmpeg_location() -> Optional[str]:
    """yt-dlp ``ffmpeg_location`` — directory containing the binary."""
    path = resolve_ffmpeg()
    if path is None:
        return None
    return str(path.parent)


def apply_ytdlp_ffmpeg_options(opts: dict[str, Any]) -> dict[str, Any]:
    location = ytdlp_ffmpeg_location()
    if location:
        opts["ffmpeg_location"] = location
    return opts
