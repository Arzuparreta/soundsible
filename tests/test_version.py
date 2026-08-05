import re
from pathlib import Path

import pytest

from shared.version import VERSION, resolve_version, source_revision

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PACKAGES = ("shared", "player", "odst_tool", "setup_tool", "launcher_web")


def test_declared_version_is_semver():
    assert re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-+]+)?", VERSION), VERSION


def test_resolve_version_falls_back_to_the_declared_version(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_VERSION", raising=False)
    assert resolve_version() == VERSION


@pytest.mark.parametrize("blank", ["", "   "])
def test_a_blank_override_is_not_a_version(monkeypatch, blank):
    """The Docker image sets the variable unconditionally, empty or not."""
    monkeypatch.setenv("SOUNDSIBLE_VERSION", blank)
    assert resolve_version() == VERSION


def test_an_override_wins(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_VERSION", "1.2.3")
    assert resolve_version() == "1.2.3"


def test_source_revision_is_absent_rather_than_guessed(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_SOURCE_REVISION", raising=False)
    assert source_revision() is None

    monkeypatch.setenv("SOUNDSIBLE_SOURCE_REVISION", "abc1234")
    assert source_revision() == "abc1234"


def test_no_module_invents_its_own_version_fallback():
    """The regression this file exists for.

    Four call sites each defaulted to ``0.0.0-dev`` independently, so the
    version a user saw depended on which surface they read it from. Anything
    that needs the version calls ``resolve_version()``.
    """
    offenders = []
    for package in SOURCE_PACKAGES:
        for module in (REPO_ROOT / package).rglob("*.py"):
            if module.name == "version.py":
                continue
            for number, line in enumerate(module.read_text(encoding="utf-8").splitlines(), 1):
                if "SOUNDSIBLE_VERSION" in line and "getenv" in line:
                    relative = module.relative_to(REPO_ROOT)
                    offenders.append(f"{relative}:{number}: {line.strip()}")

    assert not offenders, "read the version through shared.version.resolve_version():\n" + "\n".join(offenders)
