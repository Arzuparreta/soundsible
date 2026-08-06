"""The preflight is a checklist somebody follows once, months from now.

Its value is entirely in being right about what is missing and what comes next,
so that is what these check.
"""

from __future__ import annotations

from scripts.altstore_pal_preflight import (
    MANUAL_STEPS,
    REQUIRED_SECRETS,
    REQUIRED_VARIABLES,
    build_report,
)


def test_nothing_configured_means_nothing_is_done():
    report = build_report(secret_names=set(), variable_names=set(), confirmed=set())

    assert not report.ready
    assert len(report.remaining) == len(MANUAL_STEPS) + len(REQUIRED_SECRETS) + len(
        REQUIRED_VARIABLES
    )


def test_the_first_thing_it_asks_for_is_the_membership():
    # Everything else is downstream of paying, so any other order would send
    # somebody off to generate certificates they cannot generate yet.
    report = build_report(secret_names=set(), variable_names=set(), confirmed=set())

    assert report.remaining[0].key == "membership"


def test_confirmed_manual_steps_stop_being_asked_for():
    report = build_report(
        secret_names=set(), variable_names=set(), confirmed={"membership", "eu-terms"}
    )

    remaining = {check.key for check in report.remaining}
    assert "membership" not in remaining
    assert "eu-terms" not in remaining
    assert "pal-registered" in remaining


def test_everything_present_reports_ready():
    report = build_report(
        secret_names=set(REQUIRED_SECRETS),
        variable_names=set(REQUIRED_VARIABLES),
        confirmed=set(MANUAL_STEPS),
    )

    assert report.ready
    assert report.remaining == []


def test_unreadable_configuration_is_not_reported_as_done():
    # `gh` missing or signed out yields None. Treating that as "present" would
    # send somebody to run a workflow that then fails on a missing secret.
    report = build_report(
        secret_names=None, variable_names=None, confirmed=set(MANUAL_STEPS)
    )

    assert not report.ready
    assert all("gh" in check.hint for check in report.remaining)


def test_every_required_credential_explains_itself():
    # This list is read once, long after it was written, by somebody who has
    # just paid 99 EUR and wants to know what to paste where.
    for description in {**REQUIRED_SECRETS, **REQUIRED_VARIABLES}.values():
        assert len(description) > 20, description


def test_every_unverified_file_says_so_where_it_will_be_read():
    """The AltStore PAL path must keep announcing that it has never run.

    This is not documentation hygiene. Those files sit beside code CI exercises
    on every push, and nothing about how they look tells them apart — so a
    reader, human or agent, can reasonably conclude the path works and build on
    it. It does not work; nobody has ever been able to try it. If a rewrite
    drops the warning, this fails and says why.

    Delete this test only when somebody has actually shipped through AltStore
    PAL, and delete the warnings in the same commit.
    """
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    # Each file, and a phrase that only survives if the warning survives.
    unverified = {
        ".github/workflows/ios-altstore-pal.yml": "HAS NEVER RUN",
        "ios/exportOptions/app-store-connect.plist": "NOT VERIFIED",
        "scripts/altstore_pal_preflight.py": "What it is a checklist\nfor is not",
        "scripts/altstore_source.py": "has never produced a",
        "docs/IOS.md": "Never executed. Not once.",
        "AGENTS.md": "has never been executed",
    }

    for relative, phrase in unverified.items():
        text = (root / relative).read_text(encoding="utf-8")
        assert phrase in text, (
            f"{relative} no longer warns that the AltStore PAL path is "
            f"unverified. Expected to find {phrase!r}."
        )


def test_the_sources_and_the_date_stay_with_the_guesses():
    """A claim copied from a vendor page is only checkable if it says where and when.

    Apple and AltStore both rewrite these pages. Without the date and the links,
    the next person cannot tell a still-true statement from a stale one.
    """
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    workflow = (root / ".github/workflows/ios-altstore-pal.yml").read_text(encoding="utf-8")
    docs = (root / "docs/IOS.md").read_text(encoding="utf-8")

    assert "2026-08-06" in workflow and "2026-08-06" in docs
    for url in (
        "faq.altstore.io/developers/distribute-with-altstore-pal",
        "developer.apple.com/help/app-store-connect/managing-alternative-distribution",
    ):
        assert url in workflow, f"{url} is no longer cited in the workflow"
        assert url in docs, f"{url} is no longer cited in docs/IOS.md"
