"""Resolve repository / PyInstaller bundle roots."""

from __future__ import annotations

import sys
from pathlib import Path


def repo_root() -> Path:
    """Return the repo root in dev, or the PyInstaller extract dir when frozen."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parents[1]


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))
