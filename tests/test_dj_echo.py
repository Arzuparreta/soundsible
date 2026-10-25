"""A tempo delay is a measured outgoing beat, not a genre/style constant."""

import json
from pathlib import Path

import pytest

from shared.dj_engine import plan_transition
from test_dj_sections import measured


@pytest.mark.parametrize("bpm", [55, 90, 120, 137, 220])
def test_echo_repeats_one_outgoing_beat_even_when_incoming_tempo_differs(bpm):
    plan = plan_transition(measured(bpm=bpm), measured(bpm=137 if bpm == 90 else 173))
    assert plan["technique"] == "echo_cut"
    assert plan["echo_delay_seconds"] == pytest.approx(60 / bpm, abs=1e-6)
    assert plan["playback_rate"] == 1


def test_echo_uses_the_grid_near_the_exit_instead_of_global_bpm_or_bar_seconds():
    out = measured(bpm=121)
    out.update(bpm=120, bar_seconds=2)
    plan = plan_transition(out, measured(bpm=173))
    assert plan["echo_delay_seconds"] == pytest.approx(60 / 121, abs=1e-6)


@pytest.mark.parametrize("unknown", [
    {"analysed": False}, {"beat_grid": []}, {"bpm": 0},
    {"tempo_confidence": 0}, {"tempo_confidence": .6},
])
def test_no_echo_from_an_unknown_or_unpredictable_outgoing_pulse(unknown):
    out = measured()
    out.update(unknown)
    plan = plan_transition(out, measured(bpm=173))
    assert plan["technique"] == "structural_fade"
    assert "echo_delay_seconds" not in plan


def test_other_techniques_do_not_carry_an_echo():
    assert "echo_delay_seconds" not in plan_transition(measured(), measured())


def test_server_echo_contract_vectors_executed_by_both_renderers():
    path = Path(__file__).resolve().parents[1] / "shared/contracts/dj_echo_plans.json"
    for case in json.loads(path.read_text()):
        out, inc = measured(bpm=case["bpm"]), measured(bpm=case["incoming_bpm"])
        assert plan_transition(out, inc) == case["transition"]
        assert (out, inc) == (measured(bpm=case["bpm"]), measured(bpm=case["incoming_bpm"]))
