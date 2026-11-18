"""The DJ API contract: its generated web types, its validator and its examples."""

import json
from pathlib import Path

import pytest

from scripts import api_contract

EXAMPLES = Path(__file__).resolve().parents[1] / "shared/contracts/api/examples"
DEFINITIONS = {
    "dj-plan.json": "DjPlanResponse",
    "dj-place.json": "DjPlacementResponse",
    "dj-repair.json": "DjRepairResponse",
    "dj-transition.json": "DjTransitionResponse",
}


def test_generated_web_types_match_the_schema():
    assert api_contract.main(["--check"]) == 0, "run python scripts/api_contract.py --write"


@pytest.mark.parametrize("name", sorted(DEFINITIONS))
def test_examples_android_parses_match_the_schema(name):
    api_contract.validate_response(DEFINITIONS[name], json.loads((EXAMPLES / name).read_text()))


def test_every_example_is_checked():
    assert {path.name for path in EXAMPLES.glob("*.json")} == set(DEFINITIONS)


def _plan():
    return json.loads((EXAMPLES / "dj-plan.json").read_text())


@pytest.mark.parametrize("change, message", [
    (lambda body: body.pop("plan_id"), "missing 'plan_id'"),
    (lambda body: body["items"][0].update(renamed=1), "unexpected 'renamed'"),
    (lambda body: body["items"][1]["transition"].update(technique="scratch"), "is not one of"),
    (lambda body: body["items"][1]["transition"]["sync"].update(cycle_beats=[4]), "1 items"),
    (lambda body: body.update(direction_revision="3"), "expected number/null"),
    (lambda body: body["items"][0]["analysis"].update(beat_grid=[0.5, 1.0]), "expected number/string/boolean/null"),
])
def test_the_validator_names_what_breaks(change, message):
    body = _plan()
    change(body)
    with pytest.raises(api_contract.ContractError, match=message):
        api_contract.validate_response("DjPlanResponse", body)


def test_seed_analysis_may_be_partial_but_items_may_not():
    body = _plan()
    body["seed_analysis"] = {"bpm": 120.0}
    api_contract.validate_response("DjPlanResponse", body)
    del body["items"][0]["analysis"]["analysed"]
    with pytest.raises(api_contract.ContractError, match="missing 'analysed'"):
        api_contract.validate_response("DjPlanResponse", body)
