"""Keep the network-facing download tools current: chosen in settings, upgraded at boot."""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
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


def _apply_runtime_updates(file_env: Mapping[str, str | None] | None, lease_fd: int) -> bool:
    """Upgrade the enabled download tools before anything imports them.

    `run.py --daemon` calls it before `shared.api`, which imports yt-dlp.
    Downloads wheels under a deadline without touching the environment. The
    offline installation has no kill deadline: stopping pip halfway through
    replacing a package can leave it unusable. The caller holds the exclusive
    environment lease until installation finishes.
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
    import tempfile

    with tempfile.TemporaryDirectory(prefix="soundsible-tool-update-") as wheel_dir:
        download = [sys.executable, "-m", "pip", "download", "--only-binary=:all:",
                    "--dest", wheel_dir, *packages]
        install = [*pip_upgrade_command(packages), "--no-index", "--find-links", wheel_dir]
        for stage, command, timeout in (("download", download, UPDATE_TIMEOUT_SEC),
                                        ("install", install, None)):
            logger.info("Runtime auto-update %s: %s", stage, ", ".join(packages))
            try:
                # Keep the lease in pip too. If the parent exits, another
                # engine still cannot import files while pip replaces them.
                result = subprocess.run(command, capture_output=True, text=True,
                                        timeout=timeout, pass_fds=(lease_fd,))
            except (OSError, subprocess.TimeoutExpired) as error:
                logger.warning("Runtime auto-update %s failed: %s", stage, error)
                return False
            if result.returncode != 0:
                logger.warning("Runtime auto-update %s failed: %s", stage,
                               (result.stderr or result.stdout or "unknown")[-800:])
                return False
    logger.info("Runtime auto-update completed for %s", ", ".join(packages))
    return True


def _tool_lease_path() -> Path:
    # Different accounts/config directories can run in the same interpreter
    # environment. The lease belongs to that environment, not an instance.
    return Path(sys.prefix).resolve() / ".soundsible-runtime-tools.lock"


@contextmanager
def runtime_tool_session(*, update_tools: bool = False,
                         file_env: Mapping[str, str | None] | None = None) -> Iterator[bool]:
    """Hold a shared environment lease until this engine stops.

    An updater first tries the exclusive lease without waiting. If another
    engine is using the environment, it skips the update and joins the readers.
    A reader waits for an installation already in progress before importing any
    tools. Unsupported/read-only environments never run an unguarded update.
    Frozen engines have private bundled tools and need no lease.
    """
    import logging

    from shared.bundle_paths import is_frozen

    if is_frozen():
        yield False
        return
    logger = logging.getLogger(__name__)
    try:
        import fcntl
    except ImportError:
        if update_tools:
            logger.warning("Runtime auto-update skipped: shared environment leases are unavailable")
        yield False
        return
    try:
        path = _tool_lease_path()
        try:
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
        except PermissionError:
            # An engine running as another account can read an existing lease.
            fd = os.open(path, os.O_RDONLY)
    except OSError as error:
        if update_tools:
            logger.warning("Runtime auto-update skipped: cannot lease the environment: %s", error)
        yield False
        return
    with os.fdopen(fd, "rb") as lease:
        exclusive = False
        if update_tools:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                exclusive = True
            except BlockingIOError:
                logger.info("Runtime auto-update skipped: another engine is using this environment")
        if exclusive:
            try:
                updated = _apply_runtime_updates(file_env, lease.fileno())
            finally:
                fcntl.flock(lease, fcntl.LOCK_SH)
        else:
            fcntl.flock(lease, fcntl.LOCK_SH)
            updated = False
        yield updated


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
