"""The AltStore source is the only install path the iOS app has.

A malformed one does not fail loudly — the client simply shows nothing, or
offers a version it cannot download. These check the fields an AltStore-
compatible client actually reads.
"""

from __future__ import annotations

import json

from scripts.altstore_source import BUNDLE_ID, build_source


def _source(version: str = "0.2.0", ipa_bytes: int = 12_345_678) -> dict:
    return build_source(version=version, ipa_bytes=ipa_bytes, released_on="2026-08-06")


def test_source_carries_every_required_top_level_field():
    source = _source()

    # `name` and `apps` are what a client needs to render anything at all;
    # `news` is required by the schema even when it is empty.
    for field in ("name", "apps", "news"):
        assert field in source, f"AltStore sources must declare {field}"


def test_app_carries_every_required_field():
    app = _source()["apps"][0]

    for field in (
        "name",
        "bundleIdentifier",
        "developerName",
        "localizedDescription",
        "iconURL",
        "versions",
        "appPermissions",
    ):
        assert field in app, f"AltStore apps must declare {field}"


def test_bundle_identifier_matches_the_one_the_project_builds():
    assert _source()["apps"][0]["bundleIdentifier"] == BUNDLE_ID

    project = (
        __import__("pathlib").Path(__file__).resolve().parent.parent
        / "ios"
        / "project.yml"
    ).read_text(encoding="utf-8")
    assert f"PRODUCT_BUNDLE_IDENTIFIER: {BUNDLE_ID}" in project, (
        "A source pointing at a bundle id the app does not build installs "
        "nothing, and says nothing about why."
    )


def test_version_entry_points_at_the_tag_that_carries_the_ipa():
    entry = _source(version="1.2.3")["apps"][0]["versions"][0]

    assert entry["version"] == "1.2.3"
    assert entry["downloadURL"].endswith("/releases/download/v1.2.3/Soundsible.ipa")
    assert entry["date"] == "2026-08-06"


def test_size_is_the_real_ipa_size():
    # AltStore shows this before downloading and uses it for progress. A wrong
    # number is a progress bar that finishes early or never.
    assert _source(ipa_bytes=98_765)["apps"][0]["versions"][0]["size"] == 98_765


def test_minimum_os_matches_the_deployment_target():
    entry = _source()["apps"][0]["versions"][0]
    assert entry["minOSVersion"] == "17.0"

    project = (
        __import__("pathlib").Path(__file__).resolve().parent.parent
        / "ios"
        / "project.yml"
    ).read_text(encoding="utf-8")
    assert 'iOS: "17.0"' in project


def test_permissions_explain_the_camera_and_the_local_network():
    privacy = _source()["apps"][0]["appPermissions"]["privacy"]
    names = {entry["name"] for entry in privacy}

    # These are the only two the app asks for, and both are surfaced before
    # install rather than at first use.
    assert names == {"Camera", "LocalNetwork"}
    assert all(entry["usageDescription"] for entry in privacy)


def test_source_is_json_serialisable():
    # It is written with json.dumps; anything unserialisable fails at release
    # time, which is the worst moment to find out.
    assert json.loads(json.dumps(_source()))["apps"][0]["name"] == "Soundsible"
