"""Both decks share a tempo change, for clients that say they can play it."""

import copy
import math
import subprocess
from unittest.mock import patch

import pytest

from shared.dj import timing
from shared.dj.timing import (MAX_STRETCH, RATE_RAMP_END_LEAD, RATE_RAMP_SECONDS, RATE_STEP,
                              deck_rates, rate_fits, split_rates)
from shared.dj_engine import plan_transition
from test_dj_sections import measured


def split_plan(out, inc):
    with split_rates(True):
        return plan_transition(out, inc)


@pytest.mark.parametrize('relation', [.857143, .9, .96, 1.0, 1.04, 1.1, 1.166667])
def test_shared_speeds_hold_the_relation_and_change_each_deck_by_the_same_amount(relation):
    with split_rates(True):
        out, inc = deck_rates(relation)
    assert inc / out == pytest.approx(relation, rel=1e-12)
    assert abs(1 - out) == pytest.approx(abs(1 - inc), abs=1e-12)
    # No other pair of speeds holding the relation changes either deck less.
    for other in (out * (1 + step) for step in (-.01, -.001, .001, .01)):
        assert max(abs(1 - other), abs(1 - relation * other)) > abs(1 - out)


def test_the_example_pair_meets_at_129_bpm_and_neither_deck_leaves_the_range():
    with split_rates(True):
        out, inc = deck_rates(120 / 140)
    assert 120 * out == pytest.approx(140 * inc)
    assert 120 * out == pytest.approx(129.23, abs=.01)
    assert abs(1 - out) == pytest.approx(1 / 13)


def test_split_range_keeps_one_speed_step_for_phase_riding():
    limit = MAX_STRETCH - RATE_STEP
    edge = (1 - limit) / (1 + limit)
    with split_rates(True):
        assert deck_rates(edge * 1.0001) is not None
        assert deck_rates(edge * .9999) is None
        assert deck_rates((1 + limit) / (1 - limit) * 1.0001) is None
    # Old clients: only the incoming deck moves, within the whole 8 %.
    assert deck_rates(.92) == (1.0, .92)
    assert deck_rates(.919) is None


def test_old_clients_receive_exactly_the_plans_they_were_built_for():
    for bpm in (120, 124, 126, 129, 132, 140):
        legacy = plan_transition(measured(), measured(bpm=bpm))
        assert 'out_playback_rate' not in legacy and 'out_rate_ramp' not in legacy
        assert abs(1 - legacy['playback_rate']) <= MAX_STRETCH + 1e-9
    assert plan_transition(measured(), measured(bpm=132))['technique'] == 'echo_cut'


@pytest.mark.parametrize('bpm', [126, 128, 132, 136])
def test_a_pair_beyond_one_deck_beatmatches_with_both_decks(bpm):
    out, inc = measured(), measured(bpm=bpm)
    original = copy.deepcopy((out, inc))
    plan = split_plan(out, inc)
    assert (out, inc) == original
    assert plan['technique'] in timing.BEATMATCH_TECHNIQUES and plan['sync']['alignment'] == 'bars'
    assert plan['sync']['cycle_beats'] == [1, 1]
    # The relation the phase is held on is unchanged by the outgoing speed.
    assert plan['playback_rate'] == pytest.approx(120 / bpm, abs=1e-6)
    out_rate = plan['out_playback_rate']
    in_rate = out_rate * plan['playback_rate']
    assert 120 * out_rate == pytest.approx(bpm * in_rate, rel=1e-6)
    assert abs(1 - out_rate) == pytest.approx(abs(1 - in_rate), abs=2e-6)
    assert plan['out_rate_ramp'] == {'lead_seconds': RATE_RAMP_SECONDS + RATE_RAMP_END_LEAD,
                                     'seconds': RATE_RAMP_SECONDS}
    assert plan['out_cue'] >= plan['out_rate_ramp']['lead_seconds']
    with split_rates(True):
        assert rate_fits(plan) and timing.beatmatch_fits(plan, out, inc)
    # The same plan is never executable by a player moving one deck alone.
    if abs(1 - plan['playback_rate']) > MAX_STRETCH:
        assert not rate_fits({k: v for k, v in plan.items() if k not in {'out_playback_rate', 'out_rate_ramp'}})


def test_identical_tempi_never_move_the_outgoing_deck():
    plan = split_plan(measured(), measured())
    assert plan['playback_rate'] == 1 and plan['out_playback_rate'] == 1
    assert 'out_rate_ramp' not in plan


def test_tempo_score_measures_the_change_each_deck_actually_makes():
    legacy = plan_transition(measured(), measured(bpm=126))
    split = split_plan(measured(), measured(bpm=126))
    assert legacy['technique'] == 'filter_blend' and split['technique'] == 'bass_swap'
    assert split['score'] > legacy['score']


def test_without_room_for_the_ramp_only_the_incoming_deck_moves():
    def early(bpm):
        out = {**measured(duration=22), 'outro_cue': 14.25}
        return split_plan(out, measured(bpm=bpm))
    near = early(124)
    assert near['out_cue'] < RATE_RAMP_SECONDS + RATE_RAMP_END_LEAD
    assert near['out_playback_rate'] == 1 and 'out_rate_ramp' not in near
    assert near['playback_rate'] == pytest.approx(120 / 124, abs=1e-6)
    far = early(132)
    assert far['technique'] not in timing.BEATMATCH_TECHNIQUES and far['playback_rate'] == 1


@pytest.mark.parametrize('change', [
    {'out_playback_rate': 1.09},
    {'out_playback_rate': 1.05, 'playback_rate': .85},
    {'out_rate_ramp': None},
    {'out_rate_ramp': {'lead_seconds': 15, 'seconds': 15}},
    {'out_rate_ramp': {'lead_seconds': math.inf, 'seconds': 8}},
    {'out_cue': 10},
])
def test_admission_rejects_deck_speeds_or_ramps_the_players_cannot_execute(change):
    plan = split_plan(measured(), measured(bpm=132))
    with split_rates(True):
        assert rate_fits(plan)
        assert not rate_fits({**plan, **change})


def test_measured_aac_pair_is_split_only_for_clients_that_ask(tmp_path):
    """Synthetic AAC at 120 and 132 BPM -> real analysis -> HTTP refinement."""
    from shared import dj_engine
    from shared.ffmpeg_runtime import ffmpeg_executable
    from test_dj_beat_grid import song
    from test_discovery_save_route import _FakeLibrary, _auto_mode, _make_app, _make_runtime, _mock_api

    _make_runtime(tmp_path)
    refs, paths = {}, {}
    for key, bpm in (('outgoing', 120), ('incoming', 132)):
        wav, aac = tmp_path / f'{key}.wav', tmp_path / f'{key}.m4a'
        song(wav, bpm, seconds=120, first=.25)
        subprocess.run([ffmpeg_executable(), '-v', 'error', '-i', str(wav), '-c:a', 'aac', str(aac)], check=True)
        refs[key] = {'id': key, 'track_id': key, 'title': key, 'artist': 'Synthetic', 'duration': 120}
        paths[key] = aac
        dj_engine.analyse_audio(aac, dj_engine.analysis_identity(refs[key]))
    api = _mock_api()
    api['get_core'].return_value = (_FakeLibrary(None), None, None)
    pair = {'from': refs['outgoing'], 'to': refs['incoming']}
    with (patch.object(_auto_mode, '_get_api', return_value=api),
          patch.object(_auto_mode, '_dj_source_path', side_effect=lambda _, item: paths[item['id']])):
        client = _make_app().test_client()
        legacy = client.post('/api/discovery/music/dj-transition', json=pair).get_json()
        split = client.post('/api/discovery/music/dj-transition', json=pair,
                            headers={'X-Soundsible-Dj-Rates': 'split'}).get_json()
    assert legacy['measured'] and split['measured']
    assert legacy['transition']['technique'] not in timing.BEATMATCH_TECHNIQUES
    assert 'out_playback_rate' not in legacy['transition']
    plan = split['transition']
    assert plan['technique'] in timing.BEATMATCH_TECHNIQUES
    out_rate = plan['out_playback_rate']
    # Within a tenth of a BPM of the tempo where 120 and 132 meet with equal changes.
    assert 120 * out_rate == pytest.approx(2 * 120 * 132 / (120 + 132), abs=.1)
    assert abs(1 - out_rate) == pytest.approx(abs(1 - out_rate * plan['playback_rate']), abs=1e-5)
    # The planning context never leaks into the next request of an old client.
    assert not timing.split_enabled()


@pytest.mark.parametrize('out_bpm,in_bpm', [(120, 140), (140, 120)])
def test_one_beat_against_one_comes_first_whenever_both_decks_can_hold_it(out_bpm, in_bpm):
    # 3:4 would change each deck 6.67 % instead of 7.69 %, but keep only one
    # beat in three together (decision of the user, 2026-11-05).
    plan = split_plan(measured(bpm=out_bpm), measured(bpm=in_bpm))
    assert plan['technique'] in timing.BEATMATCH_TECHNIQUES
    assert plan['sync']['cycle_beats'] == [1, 1]
    assert out_bpm * plan['out_playback_rate'] == pytest.approx(2 * 120 * 140 / 260, abs=.01)


def test_a_wider_cycle_is_kept_where_one_against_one_does_not_fit():
    # 120 ↔ 141 in 1:1 would need 8.05 % per deck.
    plan = split_plan(measured(), measured(bpm=141))
    assert plan['sync']['cycle_beats'] == [3, 4]
    assert abs(1 - plan['out_playback_rate']) <= MAX_STRETCH - RATE_STEP
