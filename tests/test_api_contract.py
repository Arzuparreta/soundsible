"""The DJ API contract: its generated web types, its validator and its examples."""

import json
from pathlib import Path

import pytest
from flask import Blueprint, Flask, Response
from flask.testing import EnvironBuilder

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


@pytest.mark.parametrize("remove, message", [
    (lambda body: body.pop("analysis_coverage"), "missing 'analysis_coverage'"),
    (lambda body: body["items"][0].pop("analysis"), "missing 'analysis'"),
    (lambda body: body["items"][0].pop("transition"), "missing 'transition'"),
])
def test_v6_route_retains_its_measurements_and_transition_chain(remove, message):
    body = _plan()
    remove(body)
    with pytest.raises(api_contract.ContractError, match=message):
        api_contract.validate_response("DjPlanResponse", body)


@pytest.mark.parametrize("filename, remove, message", [
    ("dj-place.json", lambda body: body["items"][0].pop("analysis"), "missing 'analysis'"),
    ("dj-place.json", lambda body: body["items"][0].pop("transition"), "missing 'transition'"),
    ("dj-place.json", lambda body: body.update(v=True), "expected 1"),
    ("dj-transition.json", lambda body: body.pop("analysis"), "missing 'analysis'"),
    ("dj-transition.json", lambda body: body["transition"].update(playback_rate=float("nan")), "expected number"),
])
def test_placement_and_refinement_require_valid_measurements(filename, remove, message):
    body = json.loads((EXAMPLES / filename).read_text())
    remove(body)
    with pytest.raises(api_contract.ContractError, match=message):
        api_contract.validate_response(DEFINITIONS[filename], body)


@pytest.mark.parametrize("mimetype, message", [
    ("text/html", "expected a JSON response"),
    ("application/json", "DjPlacementResponse: missing 'v'"),
])
def test_contract_gate_uses_the_matched_request_even_with_an_environ_builder(mimetype, message):
    app = Flask(__name__)
    routes = Blueprint("discovery", __name__)

    @routes.post("/api/discovery/music/dj-place")
    def place():
        return Response('{"placements":[]}', mimetype=mimetype)

    app.register_blueprint(routes)
    builder = EnvironBuilder(app, path="/api/discovery/music/dj-place?source=test", method="POST", json={})
    try:
        with pytest.raises(api_contract.ContractError, match=message):
            app.test_client().open(builder)
    finally:
        builder.close()
