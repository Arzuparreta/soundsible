"""Golden match statistics for versioned migration fixtures (see fixtures/migration/README.md)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from shared.migration.match import match_sources_to_library, migration_stats
from shared.migration.models import SourceTrack
from shared.migration.parsers import parse_export
from shared.models import Track

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "migration"
MANIFEST = FIXTURES / "manifest.json"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_library(path: Path) -> list[Track]:
    data = _load_json(path)
    tracks = data.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError(f"{path} must contain a 'tracks' array")
    return [Track.from_dict(t) for t in tracks]


def _scenario_sources(sc: dict, base: Path) -> list[SourceTrack]:
    if "export" in sc:
        exp = sc["export"]
        text = (base / exp["file"]).read_text(encoding="utf-8")
        return parse_export(exp["format"], text)
    if "sources" in sc:
        spec = sc["sources"]
        raw = _load_json(base / spec["file"])
        key = spec.get("key", "sources")
        rows = raw[key]
        return [
            SourceTrack(title=r["title"], artist=r.get("artist", ""), album=r.get("album", ""))
            for r in rows
        ]
    raise ValueError(f"scenario {sc.get('id')}: need export or sources")


def test_manifest_version_matches_match_module():
    """Fail fast if weights/thresholds drift without updating the manifest."""
    from shared.migration import match as match_mod

    manifest = _load_json(MANIFEST)
    me = manifest.get("match_engine", {})
    assert me.get("AUTO_ACCEPT_THRESHOLD") == match_mod.AUTO_ACCEPT_THRESHOLD
    assert me.get("CONFIRM_THRESHOLD") == match_mod.CONFIRM_THRESHOLD


@pytest.mark.parametrize(
    "scenario_id",
    [s["id"] for s in _load_json(MANIFEST)["scenarios"]],
)
def test_reference_fixture_scenario_stats(scenario_id: str):
    manifest = _load_json(MANIFEST)
    scenario = next(s for s in manifest["scenarios"] if s["id"] == scenario_id)
    base = FIXTURES

    sources = _scenario_sources(scenario, base)
    lib_path = base / scenario["library"]["file"]
    library = _load_library(lib_path)

    stats = migration_stats(match_sources_to_library(sources, library))
    expected = scenario["expected_stats"]
    assert stats == expected, f"{scenario_id}: got {stats}, want {expected}"
