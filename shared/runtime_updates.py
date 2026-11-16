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


def run_install_transaction(command: Sequence[str], *, lease_fd: int, **kwargs):
    """Finish a package replacement before honoring ordinary shutdown signals.

    A separate process group keeps terminal Ctrl+C out of the installer. The
    parent records SIGINT/SIGTERM instead of letting subprocess.run kill its
    child, then honors the signal after the child has finished. External hard
    kills and power loss remain outside pip's recovery guarantees.
    """
    import signal
    import subprocess

    pending = []
    previous = {}

    def defer(signum, frame):
        if previous[signum] != signal.SIG_IGN:
            pending.append((signum, frame))

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, defer)
        from shared.environment_lock import child_options

        process_group = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
                         else {"start_new_session": True})
        with child_options(lease_fd) as inherited:
            result = subprocess.run(command, **process_group, **inherited, **kwargs)
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    if pending:
        signum, frame = pending[0]
        handler = previous[signum]
        if callable(handler):
            handler(signum, frame)
        elif handler != signal.SIG_IGN:
            raise SystemExit(128 + signum)
    return result


def _apply_runtime_updates(file_env: Mapping[str, str | None] | None, lease_fd: int) -> bool:
    """Stage wheels under a deadline, then finish the offline replacement."""
    import logging
    import subprocess
    import tempfile

    logger = logging.getLogger(__name__)
    if file_env is None:
        from shared.downloader.settings import read_settings

        file_env = read_settings()
    packages, _ = enabled_runtime_packages(file_env)
    if not packages:
        return False
    loaded = [name for name in packages if _UPDATED_MODULES.get(name) in sys.modules]
    if loaded:
        logger.warning("Runtime auto-update skipped: %s already imported", ", ".join(loaded))
        return False
    try:
        with tempfile.TemporaryDirectory(prefix="soundsible-tool-update-") as wheel_dir:
            download = [sys.executable, "-m", "pip", "download", "--only-binary=:all:",
                        "--dest", wheel_dir, *packages]
            install = [*pip_upgrade_command(packages), "--no-index", "--find-links", wheel_dir]
            logger.info("Runtime auto-update download: %s", ", ".join(packages))
            from shared.environment_lock import child_options

            with child_options(lease_fd) as inherited:
                result = subprocess.run(download, capture_output=True, text=True,
                                        timeout=UPDATE_TIMEOUT_SEC, **inherited)
            if result.returncode == 0:
                logger.info("Runtime auto-update install: %s", ", ".join(packages))
                result = run_install_transaction(install, lease_fd=lease_fd,
                                                 capture_output=True, text=True, timeout=None)
            if result.returncode != 0:
                logger.warning("Runtime auto-update failed: %s",
                               (result.stderr or result.stdout or "unknown")[-800:])
                return False
    except (OSError, subprocess.TimeoutExpired) as error:
        logger.warning("Runtime auto-update failed: %s", error)
        return False
    logger.info("Runtime auto-update completed for %s", ", ".join(packages))
    return True


def _tool_lease_path(prefix: Path | None = None) -> Path:
    # A sibling survives bootstrap recreating the environment itself. Different
    # account/config directories using the same interpreter share this lease.
    environment = (prefix or Path(sys.prefix)).resolve()
    return environment.parent / f".{environment.name}.soundsible-runtime-tools.lock"


class EnvironmentLease:
    """One file descriptor, shared by engine readers and bootstrap writers."""

    def __init__(self, handle, locker):
        self.handle = handle
        self.locker = locker

    def require_write(self) -> None:
        """Refuse mutation when an engine is already using the environment."""
        try:
            self.locker.flock(self.handle, self.locker.LOCK_EX | self.locker.LOCK_NB)
        except OSError as error:
            raise RuntimeError("Cannot modify the Python environment while another engine is using it; "
                               "stop those engines before updating dependencies") from error

    def read(self, on_wait=None) -> None:
        try:
            self.locker.flock(self.handle, self.locker.LOCK_SH | self.locker.LOCK_NB)
        except BlockingIOError:
            if on_wait:
                on_wait(True)
            try:
                self.locker.flock(self.handle, self.locker.LOCK_SH)
            finally:
                if on_wait:
                    on_wait(False)

    def install(self, command, **kwargs):
        return run_install_transaction(command, lease_fd=self.handle.fileno(), **kwargs)


@contextmanager
def _environment_lease(prefix: Path | None = None) -> Iterator[EnvironmentLease | None]:
    import logging

    handle = None
    try:
        from shared.environment_lock import backend

        locker = backend()
        path = _tool_lease_path(prefix)
        try:
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
        except PermissionError:
            fd = os.open(path, os.O_RDONLY)
        handle = os.fdopen(fd, "rb")
    except (ImportError, OSError) as error:
        logging.getLogger(__name__).warning("Runtime auto-update skipped: cannot lease the environment: %s", error)
        yield None
        return
    try:
        yield EnvironmentLease(handle, locker)
    finally:
        handle.close()


@contextmanager
def bootstrap_tool_session(prefix: Path) -> Iterator[EnvironmentLease | None]:
    """Protect bootstrap reads, and provide an explicit write gate for repairs.

    An unsupported lease permits read-only startup but never dependency writes.
    """
    import logging

    with _environment_lease(prefix) as lease:
        if lease:
            try:
                lease.read()
            except OSError as error:
                logging.getLogger(__name__).warning("Environment lease unavailable: %s", error)
                lease.handle.close()
                lease = None
        yield lease


@contextmanager
def runtime_tool_session(*, update_tools: bool = False,
                         file_env: Mapping[str, str | None] | None = None,
                         on_wait=None) -> Iterator[bool]:
    """Keep a shared lease until the engine stops; updates require exclusivity."""
    import logging

    from shared.bundle_paths import is_frozen

    if is_frozen():
        yield False
        return
    logger = logging.getLogger(__name__)
    with _environment_lease() as lease:
        updated = False
        if lease:
            exclusive = False
            try:
                if update_tools:
                    try:
                        lease.locker.flock(lease.handle, lease.locker.LOCK_EX | lease.locker.LOCK_NB)
                        exclusive = True
                    except BlockingIOError:
                        logger.info("Runtime auto-update skipped: another engine is using this environment")
                if exclusive:
                    try:
                        updated = _apply_runtime_updates(file_env, lease.handle.fileno())
                    finally:
                        lease.read(on_wait)
                else:
                    lease.read(on_wait)
            except OSError as error:
                logger.warning("Runtime auto-update skipped: environment lease unavailable: %s", error)
                lease.handle.close()
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
