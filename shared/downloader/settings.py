"""The downloader's admin settings: one dotenv file in the config directory.

Settings → Downloads writes it: output folder, quality, cloud bucket
credentials, cookie sources and the yt-dlp / curl-cffi auto-updates.

It used to be `odst_tool/.env` inside the checkout, which a Docker container
lost on every recreate and a desktop bundle could not keep. The first read
adopts that file when the new one does not exist yet; the old file is left
where it was.
"""

from __future__ import annotations

import logging
import shutil
import threading
from pathlib import Path
from typing import Dict, Mapping, Optional

from shared.runtime import get_config_dir

logger = logging.getLogger(__name__)

FILE_NAME = "downloader.env"
_LEGACY_PATH = Path(__file__).resolve().parents[2] / "odst_tool" / ".env"

_lock = threading.Lock()
_cache: Dict[Path, Dict[str, str]] = {}


def settings_path() -> Path:
    return get_config_dir() / FILE_NAME


def _adopt_legacy(path: Path) -> None:
    if path.exists() or not _LEGACY_PATH.is_file():
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_LEGACY_PATH, path)
        logger.info("Downloader settings moved from %s to %s", _LEGACY_PATH, path)
    except OSError as exc:
        logger.warning("Could not adopt %s: %s", _LEGACY_PATH, exc)


def read_settings() -> Dict[str, str]:
    """The settings file as a dict, read from disk once per path."""
    path = settings_path()
    with _lock:
        cached = _cache.get(path)
        if cached is None:
            from dotenv import dotenv_values

            _adopt_legacy(path)
            cached = {k: v for k, v in dotenv_values(path).items() if v is not None} if path.exists() else {}
            _cache[path] = cached
        return dict(cached)


def setting(key: str, default: Optional[str] = None) -> Optional[str]:
    return read_settings().get(key, default)


def write_settings(values: Mapping[str, str]) -> None:
    """Write `values` into the settings file, keeping every other line."""
    from dotenv import set_key

    path = settings_path()
    with _lock:
        _adopt_legacy(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        for key, value in values.items():
            set_key(str(path), key, str(value))
        _cache.pop(path, None)


def export_to_environ() -> None:
    """Expose the settings as environment variables that are not already set.

    Code that reads `os.environ` (an output folder override, cloud
    credentials) sees the saved settings this way, as it did when the old
    file was loaded with `load_dotenv`.
    """
    import os

    for key, value in read_settings().items():
        os.environ.setdefault(key, value)
