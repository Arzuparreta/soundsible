"""Create a clean venv without overwriting its active Windows redirector.

Called by the external base interpreter while the launcher owns the exclusive
lease. Windows keeps the current venv's python.exe mapped until the launcher
exits, so the working redirector can be retained while its packages and
configuration are recreated.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import venv


class RepairBuilder(venv.EnvBuilder):
    def __init__(self, retained_executable: Path | None = None):
        super().__init__(with_pip=True, symlinks=os.name != "nt")
        self.retained_executable = retained_executable

    def symlink_or_copy(self, src, dst, relative_symlinks_ok=False):
        target = Path(dst)
        if (self.retained_executable is not None
                and target.resolve() == self.retained_executable.resolve()
                and target.is_file()):
            return
        super().symlink_or_copy(src, dst, relative_symlinks_ok=relative_symlinks_ok)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--retain-executable", type=Path)
    args = parser.parse_args()
    if args.retain_executable and not args.retain_executable.resolve().is_relative_to(args.directory.resolve()):
        parser.error("the retained executable must belong to the repaired environment")
    RepairBuilder(args.retain_executable).create(args.directory)


if __name__ == "__main__":
    main()
