"""Keep the network-facing download tools current: chosen in settings, upgraded at boot."""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping, Sequence


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


def pip_upgrade_command(packages: Sequence[str], *, python_executable: str | None = None) -> list[str]:
    """One upgrade of every enabled tool, by the interpreter running the engine.

    Its own pip installs where its imports look. A repository `venv` beside it
    may be a different environment from the one `SOUNDSIBLE_PYTHON` or the
    service unit chose.
    """
    if not packages:
        raise ValueError("at least one package is required")
    return [python_executable or sys.executable, "-m", "pip", "install", "--upgrade", *packages]


#: Modules an upgrade replaces on disk. Once one is imported, an upgrade would
#: leave the old code in memory loading new files on demand (yt-dlp imports
#: each extractor on first use), so the upgrade has to come first.
_UPDATED_MODULES = {"yt-dlp": "yt_dlp", "curl-cffi": "curl_cffi"}
UPDATE_TIMEOUT_SEC = 120


def apply_runtime_updates(file_env: Mapping[str, str | None] | None = None) -> bool:
    """Upgrade the enabled download tools before anything imports them.

    `run.py --daemon` calls it before `shared.api`, which imports yt-dlp. It
    runs pip to completion (at most `UPDATE_TIMEOUT_SEC`): a background upgrade ran with yt-dlp already
    loaded, and the extractor imported later came from the new release while
    the core in memory was the old one. Returns whether pip ran and succeeded.
    """
    import logging
    import subprocess

    from shared.bundle_paths import is_frozen

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
    command = pip_upgrade_command(packages)
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


def warn_updates_need_a_new_image(file_env: Mapping[str, str | None] | None = None) -> None:
    """In the container, say that the update settings do nothing.

    The image installs its packages as root for the `soundsible` user; a pip
    run as that user lands in a user site directory that the running
    interpreter never put on its path, so an upgrade would report success and
    change nothing. The image is updated by pulling a newer one.
    """
    import logging

    if file_env is None:
        from shared.downloader.settings import read_settings

        file_env = read_settings()
    packages, _ = enabled_runtime_packages(file_env)
    if packages:
        logging.getLogger(__name__).warning(
            "Auto-update of %s is not applied in the container image; pull a newer image instead",
            ", ".join(packages),
        )
