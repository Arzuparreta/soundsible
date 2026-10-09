#!/usr/bin/env python3
"""Turn the Linux .deb into the .rpm, the AUR recipe and the Flatpak build directory.

All three are repackagings of the .deb that Desktop Build installs and drives,
not second builds: the binaries a Fedora, Arch or Flatpak user runs are the
ones CI tested. What differs per release is the version and the checksums, and neither
may be written by hand, so the templates under
``desktop-shell/packaging/linux`` carry neither and this script fills them in.

``aur`` writes ``PKGBUILD``. Its ``.SRCINFO`` is left to
``makepkg --printsrcinfo``, which is the only thing that can say what
``.SRCINFO`` a PKGBUILD has.

``rpm`` builds the .rpm with rpmbuild from the .deb's files.

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
import tarfile
import tempfile
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


def rpm_version(version: str) -> str:
    """RPM forbids `-` in Version; `~` is how it spells a pre-release, so
    `0.22.0~rc.1` sorts before `0.22.0`."""
    return version.replace("-", "~")


def extract_deb(deb: Path, destination: Path) -> list[str]:
    """Unpack the .deb's files and return their paths, absolute, sorted.

    A .deb is an `ar` archive whose `data.tar.*` member holds the files; the
    format is simple enough to read here rather than depend on dpkg."""
    with deb.open("rb") as handle:
        if handle.read(8) != b"!<arch>\n":
            raise SystemExit(f"{deb} is not a .deb")
        while header := handle.read(60):
            name = header[:16].decode().strip().rstrip("/")
            size = int(header[48:58])
            if name.startswith("data.tar"):
                with tarfile.open(fileobj=handle, mode="r|*") as data:
                    data.extractall(destination, filter="tar")
                break
            handle.seek(size + size % 2, 1)
        else:
            raise SystemExit(f"{deb} has no data.tar member")
    return sorted("/" + str(path.relative_to(destination)) for path in destination.rglob("*") if not path.is_dir())


def render_spec(version: str, files: list[str]) -> str:
    template = (PACKAGING / "rpm" / "soundsible.spec.in").read_text()
    return template.replace("@RPMVERSION@", rpm_version(version)).replace("@FILES@", "\n".join(files))


def build_rpm(version: str, deb: Path, out: Path) -> Path:
    with tempfile.TemporaryDirectory(prefix="soundsible-rpm-") as temporary:
        top = Path(temporary)
        root = top / "SOURCES" / "root"
        root.mkdir(parents=True)
        files = extract_deb(deb, root)
        spec = top / "SPECS" / "soundsible.spec"
        spec.parent.mkdir()
        spec.write_text(render_spec(version, files))
        subprocess.run([
            "rpmbuild", "-bb", "--nodeps",
            "--define", f"_topdir {top}",
            # gzip, which every RPM-based distribution still reads.
            "--define", "_binary_payload w6.gzdio",
            str(spec),
        ], check=True)
        built = next((top / "RPMS").rglob("*.rpm"))
        out.mkdir(parents=True, exist_ok=True)
        return Path(shutil.copy2(built, out / built.name))


def render_metainfo(version: str, date: str) -> str:
    template = (PACKAGING / f"{APP_ID}.metainfo.xml").read_text()
    # From main, not from the version's tag: the tag does not exist yet while
    # the release pull request builds this, and flatpak-builder-lint fetches
    # every screenshot. Flathub copies them into its own mirror at build time.
    raw = f"https://raw.githubusercontent.com/{REPOSITORY}/main/docs/images/screenshots"
    default = ' type="default"'
    screenshots = "\n".join(
        f"    <screenshot{default if index == 0 else ''}>\n"
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
    for name in ("aur", "rpm", "flatpak"):
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
    elif args.command == "rpm":
        print(build_rpm(version, args.deb, args.out))
    else:
        date = args.date or datetime.now(timezone.utc).date().isoformat()
        write_flatpak(version, args.deb, args.out, date, args.shared_modules)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
