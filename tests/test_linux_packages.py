"""The AUR recipe and the Flatpak are repackagings of the tested .deb.

Neither fails loudly when it drifts from the app: a wrong checksum only breaks
`yay` on somebody else's machine, and a Flatpak bus name that no longer matches
the one the app asks for only loses the media keys. These pin what has to stay
in step with the desktop shell.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import tarfile
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
import yaml

from scripts.linux_packages import (
    APP_ID,
    PACKAGING,
    check_deb,
    extract_deb,
    pkgver,
    render_metainfo,
    render_pkgbuild,
    render_spec,
    rpm_version,
    write_flatpak,
)

ROOT = Path(__file__).resolve().parent.parent
TAURI = ROOT / "desktop-shell" / "src-tauri"


def _deb(tmp_path: Path, version: str = "1.2.3") -> Path:
    deb = tmp_path / f"Soundsible_{version}_amd64.deb"
    deb.write_bytes(b"not really a deb")
    return deb


def _manifest() -> dict:
    return yaml.safe_load((PACKAGING / "flatpak" / f"{APP_ID}.yml").read_text())


def test_pkgbuild_carries_the_release_and_its_checksums(tmp_path):
    deb = _deb(tmp_path)
    pkgbuild = render_pkgbuild("1.2.3", deb)

    assert "pkgver=1.2.3\n" in pkgbuild
    assert "_version=1.2.3\n" in pkgbuild
    assert hashlib.sha256(deb.read_bytes()).hexdigest() in pkgbuild
    assert hashlib.sha256((ROOT / "LICENSE").read_bytes()).hexdigest() in pkgbuild
    assert not re.search(r"@[A-Z0-9_]+@", pkgbuild)


def test_pkgbuild_never_strips_the_engine(tmp_path):
    # Stripping a PyInstaller executable removes the Python archive appended
    # to it; the package would install an engine that cannot start.
    assert "'!strip'" in render_pkgbuild("1.2.3", _deb(tmp_path))


def test_prereleases_get_a_pkgver_arch_accepts():
    assert pkgver("0.22.0-rc.1") == "0.22.0rc.1"
    assert "-" not in pkgver("0.22.0-rc.1")


def _real_deb(path: Path) -> Path:
    """An `ar` archive laid out like the one Tauri writes."""
    def member(name: str, data: bytes) -> bytes:
        header = f"{name:<16}{0:<12}{0:<6}{0:<6}{100644:<8}{len(data):<10}`\n".encode()
        return header + data + (b"\n" if len(data) % 2 else b"")

    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w:gz") as data:
        engine = tarfile.TarInfo("./usr/bin/soundsible-engine")
        engine.size, engine.mode = 3, 0o755
        data.addfile(engine, io.BytesIO(b"elf"))
        folder = tarfile.TarInfo("./usr/share/applications")
        folder.type = tarfile.DIRTYPE
        data.addfile(folder)
    path.write_bytes(b"!<arch>\n" + member("debian-binary", b"2.0\n")
                     + member("control.tar.gz", b"x") + member("data.tar.gz", payload.getvalue()))
    return path


def test_rpm_extracts_the_debs_files(tmp_path):
    root = tmp_path / "root"
    root.mkdir()

    files = extract_deb(_real_deb(tmp_path / "Soundsible_1.2.3_amd64.deb"), root)

    # Files only: listing /usr/share/applications would make the package own
    # a directory every desktop shares.
    assert files == ["/usr/bin/soundsible-engine"]
    assert os.access(root / "usr" / "bin" / "soundsible-engine", os.X_OK)


def test_spec_lists_the_files_and_never_rewrites_them():
    spec = render_spec("1.2.3", ["/usr/bin/soundsible-engine"])

    assert "Version:        1.2.3\n" in spec
    assert "\n/usr/bin/soundsible-engine\n" in spec + "\n"
    # Stripping cuts off the frozen engine's Python archive.
    assert "%global __os_install_post %{nil}" in spec
    assert not re.search(r"@[A-Z0-9_]+@", spec)


def test_prereleases_get_a_version_rpm_orders_first():
    assert rpm_version("0.22.0-rc.1") == "0.22.0~rc.1"


def test_a_deb_from_another_version_is_refused(tmp_path):
    with pytest.raises(SystemExit):
        check_deb(_deb(tmp_path, "1.2.2"), "1.2.3")


def test_templates_name_no_version():
    # Versions are written by scripts, never by hand.
    assert "<release " not in (PACKAGING / f"{APP_ID}.metainfo.xml").read_text()
    assert re.search(r"^pkgver=@PKGVER@$", (PACKAGING / "aur" / "PKGBUILD.in").read_text(), re.MULTILINE)


def test_metainfo_describes_this_release():
    root = ET.fromstring(render_metainfo("1.2.3", "2026-10-09"))

    assert root.findtext("id") == APP_ID
    assert root.find("launchable").text == f"{APP_ID}.desktop"
    release = root.find("releases/release")
    assert release.get("version") == "1.2.3"
    assert release.get("date") == "2026-10-09"
    images = [image.text for image in root.iter("image")]
    assert images and all("/v1.2.3/" in image for image in images)
    for image in images:
        relative = image.split("/v1.2.3/", 1)[1]
        assert (ROOT / relative).is_file(), f"metainfo screenshot {relative} does not exist"


def test_manifest_keeps_the_engine_intact():
    manifest = _manifest()
    assert manifest["id"] == APP_ID
    app = next(module for module in manifest["modules"] if isinstance(module, dict) and module["name"] == "soundsible")
    assert app["build-options"]["strip"] is False


def test_manifest_owns_the_bus_names_the_app_asks_for():
    names = {arg.split("=", 1)[1] for arg in _manifest()["finish-args"] if arg.startswith("--own-name=")}

    media = (TAURI / "src" / "linux_media.rs").read_text()
    mpris = re.search(r'\.name\("(org\.mpris\.MediaPlayer2\.[^"]+)"\)', media).group(1)

    assert mpris in names
    # Names under the app's own ID need no grant, and Flathub rejects
    # manifests that ask for ones the app could have put there. The
    # single-instance name is moved under it at runtime (lib.rs).
    assert not any(name.endswith(".SingleInstance") for name in names)


def test_flatpak_directory_has_everything_flatpak_builder_reads(tmp_path):
    shared = tmp_path / "shared"
    module = shared / "libayatana-appindicator" / "libayatana-appindicator-gtk3.json"
    module.parent.mkdir(parents=True)
    module.write_text("{}")
    out = tmp_path / "build"

    write_flatpak("1.2.3", _deb(tmp_path), out, "2026-10-09", shared)

    manifest = yaml.safe_load((out / f"{APP_ID}.yml").read_text())
    for entry in manifest["modules"]:
        if isinstance(entry, str):
            assert (out / entry).is_file(), entry
        else:
            for source in entry.get("sources", []):
                assert (out / source["path"]).is_file(), source["path"]
