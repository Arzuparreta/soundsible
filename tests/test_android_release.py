"""Public Android identity, evidence and channel allocation cannot silently drift."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import android_release as release


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
    monkeypatch.setattr(release, "verify_apk", lambda apk, metadata: checked.append(apk.read_bytes()))

    def download(*args):
        assert args[:4] == ("gh", "release", "download", tag)
        directory = tmp_path / "published-predecessor"
        apk = directory / "Soundsible-Android-alpha.apk"
        apk.write_bytes(b"actual published binary")
        (directory / "android-release.json").write_text(json.dumps(
            {"tag": tag, "version_code": 2, "sha256": release.digest(apk)}
        ))
    monkeypatch.setattr(release, "command", download)
    apk, evidence = release.upgrade_baseline({"version_code": 4})
    assert checked == [b"actual published binary"]
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


def test_checks_require_full_android_and_shared_regression(monkeypatch):
    rows = [
        {"id": i, "name": name, "conclusion": "success", "html_url": "https://github.com/check"}
        for i, name in enumerate(release.CHECKS)
    ]
    monkeypatch.setattr(release, "gh", lambda *args: rows)
    assert len(release.checks("a" * 40)) == len(release.CHECKS)
    rows.append({"id": 100, "name": "Emulator shard 2/4 (API 36)", "conclusion": "failure"})
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
