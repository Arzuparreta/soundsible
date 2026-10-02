#!/usr/bin/env python3
"""Build the Android development shell without touching the engine's UI bundle."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
UI = ROOT / "ui_web"


def run(*args: str, cwd: Path = ROOT, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def tool(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"{name} is missing; see docs/ANDROID.md")
    return found


def sdk() -> Path:
    location = os.getenv("ANDROID_HOME") or os.getenv("ANDROID_SDK_ROOT")
    if not location:
        raise RuntimeError("Set ANDROID_HOME to your Android SDK; see docs/ANDROID.md")
    return Path(location).expanduser().resolve()


def doctor() -> None:
    for name in ("node", "npm", "java"):
        print(f"{name}: {tool(name)}")
    java = subprocess.run([tool("java"), "-version"], capture_output=True, text=True, check=True)
    if not re.search(r'version "21(?:\.|\")', java.stderr + java.stdout):
        raise RuntimeError("Use JDK 21 (JAVA_HOME and PATH), not the system's default JDK")
    for relative in ("platform-tools/adb", "platforms/android-36/android.jar", "build-tools/36.0.0"):
        if not (sdk() / relative).exists():
            raise RuntimeError(f"Missing SDK component: {relative}; see docs/ANDROID.md")
    if not (UI / "node_modules/@capacitor/cli").is_dir():
        raise RuntimeError("Run npm ci in ui_web first")
    print(f"SDK: {sdk()}")


def prepare() -> None:
    version = run(sys.executable, "scripts/version_sync.py", "--print", capture=True)
    revision = run("git", "rev-parse", "HEAD", capture=True)
    dirty = bool(run("git", "status", "--porcelain", capture=True))
    # Development build counter only. Public versionCode allocation is a
    # separate release gate; counters from different workflows cannot be mixed.
    code = int(os.getenv("SOUNDSIBLE_ANDROID_BUILD_NUMBER", "1"))
    if not 0 < code <= 2_100_000_000:
        raise RuntimeError("SOUNDSIBLE_ANDROID_BUILD_NUMBER must be a positive Android build code")
    (ANDROID / "build-info.json").write_text(
        json.dumps(
            {
                "version": version,
                "version_code": code,
                "source_revision": revision,
                "dirty": dirty,
                "channel": "development",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    run(tool("npm"), "exec", "--", "vite", "build", "--config", "vite.android.config.ts", cwd=UI)
    run(tool("npm"), "exec", "--", "cap", "sync", "android", cwd=UI)


def gradle(*tasks: str) -> None:
    doctor()
    wrapper = ANDROID / ("gradlew.bat" if os.name == "nt" else "gradlew")
    run(str(wrapper), "--no-daemon", *tasks, cwd=ANDROID)


def adb(*args: str, serial: str | None = None) -> None:
    binary = sdk() / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    run(str(binary), *(["-s", serial] if serial else []), *args)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("doctor", "prepare", "build", "install", "smoke"))
    parser.add_argument("--serial", help="adb device serial (or set ANDROID_SERIAL)")
    args = parser.parse_args()
    if args.serial:
        os.environ["ANDROID_SERIAL"] = args.serial
    try:
        if args.command == "doctor":
            doctor()
        elif args.command == "prepare":
            prepare()
        elif args.command == "build":
            prepare()
            gradle(":app:assembleDebug", ":app:assembleDebugAndroidTest", ":app:lintDebug")
        elif args.command == "install":
            adb("install", "-r", str(ANDROID / "app/build/outputs/apk/debug/app-debug.apk"), serial=args.serial)
            adb(
                "shell",
                "am",
                "start",
                "-n",
                "com.soundsible.android.dev/com.soundsible.android.MainActivity",
                serial=args.serial,
            )
        else:
            # Tests install/run the packaged APK and exercise App.getInfo through
            # the real bridge, including offline reopening and locale persistence.
            gradle(":app:connectedDebugAndroidTest")
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Android: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
