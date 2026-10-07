"""Public Android identity, evidence and channel allocation cannot silently drift."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from zipfile import ZipFile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import android_release as release


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


def test_allocation_counts_failed_drafts_and_leaves_other_channels_alone():
    version = release.declared_version()
    revision = "a" * 40
    items = [{"tag_name": f"v{version}"}, {"tag_name": f"android-alpha/{version}-9-{'b' * 12}", "draft": True}]
    plan = release.allocate(items, version, revision)
    assert plan["version_code"] == 10
    assert plan["tag"] == f"android-alpha/{version}-10-{revision[:12]}"
    assert not plan["tag"].startswith("v")
    assert release.allocate([], version, revision)["version_code"] == 2


def test_counter_exhaustion_cannot_wrap_into_an_old_release():
    with pytest.raises(RuntimeError, match="exhausted"):
        release.allocate(
            [{"tag_name": f"android-alpha/{release.declared_version()}-2100000000-{'b' * 12}"}],
            release.declared_version(),
            "a" * 40,
        )


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


@pytest.mark.parametrize("failed_check", ["Emulator shard 2/4 (API 36)", "lint"])
def test_checks_require_full_android_and_shared_regression(monkeypatch, failed_check):
    rows = [
        {"id": i, "name": name, "conclusion": "success", "html_url": "https://github.com/check"}
        for i, name in enumerate(release.CHECKS)
    ]
    monkeypatch.setattr(release, "gh", lambda *args: [{"check_runs": rows}])
    assert len(release.checks("a" * 40)) == len(release.CHECKS)
    rows.append({"id": 100, "name": failed_check, "conclusion": "failure"})
    with pytest.raises(RuntimeError, match="unsuccessful"):
        release.checks("a" * 40)
    rows.clear()
    with pytest.raises(RuntimeError, match="missing"):
        release.checks("a" * 40)


def test_published_run_reservation_cannot_replace_assets(monkeypatch):
    revision = "a" * 40
    monkeypatch.setattr(release, "clean", lambda: revision)
    monkeypatch.setattr(release, "checks", lambda revision: [])
    monkeypatch.setattr(release, "gh", lambda *args: {"commit": {"sha": revision}})
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setattr(
        release,
        "releases",
        lambda: [
            {
                "tag_name": f"android-alpha/{release.declared_version()}-2-{revision[:12]}",
                "draft": False,
                "body": "<!-- android-run:123 -->",
            }
        ],
    )
    with pytest.raises(RuntimeError, match="already published"):
        release.reserve()


def test_receipt_from_a_different_apk_cannot_publish(monkeypatch, tmp_path):
    revision = "a" * 40
    apk = tmp_path / "test.apk"
    apk.write_bytes(b"candidate")
    plan = {"source_revision": revision, "version_code": 2}
    monkeypatch.setattr(release, "clean", lambda: revision)
    monkeypatch.setattr(release, "verify_apk", lambda *args: {})
    with pytest.raises(RuntimeError, match="acceptance is incomplete"):
        release.publish(plan, apk, {"source_revision": revision, "version_code": 2, "apk_sha256": "another artifact"})


def test_main_advancing_during_upload_leaves_release_private(monkeypatch, tmp_path):
    revision = "a" * 40
    apk = tmp_path / "candidate.apk"
    apk.write_bytes(b"candidate")
    (tmp_path / release.SEED_HARNESS).write_bytes(b"matching harness")
    plan = {"source_revision": revision, "version_code": 2, "tag": "fixture"}
    receipt = {"source_revision": revision, "version_code": 2, "apk_sha256": release.digest(apk)}
    for key in ("update_preserves_account_settings_offline", "downgrade_rejected", "wrong_signature_rejected",
                "corrupt_apk_rejected", "release_startup", "offline_pcm", "app_links_verified"):
        receipt[key] = True
    monkeypatch.setattr(release, "OUT", tmp_path)
    monkeypatch.setattr(release, "clean", lambda: revision)
    monkeypatch.setattr(release, "verify_apk", lambda *args: {})
    monkeypatch.setattr(release, "verify_harness", lambda *args: None)
    monkeypatch.setattr(release, "checks", lambda *args: [])
    monkeypatch.setattr(release, "releases", lambda: [{"tag_name": "fixture", "draft": True, "body": "marker"}])
    heads = iter([revision, "b" * 40])
    monkeypatch.setattr(release, "gh", lambda *args: {"commit": {"sha": next(heads)}})
    operations = []
    monkeypatch.setattr(release, "command", lambda *args: operations.append(args))
    with pytest.raises(RuntimeError, match="advanced during upload"):
        release.publish(plan, apk, receipt)
    assert len(operations) == 1 and operations[0][:3] == ("gh", "release", "upload")
