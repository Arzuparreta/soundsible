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
