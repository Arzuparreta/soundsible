"""Build/source identity exposed by the administrative health check."""

from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Optional


@lru_cache(maxsize=4)
def source_revision(root: str | Path) -> Optional[str]:
    injected = (os.getenv("SOUNDSIBLE_SOURCE_REVISION") or "").strip()
    if injected:
        return injected
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(root),
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    revision = result.stdout.strip()
    return revision if result.returncode == 0 and len(revision) == 40 else None
