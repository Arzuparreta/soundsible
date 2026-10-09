"""Public Android identity, evidence and channel allocation cannot silently drift."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import android_release as release


@pytest.mark.parametrize("package,title,artist,accepted", [
    (release.PACKAGE, "Release link warm", "Fixture warm", True),
    ("browser.example", "Release link warm", "Fixture warm", False),
    (release.PACKAGE, "Release link cold", "Fixture cold", False),
    (release.PACKAGE, "Release link warm", "", False),
])
def test_app_link_requires_current_rendered_payload_in_the_public_app(package, title, artist, accepted):
    root = ET.Element("hierarchy")
    ET.SubElement(root, "node", package=package, text=title + "\n" + artist)
    assert release.rendered_link_payload(ET.tostring(root, encoding="unicode"),
                                         "Release link warm", "Fixture warm") is accepted


def test_predecessor_sdk_policy_comes_from_its_published_metadata(monkeypatch, tmp_path):
    capabilities, signing = release.gates()
    old_policy = {**capabilities, "min_sdk": capabilities["min_sdk"] - 1,
                  "target_sdk": capabilities["target_sdk"] - 1}
    apk = tmp_path / "old.apk"
    with ZipFile(apk, "w") as archive:
        for abi in ("arm64-v8a", "armeabi-v7a", "x86", "x86_64"):
            archive.writestr(f"lib/{abi}/fixture.so", b"fixture")
    plan = {"version": release.declared_version(), "version_code": 2, "capabilities": old_policy}
    monkeypatch.setattr(release.build, "sdk", lambda: tmp_path)
    def inspect(*args):
        if "apksigner" in args[0]:
            return "Signer #1 certificate SHA-256 digest: " + signing["certificate_sha256"].replace(":", "").lower()
        return (f"package: name='{release.PACKAGE}' versionCode='2' versionName='{plan['version']}'\n"
                f"sdkVersion:'{old_policy['min_sdk']}'\ntargetSdkVersion:'{old_policy['target_sdk']}'")
    monkeypatch.setattr(release, "command", inspect)
    assert release.verify_apk(apk, plan, published=True)["capabilities"] == old_policy
    with pytest.raises(RuntimeError, match="SDK differs"):
        release.verify_apk(apk, plan)


def test_predecessor_is_latest_published_alpha_not_a_failed_draft():
    def tag(code):
        return f"android-alpha/{release.declared_version()}-{code}-{'b' * 12}"
    old = {"tag_name": tag(2), "draft": False}
    latest = {"tag_name": tag(4), "draft": False}
    assert release.published_predecessor(
        [old, latest, {"tag_name": tag(5), "draft": True}, {"tag_name": "v-other", "draft": False}], 6
    ) == latest
    assert release.published_predecessor([{"tag_name": tag(3), "draft": True}], 4) is None
    with pytest.raises(RuntimeError, match="not older"):
        release.published_predecessor([latest], 4)


def test_public_upgrade_downloads_exact_old_apk_without_recompiling(monkeypatch, tmp_path):
    tag = f"android-alpha/{release.declared_version()}-2-{'b' * 12}"
    monkeypatch.setattr(release, "OUT", tmp_path)
    monkeypatch.setattr(release, "releases", lambda: [{"tag_name": tag, "draft": False}])
    monkeypatch.setattr(release, "compile_apk", lambda *args: pytest.fail("Recompiled public predecessor"))
    checked = []
    monkeypatch.setattr(release, "verify_apk", lambda apk, metadata, **kwargs: checked.append((apk.read_bytes(), kwargs)))
    monkeypatch.setattr(release, "verify_harness", lambda harness: None)

    def download(*args):
        assert args[:4] == ("gh", "release", "download", tag)
        directory = tmp_path / "published-predecessor"
        apk = directory / "Soundsible-Android-alpha.apk"
        apk.write_bytes(b"actual published binary")
        harness = directory / release.SEED_HARNESS
        harness.write_bytes(b"old matching tests")
        (directory / "android-release.json").write_text(json.dumps(
            {"tag": tag, "version_code": 2, "sha256": release.digest(apk),
             "upgrade_seed_harness": {"apk": release.SEED_HARNESS, "sha256": release.digest(harness)}}
        ))
    monkeypatch.setattr(release, "command", download)
    apk, harness, evidence = release.upgrade_baseline({"version_code": 4})
    assert checked == [(b"actual published binary", {"published": True})]
    assert harness.read_bytes() == b"old matching tests"
    assert evidence["kind"] == "published" and evidence["version_code"] == 2
    metadata = apk.parent / "android-release.json"
    monkeypatch.setattr(release, "command", lambda *args: None)
    metadata.write_text(json.dumps({"tag": tag, "version_code": 2, "sha256": "tampered"}))
    with pytest.raises(RuntimeError, match="disagree"):
        release.upgrade_baseline({"version_code": 4})


def test_version_codes_order_exactly_like_versions():
    versions = ["0.22.0-rc.1", "0.22.0-rc.2", "0.22.0", "0.22.1", "0.23.0-rc.1", "0.23.0", "1.0.0"]
    codes = [release.version_code(version) for version in versions]
    assert codes == sorted(codes) and len(set(codes)) == len(codes)
    # Above every code the draft allocator of the android-alpha channel used.
    assert release.version_code("0.22.0") == 220099
    plan = release.plan_for("0.22.0", "a" * 40)
    assert plan["tag"] == "v0.22.0" and plan["version_code"] == 220099


@pytest.mark.parametrize("version", ["0.100.0", "0.1.100", "0.22.0-rc.99", "0.22.0-beta.1", "2100.0.0"])
def test_versions_outside_the_layout_are_refused(version):
    with pytest.raises(RuntimeError):
        release.version_code(version)


def test_predecessor_may_be_a_version_release_or_a_legacy_alpha():
    legacy = {"tag_name": f"android-alpha/0.21.1-4-{'b' * 12}", "draft": False}
    apk = {"name": release.APK}
    with_apk = {"tag_name": "v0.22.0", "draft": False, "assets": [apk]}
    without_apk = {"tag_name": "v0.21.1", "draft": False, "assets": [{"name": "Soundsible.ipa"}]}
    unpublished = {"tag_name": "v0.22.1", "draft": True, "assets": [apk]}
    assert release.published_predecessor([legacy, without_apk], 220099) == legacy
    assert release.published_predecessor([legacy, with_apk, without_apk, unpublished], 220199) == with_apk
    with pytest.raises(RuntimeError, match="not older"):
        release.published_predecessor([with_apk], 220099)


def test_repository_manifest_records_alpha_limits():
    capabilities, signing = release.gates()
    assert capabilities["physical_acceptance"] == "pending-beta"
    assert capabilities["validated_api"] == [36]
    assert signing["application_id"] == release.PACKAGE


@pytest.mark.parametrize(
    "change", ["missing-dj", "offline-unapproved", "backup-unverified", "certificate-invalid", "missing-evidence"]
)
def test_incomplete_gates_fail_closed(tmp_path, change):
    capabilities, signing = release.gates()
    docs = tmp_path / "docs/android"
    docs.mkdir(parents=True)
    (docs / "EVIDENCE.md").write_text("fixture evidence")
    if change == "missing-dj":
        capabilities["automated"].remove("dj")
    if change == "offline-unapproved":
        capabilities["offline_approved"] = False
    if change == "backup-unverified":
        signing["backup_verified"] = False
    if change == "certificate-invalid":
        signing["certificate_sha256"] = "debug"
    if change == "missing-evidence":
        capabilities["evidence"] = "missing.md"
    (docs / "CAPABILITIES.json").write_text(json.dumps(capabilities))
    (docs / "SIGNING.json").write_text(json.dumps(signing))
    with pytest.raises(RuntimeError):
        release.gates(tmp_path)


def _check_rows(status="completed", conclusion="success"):
    return [
        {"id": i, "name": name, "status": status, "conclusion": conclusion, "html_url": "https://github.com/check"}
        for i, name in enumerate(release.CHECKS)
    ]


@pytest.mark.parametrize("failed_check", ["Emulator shard 2/4 (API 36)", "lint"])
def test_checks_require_full_android_and_shared_regression(monkeypatch, failed_check):
    rows = _check_rows()
    monkeypatch.setattr(release, "gh", lambda *args: [{"check_runs": rows}])
    assert len(release.checks("a" * 40)) == len(release.CHECKS)
    rows.append({"id": 100, "name": failed_check, "status": "completed", "conclusion": "failure"})
    with pytest.raises(RuntimeError, match="unsuccessful"):
        release.checks("a" * 40)
    rows.clear()
    with pytest.raises(RuntimeError, match="missing"):
        release.checks("a" * 40)


def test_checks_wait_for_the_tags_own_ci(monkeypatch):
    # The tag is pushed on the release merge commit; its CI is still running.
    answers = iter([_check_rows(status="in_progress", conclusion=None), _check_rows()])
    monkeypatch.setattr(release, "gh", lambda *args: [{"check_runs": next(answers)}])
    monkeypatch.setattr(release.time, "sleep", lambda seconds: None)
    assert len(release.checks("a" * 40, wait=3600)) == len(release.CHECKS)
    monkeypatch.setattr(release, "gh", lambda *args: [{"check_runs": _check_rows(status="in_progress", conclusion=None)}])
    with pytest.raises(RuntimeError, match="running"):
        release.checks("a" * 40)


@pytest.mark.parametrize("ref_type,ref_name,ref,accepted", [
    ("tag", "v{version}", "refs/tags/v{version}", True),
    ("tag", "v0.0.1", "refs/tags/v0.0.1", False),
    ("branch", "main", "refs/heads/main", True),
    ("branch", "feature", "refs/heads/feature", False),
])
def test_only_the_versions_tag_or_main_build_the_public_apk(monkeypatch, ref_type, ref_name, ref, accepted):
    version = release.declared_version()
    monkeypatch.setattr(release, "clean", lambda: "a" * 40)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_REF_TYPE", ref_type)
    monkeypatch.setenv("GITHUB_REF_NAME", ref_name.format(version=version))
    monkeypatch.setenv("GITHUB_REF", ref.format(version=version))
    if accepted:
        assert release.plan_build()["tag"] == f"v{version}"
    else:
        with pytest.raises(RuntimeError):
            release.plan_build()


def _receipt(apk, revision):
    receipt = {"source_revision": revision, "version_code": 220099, "apk_sha256": release.digest(apk)}
    for key in ("update_preserves_account_settings_offline", "downgrade_rejected", "wrong_signature_rejected",
                "corrupt_apk_rejected", "release_startup", "offline_pcm", "app_links_verified",
                "app_links_payload_delivered"):
        receipt[key] = True
    return receipt


def test_receipt_from_a_different_apk_cannot_be_staged(monkeypatch, tmp_path):
    revision = "a" * 40
    apk = tmp_path / release.APK
    apk.write_bytes(b"candidate")
    plan = {"source_revision": revision, "version_code": 220099}
    monkeypatch.setattr(release, "clean", lambda: revision)
    monkeypatch.setattr(release, "verify_apk", lambda *args: {})
    with pytest.raises(RuntimeError, match="acceptance is incomplete"):
        release.stage(plan, apk, {**_receipt(apk, revision), "apk_sha256": "another artifact"})


def test_staging_gathers_exactly_what_the_release_attaches(monkeypatch, tmp_path):
    revision = "a" * 40
    monkeypatch.setattr(release, "OUT", tmp_path)
    apk = tmp_path / release.APK
    apk.write_bytes(b"candidate")
    (tmp_path / release.SEED_HARNESS).write_bytes(b"matching harness")
    plan = {"source_revision": revision, "version_code": 220099, "tag": "v0.22.0"}
    monkeypatch.setattr(release, "clean", lambda: revision)
    monkeypatch.setattr(release, "verify_apk", lambda *args: {"tag": "v0.22.0"})
    monkeypatch.setattr(release, "verify_harness", lambda *args: None)
    waited = []
    monkeypatch.setattr(release, "checks", lambda revision, wait: waited.append(wait) or [])
    monkeypatch.setattr(release, "command", lambda *args: pytest.fail("Staging must not publish anything"))

    staged = release.stage(plan, apk, _receipt(apk, revision))

    assert waited == [release.CHECKS_TIMEOUT]
    assert sorted(path.name for path in staged.iterdir()) == sorted(
        [release.APK, release.SEED_HARNESS, "android-release.json", "release-acceptance.json", release.SUMS]
    )
    sums = (staged / release.SUMS).read_text()
    assert f"{release.digest(apk)}  {release.APK}" in sums
    metadata = json.loads((staged / "android-release.json").read_text())
    assert metadata["upgrade_seed_harness"]["sha256"] == release.digest(tmp_path / release.SEED_HARNESS)


def test_every_version_release_carries_the_apk():
    import yaml

    workflows = Path(__file__).resolve().parents[1] / ".github/workflows"
    release_jobs = yaml.safe_load((workflows / "release.yml").read_text())["jobs"]
    assert release_jobs["android"]["uses"] == "./.github/workflows/android-release.yml"
    # A version is out on every platform or none.
    assert "android" in release_jobs["publish"]["needs"]
    android = yaml.safe_load((workflows / "android-release.yml").read_text())
    triggers = android[True]  # YAML 1.1 reads the `on:` key as a boolean.
    assert "workflow_call" in triggers
    steps = android["jobs"]["alpha"]["steps"]
    upload = next(step for step in steps if step.get("name") == "Upload the staged APK")
    # publish downloads `soundsible-*` artifacts and attaches them.
    assert upload["with"]["name"].startswith("soundsible-")
    assert upload["with"]["path"].rstrip("/").endswith("android/build/alpha/release")
    assert not any("publish" in (step.get("run") or "") for step in steps)
