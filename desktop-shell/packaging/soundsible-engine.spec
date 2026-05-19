# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Soundsible desktop engine sidecar."""

from __future__ import annotations

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

REPO_ROOT = Path(SPEC).resolve().parents[2]
ENTRY = REPO_ROOT / "soundsible_engine.py"

hiddenimports = []
for package in ("shared", "player", "odst_tool", "setup_tool"):
    hiddenimports.extend(collect_submodules(package))

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
        "pyacoustid",
        "boto3",
        "b2sdk",
    ]
)

datas = [
    (str(REPO_ROOT / "ui_web"), "ui_web"),
    (str(REPO_ROOT / "branding"), "branding"),
]
for pkg in ("flask", "engineio", "socketio", "yt_dlp"):
    datas.extend(collect_data_files(pkg, include_py_files=True))

block_cipher = None

a = Analysis(
    [str(ENTRY)],
    pathex=[str(REPO_ROOT)],
    binaries=[],
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
