"""The release machinery, tested where it can go wrong silently.

The failure this guards against is not a crash. It is a build that succeeds
and ships the wrong number: an installer that says ``1.0.0-rc.1`` because a
manifest was never updated, or a patch release that quietly contained a
breaking change because nobody labelled the pull request.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = REPO_ROOT / "scripts"


def _load(name: str):
    """Import a script from scripts/, which is not an importable package."""
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


version_sync = _load("version_sync")
release = _load("release")


def test_every_manifest_agrees_with_the_declaration():
    """The check CI runs, run locally too, so drift never reaches a push."""
    declared = version_sync.declared_version()
    stale = version_sync.sync(declared, check=True)
    assert not stale, (
        f"shared/version.py declares {declared}, but:\n  "
        + "\n  ".join(stale)
        + "\n\nRun `python scripts/version_sync.py`."
    )


def test_the_declared_version_is_one_all_three_ecosystems_accept():
    """Cargo, npm and Tauri each refuse to build on a version they cannot parse."""
    assert version_sync.validate(version_sync.declared_version())


@pytest.mark.parametrize(
    "version",
    ["1.0", "v1.0.0", "1.0.0+build", "01.0.0", "0.1.0-rc.1.2.3.x y", ""],
)
def test_versions_the_desktop_build_would_choke_on_are_refused(version):
    with pytest.raises(SystemExit):
        version_sync.validate(version)


@pytest.mark.parametrize("version", ["0.1.0-rc", "0.1.0-beta.2", "1.0.0-alpha"])
def test_prereleases_outside_the_rc_convention_are_valid_but_not_releasable(version):
    """Semver accepts them and so do Cargo and npm — the release flow does not.

    Keeping one prerelease word means the channel is legible in the number.
    `validate` is about what will build; `next_version` is about what this
    project ships.
    """
    assert version_sync.validate(version)
    with pytest.raises(SystemExit, match="Cannot reason about"):
        release.next_version(version, "patch", rc=False)


def test_every_manifest_target_exists():
    """A moved or renamed manifest must fail here, not at release time."""
    for target in version_sync.TARGETS:
        assert target.path.exists(), target.path


@pytest.mark.parametrize(
    ("current", "impact", "expected"),
    [
        # Below 1.0 there is no major to spend, so breaking changes move the
        # minor — which is exactly what 0.x already promises.
        ("0.1.0", "patch", "0.1.1"),
        ("0.1.0", "minor", "0.2.0"),
        ("0.1.0", "major", "0.2.0"),
        ("0.1.4", "minor", "0.2.0"),
        # From 1.0 on, the numbers mean what they say.
        ("1.4.2", "patch", "1.4.3"),
        ("1.4.2", "minor", "1.5.0"),
        ("1.4.2", "major", "2.0.0"),
    ],
)
def test_the_impact_label_decides_the_number(current, impact, expected):
    assert release.next_version(current, impact, rc=False) == expected


def test_a_release_candidate_stabilises_into_its_own_number():
    """An rc is a promise about a specific release, not a separate line."""
    assert release.next_version("0.1.0", "minor", rc=True) == "0.2.0-rc.1"
    assert release.next_version("0.2.0-rc.1", "patch", rc=True) == "0.2.0-rc.2"
    # Going final keeps the number the candidates were testing.
    assert release.next_version("0.2.0-rc.2", "patch", rc=False) == "0.2.0"


def test_nothing_user_visible_is_not_a_release():
    with pytest.raises(SystemExit):
        release.next_version("0.1.0", "none", rc=False)


def test_impacts_are_ordered_by_how_far_they_move_the_number():
    """`resolve` takes the highest label merged; the order is the whole point."""
    assert release.IMPACTS == ("none", "patch", "minor", "major")
    highest = max(["patch", "major", "none"], key=release.IMPACTS.index)
    assert highest == "major"


def test_an_unlabelled_pull_request_is_never_silently_ignored():
    """It counts as something, and the bump PR body has to name it."""
    assert release.UNLABELLED in release.IMPACTS
    assert release.UNLABELLED != "none"

    pulls = [release.MergedPR(7, "Untitled", release.UNLABELLED, labelled=False)]
    summary = release.summarise(pulls, tag="v0.1.0")
    assert "#7" in summary
    assert "No impact label" in summary
