#!/usr/bin/env python3
"""Propagate the declared version into the manifests that cannot read Python.

``shared/version.py`` is where Soundsible says what version it is. The engine
imports it, so nothing else has to be told. The desktop shell is the exception:
Cargo, npm and Tauri each resolve their version at build time from their own
manifest, and there is no way to point them at a Python module. So the number
is copied, and this script is what copies it.

Copying is only safe if drift is impossible. ``--check`` is that guarantee: CI
runs it on every push and pull request, and refuses a tree where a manifest
disagrees with the declaration. Before it existed the manifests said
``1.0.0-rc.1`` while the engine said ``0.1.0``, and every installer ever built
reported the former no matter which tag produced it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Semantic Versioning 2.0.0, restricted to what the three ecosystems accept:
# Cargo, npm and Tauri all parse this, and build metadata (`+sha`) is left out
# because Tauri's Windows installer cannot express it.
SEMVER = re.compile(
    r"^(?P<major>0|[1-9]\d*)"
    r"\.(?P<minor>0|[1-9]\d*)"
    r"\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$"
)

VERSION_PY = REPO_ROOT / "shared" / "version.py"
_DECLARATION = re.compile(r'^(VERSION\s*=\s*")([^"]+)(")$', re.MULTILINE)


@dataclass(frozen=True)
class Target:
    """A manifest holding a copy of the version, and how to find it."""

    path: Path
    #: Matches the version with the literal text around it in groups 1 and 3,
    #: so a replacement never reformats the file.
    pattern: re.Pattern[str]
    #: How many occurrences to replace. npm lockfiles carry two: the root
    #: version and the entry for the package itself under `packages[""]`.
    count: int = 1


TARGETS: tuple[Target, ...] = (
    Target(
        REPO_ROOT / "desktop-shell" / "src-tauri" / "tauri.conf.json",
        re.compile(r'^(  "version": ")([^"]+)(")', re.MULTILINE),
    ),
    Target(
        REPO_ROOT / "desktop-shell" / "package.json",
        re.compile(r'^(  "version": ")([^"]+)(")', re.MULTILINE),
    ),
    Target(
        REPO_ROOT / "desktop-shell" / "package-lock.json",
        re.compile(r'^(\s+"version": ")([^"]+)(")', re.MULTILINE),
        count=2,
    ),
    Target(
        REPO_ROOT / "desktop-shell" / "src-tauri" / "Cargo.toml",
        re.compile(r'^(version = ")([^"]+)(")', re.MULTILINE),
    ),
    Target(
        REPO_ROOT / "desktop-shell" / "src-tauri" / "Cargo.lock",
        re.compile(
            r'(?m)^(name = "soundsible-desktop"\nversion = ")([^"]+)(")',
        ),
    ),
    # The iOS bundle's CFBundleShortVersionString. Xcode resolves it from
    # MARKETING_VERSION at build time and cannot read Python either, so it is
    # copied here for the same reason the desktop manifests are.
    Target(
        REPO_ROOT / "ios" / "project.yml",
        re.compile(r'^(        MARKETING_VERSION: ")([^"]+)(")', re.MULTILINE),
    ),
)


def declared_version() -> str:
    """Return the version ``shared/version.py`` declares."""
    match = _DECLARATION.search(VERSION_PY.read_text(encoding="utf-8"))
    if match is None:
        raise SystemExit(f"{VERSION_PY}: no `VERSION = \"...\"` declaration found")
    return match.group(2)


def set_declared_version(version: str) -> bool:
    """Write ``version`` into ``shared/version.py``. True if it changed."""
    original = VERSION_PY.read_text(encoding="utf-8")
    updated, replaced = _DECLARATION.subn(rf"\g<1>{version}\g<3>", original, count=1)
    if not replaced:
        raise SystemExit(f"{VERSION_PY}: no `VERSION = \"...\"` declaration found")
    if updated == original:
        return False
    VERSION_PY.write_text(updated, encoding="utf-8")
    return True


def validate(version: str) -> str:
    """Return ``version`` if it is a version this project is willing to ship."""
    if not SEMVER.match(version):
        raise SystemExit(
            f"{version!r} is not a version Cargo, npm and Tauri all accept.\n"
            "Expected MAJOR.MINOR.PATCH with an optional -rc.N suffix."
        )
    return version


def _sync_lockfile_json(path: Path, version: str) -> bool:
    """Rewrite an npm lockfile through the JSON parser rather than by regex.

    The root and `packages[""]` entries are the package's own version; every
    other `"version"` in the file belongs to a dependency and must not move.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    before = (data.get("version"), data.get("packages", {}).get("", {}).get("version"))
    data["version"] = version
    if "" in data.get("packages", {}):
        data["packages"][""]["version"] = version
    if before == (version, version):
        return False
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return True


def sync(version: str, *, check: bool) -> list[str]:
    """Copy ``version`` into every manifest. Returns the ones that disagreed."""
    stale: list[str] = []
    for target in TARGETS:
        text = target.path.read_text(encoding="utf-8")
        found = [match.group(2) for match in target.pattern.finditer(text)]
        if len(found) < target.count:
            raise SystemExit(
                f"{target.path.relative_to(REPO_ROOT)}: expected "
                f"{target.count} version field(s), found {len(found)}. "
                "The manifest layout changed; update scripts/version_sync.py."
            )
        if all(value == version for value in found[: target.count]):
            continue
        stale.append(f"{target.path.relative_to(REPO_ROOT)}: {found[0]}")
        if check:
            continue
        if target.path.name == "package-lock.json":
            _sync_lockfile_json(target.path, version)
        else:
            target.path.write_text(
                target.pattern.sub(rf"\g<1>{version}\g<3>", text, count=target.count),
                encoding="utf-8",
            )
    return stale


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--set",
        metavar="VERSION",
        help="declare this version in shared/version.py first, then propagate it",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="report drift and exit non-zero instead of writing anything",
    )
    parser.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="print the declared version and exit",
    )
    args = parser.parse_args(argv)

    if args.print_only:
        print(declared_version())
        return 0

    if args.set:
        if args.check:
            parser.error("--set and --check do the opposite of each other")
        version = validate(args.set)
        set_declared_version(version)
    else:
        version = validate(declared_version())

    stale = sync(version, check=args.check)

    if args.check:
        if stale:
            print(f"Declared version is {version}, but:", file=sys.stderr)
            for line in stale:
                print(f"  {line}", file=sys.stderr)
            print(
                "\nRun `python scripts/version_sync.py` to propagate it.",
                file=sys.stderr,
            )
            return 1
        print(f"Every manifest agrees: {version}")
        return 0

    if stale:
        print(f"Set to {version}:")
        for line in stale:
            print(f"  {line.split(':')[0]}")
    else:
        print(f"Already at {version}; nothing to do.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
