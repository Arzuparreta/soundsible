#!/usr/bin/env python3
"""Turn the Linux .deb into the AUR recipe and the Flatpak build directory.

Both are repackagings of the .deb that Desktop Build installs and drives, not
second builds: the binaries an Arch or Flatpak user runs are the ones CI
tested. What differs per release is the version and the checksums, and neither
may be written by hand, so the templates under
``desktop-shell/packaging/linux`` carry neither and this script fills them in.

``aur`` writes ``PKGBUILD``. Its ``.SRCINFO`` is left to
``makepkg --printsrcinfo``, which is the only thing that can say what
``.SRCINFO`` a PKGBUILD has.

``flatpak`` writes a directory flatpak-builder can run on: the manifest, the
.deb, the metainfo with this release in it, and Flathub's shared modules at a
pinned commit.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from version_sync import declared_version  # noqa: E402

PACKAGING = REPO_ROOT / "desktop-shell" / "packaging" / "linux"
APP_ID = "io.github.Arzuparreta.Soundsible"
REPOSITORY = "Arzuparreta/soundsible"

# Flathub's shared modules, for libayatana-appindicator. A commit rather than a
# branch so that the same release always builds the same tray library.
SHARED_MODULES_URL = "https://github.com/flathub/shared-modules.git"
SHARED_MODULES_COMMIT = "cb9ec602a1ece1c76d5a4f8aa1d87c4a6bf99c3e"

SCREENSHOTS = (
    ("desktop-now-playing", "The player with album artwork, the library and the upcoming queue"),
    ("desktop-search", "Search results for an artist, their songs and albums"),
    ("desktop-library", "The library, browsed by album"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check_deb(deb: Path, version: str) -> None:
    # Tauri names the package after the version it built. A mismatch means the
    # .deb came from another tree, and the recipe would describe a release the
    # file is not.
    expected = f"Soundsible_{version}_amd64.deb"
    if deb.name != expected:
        raise SystemExit(f"{deb.name} is not {expected}: it was built from another version.")


def pkgver(version: str) -> str:
    """Arch forbids `-` in pkgver; `0.22.0-rc.1` becomes `0.22.0rc.1`, which
    vercmp still orders before `0.22.0`."""
    return version.replace("-", "")


def render_pkgbuild(version: str, deb: Path) -> str:
    template = (PACKAGING / "aur" / "PKGBUILD.in").read_text()
    replacements = {
        "@PKGVER@": pkgver(version),
        "@VERSION@": version,
        "@DEB_SHA256@": sha256(deb),
        "@LICENSE_SHA256@": sha256(REPO_ROOT / "LICENSE"),
    }
    for placeholder, value in replacements.items():
        template = template.replace(placeholder, value)
    left = re.findall(r"@[A-Z0-9_]+@", template)
    if left:
        raise SystemExit(f"PKGBUILD.in has placeholders this script does not fill: {left}")
    return template


def render_metainfo(version: str, date: str) -> str:
    template = (PACKAGING / f"{APP_ID}.metainfo.xml").read_text()
    raw = f"https://raw.githubusercontent.com/{REPOSITORY}/v{version}/docs/images/screenshots"
    screenshots = "\n".join(
        f'    <screenshot{" type=\"default\"" if index == 0 else ""}>\n'
        f"      <image>{raw}/light/{name}.webp</image>\n"
        f"      <caption>{escape(caption)}</caption>\n"
        f"    </screenshot>"
        for index, (name, caption) in enumerate(SCREENSHOTS)
    )
    additions = (
        f"  <screenshots>\n{screenshots}\n  </screenshots>\n"
        f"  <releases>\n"
        f'    <release version="{escape(version)}" date="{date}">\n'
        f'      <url type="details">https://github.com/{REPOSITORY}/releases/tag/v{escape(version)}</url>\n'
        f"    </release>\n"
        f"  </releases>\n"
    )
    return template.replace("</component>", additions + "</component>")


def fetch_shared_modules(destination: Path) -> None:
    destination.mkdir(parents=True)
    git = ["git", "-C", str(destination)]
    subprocess.run([*git, "init", "-q"], check=True)
    subprocess.run([*git, "fetch", "-q", "--depth", "1", SHARED_MODULES_URL, SHARED_MODULES_COMMIT], check=True)
    subprocess.run([*git, "checkout", "-q", "FETCH_HEAD"], check=True)


def write_flatpak(version: str, deb: Path, out: Path, date: str, shared_modules: Path | None) -> None:
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PACKAGING / "flatpak" / f"{APP_ID}.yml", out / f"{APP_ID}.yml")
    shutil.copy2(deb, out / "soundsible.deb")
    (out / f"{APP_ID}.metainfo.xml").write_text(render_metainfo(version, date))
    modules = out / "shared-modules"
    if modules.exists():
        shutil.rmtree(modules)
    if shared_modules:
        shutil.copytree(shared_modules, modules)
    else:
        fetch_shared_modules(modules)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("aur", "flatpak"):
        command = sub.add_parser(name)
        command.add_argument("--deb", type=Path, required=True, help="the .deb Desktop Build produced")
        command.add_argument("--out", type=Path, required=True, help="directory to write into")
        command.add_argument("--version", default=None, help="defaults to shared/version.py")
    flatpak = sub.choices["flatpak"]
    flatpak.add_argument("--date", default=None, help="release date for the metainfo, YYYY-MM-DD (default: today, UTC)")
    flatpak.add_argument("--shared-modules", type=Path, default=None,
                         help="use this checkout of flathub/shared-modules instead of fetching it")
    args = parser.parse_args(argv)

    version = args.version or declared_version()
    check_deb(args.deb, version)
    if args.command == "aur":
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "PKGBUILD").write_text(render_pkgbuild(version, args.deb))
    else:
        date = args.date or datetime.now(timezone.utc).date().isoformat()
        write_flatpak(version, args.deb, args.out, date, args.shared_modules)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
