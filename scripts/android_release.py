#!/usr/bin/env python3
"""Independent signed Android alpha channel. Never creates a global v* tag."""

from __future__ import annotations

import argparse
import base64
import hashlib
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
from zipfile import ZipFile

import android as build
from version_sync import declared_version, sync

ROOT = build.ROOT
OUT = ROOT / "android/build/alpha"
PACKAGE = "com.soundsible.android"
HOST = "arzuparreta.github.io"
TAG = re.compile(r"^android-alpha/(.+)-(\d+)-([0-9a-f]{12})$")
CAPABILITIES = {
    "phone",
    "account",
    "library",
    "acquisition",
    "normal",
    "podcasts",
    "radio",
    "dj",
    "live-listen",
    "live-publish",
    "android-auto",
    "offline",
}
CHECKS = {
    "Build, lint and unit tests",
    *(f"Emulator shard {i}/4 (API 36)" for i in range(4)),
    "tests",
    "ui_build",
    "ui_accessibility",
    "version_consistency",
    "security",
}


def command(*args: str, cwd: Path = ROOT) -> str:
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()


def gh(*args: str):
    return json.loads(command("gh", *args))


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def releases() -> list[dict]:
    return gh("api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases?per_page=100", "--jq", "add")


def allocate(items: list[dict], version: str, revision: str) -> dict:
    codes = [int(match[2]) for item in items if (match := TAG.fullmatch(item["tag_name"]))]
    # Reserve code 1 for the private first-update baseline; first public code is 2.
    code = max(codes, default=1) + 1
    if code > 2_100_000_000:
        raise RuntimeError("Android versionCode exhausted")
    return {
        "version": version,
        "version_code": code,
        "source_revision": revision,
        "channel": "alpha",
        "tag": f"android-alpha/{version}-{code}-{revision[:12]}",
    }


def gates(root: Path = ROOT) -> tuple[dict, dict]:
    capabilities = json.loads((root / "docs/android/CAPABILITIES.json").read_text())
    signing = json.loads((root / "docs/android/SIGNING.json").read_text())
    if (
        capabilities.get("channel") != "alpha"
        or capabilities.get("offline_decision") != "B"
        or capabilities.get("offline_approved") is not True
        or set(capabilities.get("required_capabilities", [])) != CAPABILITIES
        or not CAPABILITIES <= set(capabilities.get("automated", []))
        or not (root / capabilities.get("evidence", "missing")).is_file()
    ):
        raise RuntimeError("Parity/offline evidence gates are incomplete")
    if (
        signing.get("application_id") != PACKAGE
        or signing.get("backup_verified") is not True
        or not re.fullmatch(r"(?:[0-9A-F]{2}:){31}[0-9A-F]{2}", signing.get("certificate_sha256", ""))
    ):
        raise RuntimeError("Permanent signing identity/backup gate is incomplete")
    return capabilities, signing


def clean() -> str:
    revision = command("git", "rev-parse", "HEAD")
    if command("git", "status", "--porcelain"):
        raise RuntimeError("Release requires a clean checkout")
    if sync(declared_version(), check=True):
        raise RuntimeError("Central version manifests disagree")
    gates()
    return revision


def checks(revision: str) -> list[dict]:
    rows = gh(
        "api",
        "--paginate",
        "--slurp",
        f"repos/{{owner}}/{{repo}}/commits/{revision}/check-runs?per_page=100",
        "--jq",
        "[.[].check_runs[]]",
    )
    latest = {}
    for row in sorted(rows, key=lambda row: row["id"]):
        latest[row["name"]] = row
    missing = CHECKS - latest.keys()
    failed = {name for name in CHECKS & latest.keys() if latest[name]["conclusion"] != "success"}
    if missing or failed:
        raise RuntimeError(f"Release checks not green; missing={sorted(missing)}, unsuccessful={sorted(failed)}")
    return [{"name": name, "url": latest[name]["html_url"], "conclusion": "success"} for name in sorted(CHECKS)]


def reserve() -> dict:
    revision = clean()
    remote = gh("api", "repos/{owner}/{repo}/branches/main")["commit"]["sha"]
    if revision != remote:
        raise RuntimeError("Only the current remote main may reserve a public release")
    checks(revision)
    run_id = os.getenv("GITHUB_RUN_ID")
    items = releases()
    # Workflow reruns reuse their own draft reservation; published releases stay immutable.
    if run_id:
        marker = f"<!-- android-run:{run_id} -->"
        for item in items:
            if TAG.fullmatch(item["tag_name"]) and marker in (item.get("body") or ""):
                if not item["draft"]:
                    raise RuntimeError("This run has already published; refusing to replace it")
                plan = json.loads((item["body"].split("```json\n", 1)[1]).split("\n```", 1)[0])
                if plan["source_revision"] != revision:
                    raise RuntimeError("Reservation does not match checkout")
                return plan
    else:
        marker = "<!-- android-local-reservation -->"
    plan = allocate(items, declared_version(), revision)
    body = marker + "\nPrivate build reservation. Not a published APK.\n```json\n" + json.dumps(plan) + "\n```"
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as request:
        json.dump(
            {
                "tag_name": plan["tag"],
                "target_commitish": revision,
                "name": f"Soundsible Android alpha · {plan['version']} · build {plan['version_code']}",
                "body": body,
                "draft": True,
                "prerelease": True,
                "make_latest": "false",
            },
            request,
        )
        request.flush()
        gh("api", "repos/{owner}/{repo}/releases", "--method", "POST", "--input", request.name)
    return plan


def compile_apk(plan: dict, destination: Path) -> None:
    if clean() != plan["source_revision"] or declared_version() != plan["version"]:
        raise RuntimeError("Plan does not match clean sources")
    build.prepare(channel="alpha", version_code=plan["version_code"])
    build.gradle(
        ":app:assembleRelease", ":app:assembleReleaseAndroidTest", ":app:testReleaseUnitTest", ":app:lintRelease"
    )
    shutil.copy2(ROOT / "android/app/build/outputs/apk/release/app-release.apk", destination)


def verify_apk(apk: Path, plan: dict) -> dict:
    capabilities, signing = gates()
    tools = build.sdk() / "build-tools/36.0.0"
    signature = command(str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk))
    match = re.search(r"Signer #1 certificate SHA-256 digest: ([0-9a-f]+)", signature)
    if not match or match[1].upper() != signing["certificate_sha256"].replace(":", ""):
        raise RuntimeError("APK does not carry the permanent certificate")
    badging = command(str(tools / "aapt"), "dump", "badging", str(apk))
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    if not package or (package[1], int(package[2]), package[3]) != (PACKAGE, plan["version_code"], plan["version"]):
        raise RuntimeError("APK identity/version differs from reservation")
    if "application-debuggable" in badging:
        raise RuntimeError("Public APK is debuggable")
    if (
        f"sdkVersion:'{capabilities['min_sdk']}'" not in badging
        or f"targetSdkVersion:'{capabilities['target_sdk']}'" not in badging
    ):
        raise RuntimeError("APK SDK differs from capabilities")
    with ZipFile(apk) as archive:
        names = archive.namelist()
        if any("android_fixture_ca" in name for name in names):
            raise RuntimeError("Public APK contains fixture trust")
        abis = sorted({name.split("/")[1] for name in names if name.startswith("lib/")})
        if set(abis) != {"arm64-v8a", "armeabi-v7a", "x86", "x86_64"}:
            raise RuntimeError("Universal APK is missing native architectures")
    permissions = re.findall(r"uses-permission: name='([^']+)'", badging)
    if "android.permission.RECORD_AUDIO" in permissions:
        raise RuntimeError("Unexpected microphone permission")
    return {
        **plan,
        "application_id": PACKAGE,
        "dirty": False,
        "apk": apk.name,
        "sha256": digest(apk),
        "certificate_sha256": signing["certificate_sha256"],
        "abis": abis,
        "permissions": permissions,
        "capabilities": capabilities,
    }


def adb(*args: str) -> str:
    return command(str(build.sdk() / "platform-tools/adb"), *args)


def instrument(test: str, log: Path, **arguments: str) -> None:
    output = adb(
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        "-e",
        "class",
        f"com.soundsible.android.{test}",
        *[value for key, value in arguments.items() for value in ("-e", key, value)],
        "com.soundsible.android.test/androidx.test.runner.AndroidJUnitRunner",
    )
    log.write_text(output + "\n")
    if not re.search(r"OK \(1 test\)", output) or "FAILURES!!!" in output:
        raise RuntimeError(f"Release instrumentation failed; inspect {log}")


def rejected(apk: Path, reason: str) -> None:
    result = subprocess.run(
        [str(build.sdk() / "platform-tools/adb"), "install", "-r", str(apk)], capture_output=True, text=True
    )
    if result.returncode == 0 or reason not in result.stdout + result.stderr:
        raise RuntimeError(f"Android did not reject {apk.name} with {reason}")


def app_links() -> None:
    _, signing = gates()
    url = f"https://{HOST}/.well-known/assetlinks.json"
    with urlopen(url, timeout=30) as response:
        if response.geturl() != url or response.headers.get_content_type() != "application/json":
            raise RuntimeError("assetlinks.json redirected or has the wrong content type")
        statements = json.load(response)
    if not any(
        "delegate_permission/common.handle_all_urls" in row.get("relation", [])
        and row.get("target", {}).get("package_name") == PACKAGE
        and signing["certificate_sha256"] in row["target"].get("sha256_cert_fingerprints", [])
        for row in statements
    ):
        raise RuntimeError("Published assetlinks.json does not match signing identity")
    adb("shell", "pm", "verify-app-links", "--re-verify", PACKAGE)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if re.search(rf"{re.escape(HOST)}:\s+verified", adb("shell", "pm", "get-app-links", PACKAGE)):
            capsule = (
                base64.urlsafe_b64encode(
                    json.dumps(
                        {
                            "v": 1,
                            "kind": "music",
                            "yt": "abcdefghijk",
                            "title": "Release link test",
                            "artist": "Fixture",
                        }
                    ).encode()
                )
                .decode()
                .rstrip("=")
            )
            link = f"https://{HOST}/soundsible.github.io/open/#t={capsule}"
            adb("shell", "am", "force-stop", PACKAGE)
            for _ in range(2):
                opened = adb(
                    "shell",
                    "am",
                    "start",
                    "-W",
                    "-a",
                    "android.intent.action.VIEW",
                    "-c",
                    "android.intent.category.BROWSABLE",
                    "-d",
                    link,
                )
                if not re.search(
                    r"Activity: com\.soundsible\.android/(?:\.MainActivity|com\.soundsible\.android\.MainActivity)",
                    opened,
                ):
                    raise RuntimeError("Verified public link did not open the release APK")
            unrelated = adb(
                "shell",
                "cmd",
                "package",
                "query-activities",
                "--brief",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                f"https://{HOST}/unrelated/",
            )
            if PACKAGE + "/" in unrelated:
                raise RuntimeError("App Links unexpectedly claim unrelated site paths")
            return
        time.sleep(3)
    raise RuntimeError("Android did not verify the public App Links domain")


def acceptance(plan: dict, apk: Path) -> dict:
    """Private predecessor -> exact candidate, against one owned disposable HTTP engine."""
    build.doctor()
    devices = [line for line in adb("devices").splitlines()[1:] if line.strip()]
    if len(devices) != 1 or adb("shell", "getprop", "ro.kernel.qemu") != "1":
        raise RuntimeError("Acceptance requires exactly one emulator, no physical devices")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 5097))
    adb("shell", "am", "force-stop", PACKAGE)
    OUT.mkdir(parents=True, exist_ok=True)
    baseline = {**plan, "version_code": plan["version_code"] - 1}
    baseline_apk = OUT / "update-baseline.apk"
    compile_apk(baseline, baseline_apk)
    verify_apk(baseline_apk, baseline)
    # Release test APK is signed with the permanent key; the production target stays non-debuggable.
    harness = ROOT / "android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk"
    origin = "http://10.0.2.2:5097"
    with tempfile.TemporaryDirectory(prefix="soundsible-release-fixture-") as directory:
        with (OUT / "fixture.log").open("w") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "scripts/android_fixture.py"),
                    "--root",
                    directory,
                    "--port",
                    "5097",
                    "--run-id",
                    "release-acceptance",
                ],
                cwd=ROOT,
                env={**os.environ, "PYTHONPATH": str(ROOT)},
                stdout=log,
                stderr=log,
            )
            try:
                deadline = time.monotonic() + 90
                while True:
                    if process.poll() is not None:
                        raise RuntimeError("Release fixture failed to start")
                    try:
                        with urlopen("http://127.0.0.1:5097/api/health", timeout=1):
                            break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Release fixture timed out")
                        time.sleep(1)
                # Only this disposable emulator's public package is touched.
                subprocess.run([str(build.sdk() / "platform-tools/adb"), "uninstall", PACKAGE], capture_output=True)
                adb("shell", "svc", "wifi", "enable")
                adb("install", str(baseline_apk))
                adb("install", "-r", str(harness))
                adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
                instrument(
                    "OfflineRestartTest", OUT / "update-prepare.txt", offlinePhase="prepare", fixtureOrigin=origin
                )
                instrument("ReleaseUpdateTest", OUT / "update-seed.txt", updatePhase="seed", fixtureOrigin=origin)
                adb("shell", "am", "force-stop", PACKAGE)
                adb("install", "-r", str(apk))
                instrument("ReleaseUpdateTest", OUT / "update-verify.txt", updatePhase="verify", fixtureOrigin=origin)
                rejected(baseline_apk, "INSTALL_FAILED_VERSION_DOWNGRADE")
                with tempfile.TemporaryDirectory() as scratch:
                    wrong = Path(scratch) / "wrong-signature.apk"
                    key = Path(scratch) / "wrong.p12"
                    command(
                        "keytool",
                        "-genkeypair",
                        "-keystore",
                        str(key),
                        "-storepass",
                        "test-only-password",
                        "-alias",
                        "negative",
                        "-keyalg",
                        "RSA",
                        "-validity",
                        "1",
                        "-dname",
                        "CN=Disposable negative test",
                    )
                    command(
                        str(build.sdk() / "build-tools/36.0.0/apksigner"),
                        "sign",
                        "--ks",
                        str(key),
                        "--ks-pass",
                        "pass:test-only-password",
                        "--out",
                        str(wrong),
                        str(apk),
                    )
                    rejected(wrong, "INSTALL_FAILED_UPDATE_INCOMPATIBLE")
                    corrupt = Path(scratch) / "corrupt.apk"
                    corrupt.write_bytes(apk.read_bytes()[:4096])
                    result = subprocess.run(
                        [str(build.sdk() / "platform-tools/adb"), "install", "-r", str(corrupt)],
                        capture_output=True,
                        text=True,
                    )
                    if result.returncode == 0:
                        raise RuntimeError("Android accepted corrupt APK")
                instrument(
                    "OfflineRestartTest", OUT / "update-offline.txt", offlinePhase="offline", fixtureOrigin=origin
                )
                # Fresh public candidate: packaged assets, language and permissions use real release identity.
                adb("uninstall", PACKAGE)
                adb("install", str(apk))
                instrument("StartupTest", OUT / "release-startup.txt", expectedVersion=plan["version"])
                app_links()
                return {
                    "source_revision": plan["source_revision"],
                    "version_code": plan["version_code"],
                    "apk_sha256": digest(apk),
                    "update_preserves_account_settings_offline": True,
                    "downgrade_rejected": True,
                    "wrong_signature_rejected": True,
                    "corrupt_apk_rejected": True,
                    "release_startup": True,
                    "offline_pcm": True,
                    "app_links_verified": True,
                }
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def publish(plan: dict, apk: Path, receipt: dict) -> None:
    if clean() != plan["source_revision"]:
        raise RuntimeError("Checkout differs from release reservation")
    metadata = verify_apk(apk, plan)
    expected = {
        "source_revision": plan["source_revision"],
        "version_code": plan["version_code"],
        "apk_sha256": digest(apk),
    }
    if any(receipt.get(key) != value for key, value in expected.items()) or any(
        receipt.get(key) is not True
        for key in (
            "update_preserves_account_settings_offline",
            "downgrade_rejected",
            "wrong_signature_rejected",
            "corrupt_apk_rejected",
            "release_startup",
            "offline_pcm",
            "app_links_verified",
        )
    ):
        raise RuntimeError("Release APK acceptance is incomplete or belongs to another APK")
    metadata["checks"] = checks(plan["source_revision"])
    item = next(row for row in releases() if row["tag_name"] == plan["tag"])
    if not item["draft"]:
        raise RuntimeError("Published Android assets are immutable")
    if gh("api", "repos/{owner}/{repo}/branches/main")["commit"]["sha"] != plan["source_revision"]:
        raise RuntimeError("Main advanced; validate and reserve its new head instead")
    write(OUT / "android-release.json", metadata)
    write(OUT / "release-acceptance.json", receipt)
    (OUT / "SHA256SUMS").write_text(
        "".join(
            f"{digest(path)}  {path.name}\n"
            for path in (apk, OUT / "android-release.json", OUT / "release-acceptance.json")
        )
    )
    notes = ROOT / "docs/android/ALPHA.md"
    marker = (item.get("body") or "").splitlines()[0]
    body = marker + "\n" + notes.read_text() + "\n\nBuild metadata: `android-release.json`. SHA-256: `SHA256SUMS`.\n"
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md") as file:
        file.write(body)
        file.flush()
        command(
            "gh",
            "release",
            "upload",
            plan["tag"],
            "--clobber",
            str(apk),
            str(OUT / "android-release.json"),
            str(OUT / "release-acceptance.json"),
            str(OUT / "SHA256SUMS"),
        )
        command(
            "gh",
            "release",
            "edit",
            plan["tag"],
            "--draft=false",
            "--prerelease",
            "--latest=false",
            "--notes-file",
            file.name,
        )
    print(command("gh", "release", "view", plan["tag"], "--json", "url", "--jq", ".url"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "reserve", "build", "verify", "acceptance", "publish"))
    parser.add_argument("--plan", type=Path, default=OUT / "plan.json")
    args = parser.parse_args()
    try:
        os.environ["SOUNDSIBLE_ANDROID_TEST_RELEASE"] = "1"
        OUT.mkdir(parents=True, exist_ok=True)
        if args.command in ("plan", "reserve"):
            plan = reserve() if args.command == "reserve" else allocate(releases(), declared_version(), clean())
            write(args.plan, plan)
            print(json.dumps(plan, indent=2))
            return 0
        plan = json.loads(args.plan.read_text())
        apk = OUT / "Soundsible-Android-alpha.apk"
        if args.command == "build":
            compile_apk(plan, apk)
        elif args.command == "verify":
            write(OUT / "android-release.json", verify_apk(apk, plan))
        elif args.command == "acceptance":
            write(OUT / "release-acceptance.json", acceptance(plan, apk))
        else:
            publish(plan, apk, json.loads((OUT / "release-acceptance.json").read_text()))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, StopIteration) as error:
        # Do not echo captured subprocess streams: signing tools may print credentials on failure.
        print(f"Android alpha: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
