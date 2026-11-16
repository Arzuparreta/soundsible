"""Keep the network-facing download tools current: chosen in settings, upgraded at boot."""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path


RUNTIME_UPDATE_OPTIONS = (
    ("yt-dlp", "YTDLP_AUTO_UPDATE"),
    ("curl-cffi", "CURL_CFFI_AUTO_UPDATE"),
)


def enabled_runtime_packages(
    file_env: Mapping[str, str | None],
    process_env: Mapping[str, str] | None = None,
) -> tuple[list[str], dict[str, bool]]:
    """Return pip package names and resolved flags from file/env configuration."""
    environ = process_env if process_env is not None else os.environ
    packages: list[str] = []
    flags: dict[str, bool] = {}
    for package, env_key in RUNTIME_UPDATE_OPTIONS:
        raw = str(file_env.get(env_key) or environ.get(env_key, "false")).strip()
        enabled = raw.lower() in {"true", "1"}
        flags[env_key] = enabled
        if enabled:
            packages.append(package)
    return packages, flags


def pip_upgrade_command(
    repo_root: Path,
    packages: Sequence[str],
    *,
    python_executable: str | None = None,
    platform_name: str | None = None,
) -> list[str]:
    """Build one upgrade command for all enabled tools in the active repo env."""
    if not packages:
        raise ValueError("at least one package is required")
    windows = (platform_name if platform_name is not None else os.name) == "nt"
    relative_pip = Path("Scripts/pip.exe") if windows else Path("bin/pip")
    for env_name in ("venv", ".venv"):
        pip_executable = repo_root / env_name / relative_pip
        if pip_executable.is_file():
            return [str(pip_executable), "install", "--upgrade", *packages]
    return [
        python_executable or sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        *packages,
    ]


#: Modules an upgrade replaces on disk. Once one is imported, an upgrade would
#: leave the old code in memory loading new files on demand (yt-dlp imports
#: each extractor on first use), so the upgrade has to come first.
_UPDATED_MODULES = {"yt-dlp": "yt_dlp", "curl-cffi": "curl_cffi"}
UPDATE_TIMEOUT_SEC = 120


def apply_runtime_updates(file_env: Mapping[str, str | None] | None = None) -> bool:
    """Upgrade the enabled download tools before anything imports them.

    Called by the entry points before `shared.api`, which imports yt-dlp. It
    runs pip to completion: a background upgrade ran with yt-dlp already
    loaded, and the extractor imported later came from the new release while
    the core in memory was the old one. Returns whether pip ran and succeeded.
    """
    import logging
    import subprocess

    from shared.bundle_paths import is_frozen, repo_root

    logger = logging.getLogger(__name__)
    if file_env is None:
        from shared.downloader.settings import read_settings

        file_env = read_settings()
    packages, _ = enabled_runtime_packages(file_env)
    if not packages:
        return False
    if is_frozen():
        # The desktop bundle carries its own copy; there is no pip to run.
        logger.info("Runtime auto-update skipped: this build bundles %s", ", ".join(packages))
        return False
    loaded = [name for name in packages if _UPDATED_MODULES.get(name) in sys.modules]
    if loaded:
        logger.warning("Runtime auto-update skipped: %s already imported", ", ".join(loaded))
        return False
    command = pip_upgrade_command(repo_root(), packages)
    logger.info("Runtime auto-update: %s", " ".join(command))
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=UPDATE_TIMEOUT_SEC)
    except (OSError, subprocess.TimeoutExpired) as error:
        logger.warning("Runtime auto-update failed: %s", error)
        return False
    if result.returncode != 0:
        logger.warning("Runtime auto-update failed: %s", (result.stderr or result.stdout or "unknown")[-800:])
        return False
    logger.info("Runtime auto-update completed for %s", ", ".join(packages))
    return True
