"""Select and invoke the small set of runtime tools safe to update in place."""

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
