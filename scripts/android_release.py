#!/usr/bin/env python3
"""Signed Android alpha, built for and attached to the version's own release.

Until 0.21.1 the APK went out as an independent `android-alpha/*` prerelease,
allocating its versionCode through draft reservations. Every artefact of a
version now ships in that version's `v*` release, so the code is derived from
the version itself and the APK is staged here for release.yml to attach. The
published `android-alpha/*` prereleases stay as upgrade predecessors.
"""

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
import xml.etree.ElementTree as ET

import android as build
from download_retry import Rejected, fetch
from version_sync import declared_version, sync

ROOT = build.ROOT
OUT = ROOT / "android/build/alpha"
PACKAGE = "com.soundsible.android"
HOST = "arzuparreta.github.io"
SEED_HARNESS = "upgrade-seed-androidTest.apk"
LEGACY_TAG = re.compile(r"^android-alpha/(.+)-(\d+)-([0-9a-f]{12})$")
RELEASE_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$")
APK = "Soundsible-Android-alpha.apk"
SUMS = "SHA256SUMS-android.txt"
# How long `stage` waits for the tagged commit's own CI before giving up. The
# tag is pushed on the release merge commit, so its checks run beside this job.
CHECKS_TIMEOUT = 90 * 60
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
    "lint",
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
    pages = gh("api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases?per_page=100")
    return [item for page in pages for item in page]


def version_code(version: str) -> int:
    """versionCode for a release, ordered exactly as the versions are.

    MAJOR.MINOR.PATCH gives MMMmmpp99; `-rc.N` replaces the final 99 with N, so
    a candidate installs below its release and the release updates it. The
    first value, 220099 for 0.22.0, is far above the four codes the old
    allocator handed out.
    """
    match = RELEASE_TAG.fullmatch(f"v{version}")
    if not match:
        raise RuntimeError(f"{version} is not a release version")
    major, minor, patch = (int(part) for part in match.groups()[:3])
    candidate = match[4]
    if minor > 99 or patch > 99 or (candidate is not None and not 1 <= int(candidate) <= 98):
        raise RuntimeError(f"{version} does not fit the versionCode layout")
    code = ((major * 100 + minor) * 100 + patch) * 100 + (int(candidate) if candidate else 99)
    if code > 2_100_000_000:
        raise RuntimeError("Android versionCode exhausted")
    return code


def plan_for(version: str, revision: str) -> dict:
    return {
        "version": version,
        "version_code": version_code(version),
        "source_revision": revision,
        "channel": "alpha",
        "tag": f"v{version}",
    }


def release_code(item: dict) -> int | None:
    """The versionCode a published release carries, or None if it has no APK."""
    if item.get("draft"):
        return None
    if legacy := LEGACY_TAG.fullmatch(item["tag_name"]):
        return int(legacy[2])
    if RELEASE_TAG.fullmatch(item["tag_name"]) and any(
        asset.get("name") == APK for asset in item.get("assets", [])
    ):
        return version_code(item["tag_name"][1:])
    return None


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


def checks(revision: str, *, wait: float = 0) -> list[dict]:
    """The required checks on ``revision``, all green.

    With ``wait`` it polls until every one has finished, for the tag's own CI
    that is still running when the release job reaches this point."""
    deadline = time.monotonic() + wait
    while True:
        pages = gh(
            "api",
            "--paginate",
            "--slurp",
            f"repos/{{owner}}/{{repo}}/commits/{revision}/check-runs?per_page=100",
        )
        rows = [row for page in pages for row in page["check_runs"]]
        latest = {}
        for row in sorted(rows, key=lambda row: row["id"]):
            latest[row["name"]] = row
        missing = CHECKS - latest.keys()
        running = {name for name in CHECKS & latest.keys() if latest[name]["status"] != "completed"}
        if (missing or running) and time.monotonic() < deadline:
            time.sleep(60)
            continue
        failed = {
            name for name in CHECKS & latest.keys()
            if latest[name]["status"] == "completed" and latest[name]["conclusion"] != "success"
        }
        if missing or running or failed:
            raise RuntimeError(
                f"Release checks not green; missing={sorted(missing)}, running={sorted(running)}, "
                f"unsuccessful={sorted(failed)}"
            )
        return [{"name": name, "url": latest[name]["html_url"], "conclusion": "success"} for name in sorted(CHECKS)]


def plan_build() -> dict:
    """The build this checkout is: a tag's own release, or a dry run on main."""
    revision = clean()
    if os.getenv("GITHUB_REF_TYPE") == "tag":
        if os.getenv("GITHUB_REF_NAME") != f"v{declared_version()}":
            raise RuntimeError("Tag and declared version differ")
    elif os.getenv("GITHUB_ACTIONS") and os.getenv("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("Only a release tag, or main as a dry run, builds the public APK")
    return plan_for(declared_version(), revision)


def compile_apk(plan: dict, destination: Path) -> None:
    if clean() != plan["source_revision"] or declared_version() != plan["version"]:
        raise RuntimeError("Plan does not match clean sources")
    build.prepare(channel="alpha", version_code=plan["version_code"])
    build.gradle(
        ":app:assembleRelease", ":app:assembleReleaseAndroidTest", ":app:testReleaseUnitTest", ":app:lintRelease"
    )
    shutil.copy2(ROOT / "android/app/build/outputs/apk/release/app-release.apk", destination)


def verify_apk(apk: Path, plan: dict, *, published: bool = False) -> dict:
    capabilities, signing = gates()
    if published:
        capabilities = plan["capabilities"]
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


def rendered_link_payload(xml: str, title: str, artist: str) -> bool:
    labels = "\n".join(
        node.get("text", "") + "\n" + node.get("content-desc", "")
        for node in ET.fromstring(xml).iter("node") if node.get("package") == PACKAGE
    )
    return title in labels and artist in labels


def await_link_payload(phase: str, title: str, artist: str) -> None:
    remote = "/sdcard/Download/soundsible-release-app-link.xml"
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            adb("shell", "uiautomator", "dump", remote)
            xml = adb("shell", "cat", remote)
            (OUT / f"app-links-{phase}.xml").write_text(xml + "\n")
            if rendered_link_payload(xml, title, artist):
                return
        except (subprocess.CalledProcessError, ET.ParseError):
            pass
        time.sleep(1)
    raise RuntimeError(f"App Link {phase} payload was not rendered by the release APK")


def app_links() -> None:
    _, signing = gates()
    url = f"https://{HOST}/.well-known/assetlinks.json"

    def exact(response: object, body: bytes) -> None:
        if response.geturl() != url or response.headers.get_content_type() != "application/json":
            raise Rejected("assetlinks.json redirected or has the wrong content type")
        try:
            json.loads(body)
        except ValueError as error:
            raise Rejected(f"assetlinks.json is not JSON: {error}") from error

    statements = json.loads(fetch([url], max_bytes=1024 * 1024, validate=exact, timeout=30, what="assetlinks.json"))
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
            adb("shell", "am", "force-stop", PACKAGE)
            for phase in ("cold", "warm"):
                title, artist = f"Release link {phase}", f"Fixture {phase}"
                capsule = (
                    base64.urlsafe_b64encode(
                        json.dumps(
                            {
                                "v": 1,
                                "kind": "music",
                                "yt": "abcdefghijk",
                                "title": title,
                                "artist": artist,
                            }
                        ).encode()
                    )
                    .decode()
                    .rstrip("=")
                )
                link = f"https://{HOST}/soundsible.github.io/open/#t={capsule}"
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
                await_link_payload(phase, title, artist)
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


def published_predecessor(items: list[dict], code: int) -> dict | None:
    public = [item for item in items if release_code(item) is not None]
    if not public:
        return None
    item = max(public, key=release_code)
    if release_code(item) >= code:
        raise RuntimeError("Published predecessor is not older than candidate")
    return item


def upgrade_baseline(plan: dict) -> tuple[Path, Path, dict]:
    item = published_predecessor(releases(), plan["version_code"])
    if item is None:
        baseline = {**plan, "version_code": plan["version_code"] - 1}
        apk = OUT / "update-baseline.apk"
        compile_apk(baseline, apk)
        verify_apk(apk, baseline)
        harness = ROOT / "android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk"
        return apk, harness, {"kind": "synthetic-first-release", "version_code": baseline["version_code"]}
    directory = OUT / "published-predecessor"
    directory.mkdir(parents=True, exist_ok=True)
    command(
        "gh", "release", "download", item["tag_name"], "--dir", str(directory), "--clobber",
        "--pattern", APK, "--pattern", "android-release.json",
        "--pattern", SEED_HARNESS,
    )
    metadata = json.loads((directory / "android-release.json").read_text())
    apk = directory / APK
    if (
        metadata.get("tag") != item["tag_name"]
        or metadata.get("version_code") != release_code(item)
        or metadata.get("sha256") != digest(apk)
    ):
        raise RuntimeError("Published predecessor metadata/APK disagree")
    verify_apk(apk, metadata, published=True)
    harness = directory / SEED_HARNESS
    if metadata.get("upgrade_seed_harness") != {"apk": SEED_HARNESS, "sha256": digest(harness)}:
        raise RuntimeError("Published predecessor seed harness differs from its metadata")
    verify_harness(harness)
    return apk, harness, {"kind": "published", "tag": item["tag_name"], "version_code": metadata["version_code"],
                 "apk_sha256": digest(apk)}


def verify_harness(harness: Path) -> None:
    _, signing = gates()
    signature = command(str(build.sdk() / "build-tools/36.0.0/apksigner"), "verify", "--print-certs", str(harness))
    match = re.search(r"Signer #1 certificate SHA-256 digest: ([0-9a-f]+)", signature)
    if not match or match[1].upper() != signing["certificate_sha256"].replace(":", ""):
        raise RuntimeError("Upgrade seed harness does not carry the permanent certificate")


def acceptance(plan: dict, apk: Path) -> dict:
    """Published predecessor -> exact candidate, against a disposable HTTP engine."""
    build.doctor()
    devices = [line for line in adb("devices").splitlines()[1:] if line.strip()]
    if len(devices) != 1 or adb("shell", "getprop", "ro.kernel.qemu") != "1":
        raise RuntimeError("Acceptance requires exactly one emulator, no physical devices")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 5097))
    adb("shell", "am", "force-stop", PACKAGE)
    OUT.mkdir(parents=True, exist_ok=True)
    candidate_harness = OUT / SEED_HARNESS
    verify_harness(candidate_harness)
    baseline_apk, seed_harness, baseline_evidence = upgrade_baseline(plan)
    # Release test APK is signed with the permanent key; the production target stays non-debuggable.
    origin = "http://10.0.2.2:5097"
    with tempfile.TemporaryDirectory(prefix="soundsible-release-fixture-") as directory:
        with (OUT / "fixture.log").open("w") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "scripts/android_fixture.py"),
                    "--root",
                    str(Path(directory) / "engine"),
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
                adb("install", "-r", str(seed_harness))
                adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
                instrument(
                    "OfflineRestartTest", OUT / "update-prepare.txt", offlinePhase="prepare", fixtureOrigin=origin
                )
                instrument("ReleaseUpdateTest", OUT / "update-seed.txt", updatePhase="seed", fixtureOrigin=origin)
                adb("shell", "am", "force-stop", PACKAGE)
                adb("install", "-r", str(apk))
                adb("install", "-r", str(candidate_harness))
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
                    "upgrade_baseline": baseline_evidence,
                    "update_preserves_account_settings_offline": True,
                    "downgrade_rejected": True,
                    "wrong_signature_rejected": True,
                    "corrupt_apk_rejected": True,
                    "release_startup": True,
                    "offline_pcm": True,
                    "app_links_verified": True,
                    "app_links_payload_delivered": True,
                }
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def stage(plan: dict, apk: Path, receipt: dict) -> Path:
    """Gather what release.yml attaches to the version's release.

    Nothing is published here: the release job uploads the directory as an
    artifact and the release's own publish step attaches it beside the other
    platforms, so a version is out everywhere or nowhere."""
    if clean() != plan["source_revision"]:
        raise RuntimeError("Checkout differs from the planned build")
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
            "app_links_payload_delivered",
        )
    ):
        raise RuntimeError("Release APK acceptance is incomplete or belongs to another APK")
    harness = OUT / SEED_HARNESS
    verify_harness(harness)
    metadata["upgrade_seed_harness"] = {"apk": SEED_HARNESS, "sha256": digest(harness)}
    metadata["checks"] = checks(plan["source_revision"], wait=CHECKS_TIMEOUT)
    staged = OUT / "release"
    if staged.exists():
        shutil.rmtree(staged)
    staged.mkdir(parents=True)
    write(staged / "android-release.json", metadata)
    write(staged / "release-acceptance.json", receipt)
    for path in (apk, harness):
        shutil.copy2(path, staged / path.name)
    (staged / SUMS).write_text(
        "".join(
            f"{digest(staged / name)}  {name}\n"
            for name in (APK, SEED_HARNESS, "android-release.json", "release-acceptance.json")
        )
    )
    return staged


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "build", "verify", "acceptance", "stage"))
    parser.add_argument("--plan", type=Path, default=OUT / "plan.json")
    args = parser.parse_args()
    try:
        os.environ["SOUNDSIBLE_ANDROID_TEST_RELEASE"] = "1"
        OUT.mkdir(parents=True, exist_ok=True)
        if args.command == "plan":
            planned = plan_build()
            write(args.plan, planned)
            print(json.dumps(planned, indent=2))
            return 0
        planned = json.loads(args.plan.read_text())
        apk = OUT / APK
        if args.command == "build":
            compile_apk(planned, apk)
            shutil.copy2(
                ROOT / "android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk",
                OUT / SEED_HARNESS,
            )
        elif args.command == "verify":
            write(OUT / "android-release.json", verify_apk(apk, planned))
        elif args.command == "acceptance":
            write(OUT / "release-acceptance.json", acceptance(planned, apk))
        else:
            print(stage(planned, apk, json.loads((OUT / "release-acceptance.json").read_text())))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, StopIteration) as error:
        # Do not echo captured subprocess streams: signing tools may print credentials on failure.
        print(f"Android alpha: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
