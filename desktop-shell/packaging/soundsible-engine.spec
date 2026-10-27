# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Soundsible desktop engine sidecar."""

from __future__ import annotations

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

REPO_ROOT = Path(SPEC).resolve().parents[2]
ENTRY = REPO_ROOT / "soundsible_engine.py"
VENDOR_DIR = REPO_ROOT / "desktop-shell" / "packaging" / "vendor"

pyinstaller_binaries = []
# Keep the native suffix: Windows tools and yt-dlp discover *.exe by name.
for tool in ("ffmpeg", "ffprobe"):
    binary = VENDOR_DIR / (tool + (".exe" if sys.platform == "win32" else ""))
    if binary.is_file():
        pyinstaller_binaries.append((str(binary), "bin"))

hiddenimports = []
curl_cffi_datas, curl_cffi_binaries, curl_cffi_hiddenimports = collect_all("curl_cffi")
pyinstaller_binaries.extend(curl_cffi_binaries)
# The Auto DJ beat model runs on ONNX Runtime's native library.
onnxruntime_datas, onnxruntime_binaries, onnxruntime_hiddenimports = collect_all("onnxruntime")
pyinstaller_binaries.extend(onnxruntime_binaries)
hiddenimports.extend(onnxruntime_hiddenimports)
for package in ("shared", "player", "setup_tool"):
    hiddenimports.extend(collect_submodules(package))
hiddenimports.extend(curl_cffi_hiddenimports)

hiddenimports.extend(
    [
        "engineio.async_drivers.threading",
        "engineio.async_drivers.gevent",
        "gevent",
        "geventwebsocket",
        "gevent.monkey",
        "flask_socketio",
        "socketio",
        "dns",
        "dns.rdata",
        "yt_dlp",
        "mutagen",
        "feedparser",
        "cryptography",
        "PIL",
        "watchdog",
        "boto3",
        "b2sdk",
    ]
)

# `shared.dj.weights.bundled_path()` reads `models/` beside the bundle root;
# build-sidecar.sh fetches and verifies the file first.
DJ_MODEL = REPO_ROOT / "models" / "beat_this-final0.onnx"
if not DJ_MODEL.is_file():
    raise SystemExit(f"Missing DJ beat model {DJ_MODEL}: run scripts/fetch_dj_model.py")

datas = [
    (str(REPO_ROOT / "ui_web" / "dist"), "ui_web/dist"),
    (str(REPO_ROOT / "branding"), "branding"),
    (str(DJ_MODEL), "models"),
    (str(REPO_ROOT / "shared" / "dj" / "third_party"), "shared/dj/third_party"),
    *curl_cffi_datas,
    *onnxruntime_datas,
]
for pkg in ("flask", "engineio", "socketio", "yt_dlp"):
    datas.extend(collect_data_files(pkg, include_py_files=True))

block_cipher = None

a = Analysis(
    [str(ENTRY)],
    pathex=[str(REPO_ROOT)],
    binaries=pyinstaller_binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "black", "mypy", "rich"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="soundsible-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
