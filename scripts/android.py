#!/usr/bin/env python3
"""Build the Android development shell without touching the engine's UI bundle."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen
import ssl

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
    from android_webrtc import prepare_webrtc
    prepare_webrtc(ROOT)
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


def integration(*, restart_only: bool = False, live_restart_only: bool = False) -> None:
    """Own three disposable engines and run real native account integration on an AVD."""
    doctor()
    if (restart_only or live_restart_only) and os.getenv("ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class"):
        raise RuntimeError("Restart protocol cannot be combined with a single-class instrumentation filter")
    binary = str(sdk() / "platform-tools/adb")
    devices = [
        line.split()[0]
        for line in run(binary, "devices", capture=True).splitlines()[1:]
        if len(line.split()) == 2 and line.split()[1] == "device"
    ]
    if len(devices) != 1 or run(binary, "shell", "getprop", "ro.kernel.qemu", capture=True) != "1":
        raise RuntimeError("Integration requires exactly one connected emulator and no other devices")
    # AVD networking must be enabled for 10.0.2.2; offline startup has its own smoke run.
    adb("shell", "svc", "wifi", "enable")
    from android_test_tls import create_fixture_tls

    processes: list[subprocess.Popen] = []
    live_fixture = None
    certificate_resource = ANDROID / "app/src/debug/res/raw/android_fixture_ca.pem"
    policy_resource = ANDROID / "app/src/debug/res/xml/network_security_config.xml"
    if certificate_resource.exists() or policy_resource.exists():
        raise RuntimeError("Temporary TLS test resources already exist; inspect/remove them before integration")
    (ANDROID / "build").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="soundsible-android-") as temporary:
        with (ANDROID / "build/fixture.log").open("w") as log:
            try:
                ca_path, certificate, key = create_fixture_tls(Path(temporary))
                test_filter = os.getenv("ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class", "")
                if not restart_only and (not test_filter or any(name in test_filter for name in ("LiveRelayTest", "LiveHostTest", "LiveListenerTest", "LiveUiTest", "LiveHandshakeTest", "LivePollingTest", "LiveResumeTest", "LiveRecoveryTest")) or os.environ.get("SOUNDSIBLE_ANDROID_LIVE_FIXTURE") == "1"):
                    from android_live_fixture import LiveFixture
                    live_fixture = LiveFixture(Path(temporary) / "live", ca_path, certificate, key, log)
                    live_fixture.start()
                certificate_resource.parent.mkdir(parents=True, exist_ok=True)
                policy_resource.parent.mkdir(parents=True, exist_ok=True)
                certificate_resource.write_bytes(ca_path.read_bytes())
                policy_resource.write_text(
                    (ANDROID / "app/src/main/res/xml/network_security_config.xml")
                    .read_text()
                    .replace(
                        "</network-security-config>",
                        '<debug-overrides><trust-anchors><certificates src="@raw/android_fixture_ca" /></trust-anchors></debug-overrides></network-security-config>',
                    )
                )
                fixtures = ((5097, False),) if restart_only else ((5097, False), (5098, True), (5099, False))
                for port, passwordless in fixtures:
                    with socket.socket() as probe:
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        try:
                            probe.bind(("127.0.0.1", port))
                        except OSError:
                            raise RuntimeError(
                                f"Fixture port {port} is occupied; stop the previous test fixture"
                            ) from None
                    command = [
                        sys.executable,
                        str(ROOT / "scripts/android_fixture.py"),
                        "--root",
                        str(Path(temporary) / str(port)),
                        "--port",
                        str(port),
                        "--run-id",
                        Path(temporary).name,
                    ]
                    fixture_format = os.environ.get("SOUNDSIBLE_ANDROID_FIXTURE_AUDIO_FORMAT", "wav")
                    if fixture_format not in ("wav", "flac"):
                        raise RuntimeError("Unsupported synthetic fixture audio format")
                    command.extend(("--audio-format", fixture_format))
                    if passwordless:
                        command.append("--passwordless")
                    if port == 5099:
                        command.extend(("--tls-cert", str(certificate), "--tls-key", str(key)))
                    # Import project modules independently of the caller's working directory.
                    environment = {**os.environ, "PYTHONPATH": str(ROOT)}
                    if live_fixture is not None:
                        environment.update(SOUNDSIBLE_ANDROID_LIVE_FIXTURE="1", SOUNDSIBLE_COMMUNITY_URL="https://10.0.2.2:58443", REQUESTS_CA_BUNDLE=str(ca_path), NO_PROXY="10.0.2.2,127.0.0.1,localhost")
                    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=log, stderr=log)
                    processes.append(process)
                # Each engine owns a separate database and port. Start all of them
                # before waiting, so unrelated bootstrap work does not serialize.
                for (port, _passwordless), process in zip(fixtures, processes, strict=True):
                    deadline = time.monotonic() + 60
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError(
                                "Fixture failed; see android/build/fixture.log and install requirements.txt"
                            )
                        try:
                            protocol = "https" if port == 5099 else "http"
                            trust = ssl.create_default_context(cafile=ca_path) if port == 5099 else None
                            with urlopen(
                                f"{protocol}://127.0.0.1:{port}/__fixture/ready/{Path(temporary).name}",
                                timeout=1,
                                context=trust,
                            ) as response:
                                if (
                                    response.status == 200
                                    and json.load(response).get("fixture") == Path(temporary).name
                                ):
                                    break
                        except OSError:
                            if time.monotonic() >= deadline:
                                raise RuntimeError("Fixture startup timed out; see android/build/fixture.log") from None
                            time.sleep(0.2)
                if not restart_only and not live_restart_only:
                    gradle(
                        ":app:connectedDebugAndroidTest",
                        "-Pandroid.testInstrumentationRunnerArguments.notClass=com.soundsible.android.OfflineRestartTest,com.soundsible.android.LiveRestartTest",
                        "-Pandroid.testInstrumentationRunnerArguments.fixtureOrigin=http://10.0.2.2:5097",
                        "-Pandroid.testInstrumentationRunnerArguments.passwordlessOrigin=http://10.0.2.2:5098",
                        "-Pandroid.testInstrumentationRunnerArguments.tlsOrigin=https://10.0.2.2:5099",
                        "-Pandroid.testInstrumentationRunnerArguments.listener=com.soundsible.android.FixtureIsolationListener",
                    )
                    test_filter = os.getenv("ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class")
                    results = (
                        ANDROID / "build/integration-targeted" / re.sub(r"[^A-Za-z0-9_.-]", "_", test_filter)[:100]
                        if test_filter
                        else ANDROID / "build/integration-results"
                    )
                    # A focused retry must not replace the evidence of the full
                    # suite or its process-restart phases.
                    shutil.rmtree(results, ignore_errors=True)
                    shutil.copytree(ANDROID / "app/build/outputs/androidTest-results", results, dirs_exist_ok=True)
                if not os.getenv("ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class"):
                    # connectedDebugAndroidTest uninstalls its target afterwards.
                    # Install once and invoke the runner directly so phase two
                    # observes process death rather than a fresh installation.
                    gradle(":app:assembleDebug", ":app:assembleDebugAndroidTest")
                    adb("install", "-r", str(ANDROID / "app/build/outputs/apk/debug/app-debug.apk"))
                    adb(
                        "install",
                        "-r",
                        str(ANDROID / "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"),
                    )
                    metadata = json.loads((ANDROID / "build-info.json").read_text())
                    protocols = []
                    if not live_restart_only:
                        protocols.append(("OfflineRestartTest", "offlinePhase", ("prepare", "offline"), "restart"))
                    if not restart_only:
                        protocols.append(("LiveRestartTest", "livePhase", ("prepare", "resume"), "live-restart"))
                    for test_class, phase_key, phases, prefix in protocols:
                        for phase in phases:
                            if phase != "prepare":
                                adb("shell", "am", "force-stop", "com.soundsible.android.dev")
                            output = run(
                                binary,
                                "shell",
                                "am",
                                "instrument",
                                "-w",
                                "-e",
                                "class",
                                "com.soundsible.android." + test_class,
                                "-e",
                                phase_key,
                                phase,
                                "-e",
                                "fixtureOrigin",
                                "http://10.0.2.2:5097",
                                "-e",
                                "tlsOrigin",
                                "https://10.0.2.2:5099",
                                "-e",
                                "expectedVersion",
                                metadata["version"],
                                "com.soundsible.android.dev.test/androidx.test.runner.AndroidJUnitRunner",
                                capture=True,
                            )
                            root = "build/integration-live-restart" if live_restart_only else "build/integration-results"
                            result = ANDROID / f"{root}/{prefix}-{phase}"
                            shutil.rmtree(result, ignore_errors=True)
                            result.mkdir(parents=True)
                            (result / "instrumentation.txt").write_text(output)
                            print(output)
                            if not re.search(r"OK \(1 test\)", output) or "FAILURES!!!" in output:
                                raise RuntimeError(f"{test_class} phase {phase} failed; see {result}")
                            (result / "result.json").write_text(
                                json.dumps({"phase": phase, "tests": 1, "failures": 0, "errors": 0, "skipped": 0}, indent=2)
                                + "\n"
                            )
                adb("pull", "/sdcard/Download/soundsible-s1-library.png", str(ANDROID / "build/library.png"))
                adb("pull", "/sdcard/Download/soundsible-s2-program.png", str(ANDROID / "build/program.png"))
            finally:
                for process in processes:
                    process.terminate()
                for process in processes:
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                if live_fixture is not None:
                    live_fixture.close()
                certificate_resource.unlink(missing_ok=True)
                policy_resource.unlink(missing_ok=True)
    # The distributed development APK is rebuilt without temporary test trust.
    gradle(":app:assembleDebug", ":app:assembleDebugAndroidTest", ":app:testDebugUnitTest", ":app:lintDebug")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("doctor", "prepare", "build", "install", "smoke", "integration"))
    parser.add_argument("--serial", help="adb device serial (or set ANDROID_SERIAL)")
    restart = parser.add_mutually_exclusive_group()
    restart.add_argument(
        "--offline-restart-only",
        action="store_true",
        help="integration: run only the prepare/force-stop/offline protocol; does not validate the main suite",
    )
    restart.add_argument("--live-restart-only", action="store_true",
                         help="integration: run only Live prepare/force-stop/resume on the isolated relay")
    args = parser.parse_args()
    if (args.offline_restart_only or args.live_restart_only) and args.command != "integration":
        parser.error("restart-only flags require integration")
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
        elif args.command == "integration":
            integration(restart_only=args.offline_restart_only, live_restart_only=args.live_restart_only)
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
