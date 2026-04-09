"""
Helpers for virtualenv-aware subprocess execution.
Use the project venv's Python when available so subprocesses (e.g. yt-dlp)
see the same dependencies as the main process.
"""
import os
import sys
from pathlib import Path


def _project_root() -> Path:
    """Project root (parent of shared/)."""
    return Path(__file__).resolve().parent.parent


def _venv_python() -> Path:
    """Path to venv Python, or None if venv does not exist."""
    root = _project_root()
    if os.name == "nt":
        exe = root / "venv" / "Scripts" / "python.exe"
    else:
        exe = root / "venv" / "bin" / "python"
    return exe if exe.exists() else None


def get_subprocess_python() -> str:
    """
    Return the Python executable to use for subprocesses (e.g. yt-dlp -m).
    Prefer the project venv so subprocesses see the same deps; otherwise sys.executable.
    """
    venv_py = _venv_python()
    return str(venv_py) if venv_py else sys.executable
