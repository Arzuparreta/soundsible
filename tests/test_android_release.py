"""Public Android identity, evidence and channel allocation cannot silently drift."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import android_release as release


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
