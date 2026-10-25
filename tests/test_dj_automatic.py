"""Automatic choices use the executable clock and measured structural runway."""

import copy

import pytest

from shared.dj_engine import _fallback, plan_transition
from test_dj_sections import measured, section


def long_pair():
    out, inc = measured(), measured(bpm=125)
    out['sections'] = [section(176.25, 192.25, 'breakdown'), section(192.25, 208.25, 'breakdown'),
                       section(208.25, 224.25, 'breakdown'), section(224.25, 240, 'outro')]
    inc['sections'] = [section(.25, 16.25, 'intro'), section(16.25, 32.25, 'breakdown'),
                       section(32.25, 48.25, 'breakdown'), section(48.25, 64.25, 'breakdown')]
    return out, inc


@pytest.mark.parametrize('incoming,technique', [
    (measured(), 'bass_swap'), (measured(bpm=126), 'filter_blend'),
    (measured(bpm=130), 'echo_cut'),
    ({**measured(), 'tempo_confidence': .6}, 'structural_fade'),
    (_fallback(240), 'safe_fade'),
])
def test_pair_selects_the_executable_technique_without_a_style(incoming, technique):
    out = measured()
    original = copy.deepcopy((out, incoming))
    plan = plan_transition(out, incoming)
    assert plan['technique'] == technique
    assert 'automation' not in plan
    assert ('echo_delay_seconds' in plan) == (technique == 'echo_cut')
    assert (out, incoming) == original


def test_contiguous_quiet_regions_enable_long_blend_on_the_real_local_rate():
    out, inc = long_pair()
    original = copy.deepcopy((out, inc))
    plan = plan_transition(out, inc)
    assert plan['technique'] == 'long_blend'
    assert plan['overlap_seconds'] == 48
    assert plan['playback_rate'] == .96
    assert plan['out_cue'] == 176.25
    assert plan['in_cue'] == .25
    assert plan['out_cue'] + plan['overlap_seconds'] < out['duration'] - 1
    assert (out, inc) == original


@pytest.mark.parametrize('change', ['missing', 'short-intro', 'gap', 'body', 'drop', 'unmeasured-middle',
                                   'wandering-grid', 'unknown-key', 'distant-key', 'short-track'])
def test_long_blend_needs_measured_compatible_runway_on_both_sides(change):
    out, inc = long_pair()
    if change == 'missing':
        out['sections'] = []
    elif change == 'short-intro':
        inc['sections'] = inc['sections'][:1]
    elif change == 'gap':
        inc['sections'][1]['start'] += 1
    elif change in {'body', 'drop'}:
        inc['sections'][1]['label'] = change
    elif change == 'unmeasured-middle':
        out['beat_grid'] = [t for t in out['beat_grid'] if not 190 < t < 210]
    elif change == 'wandering-grid':
        out['beat_grid'] = [t + (.01 if 200 < t < 210 else 0) for t in out['beat_grid']]
    elif change == 'unknown-key':
        inc['key'] = None
    elif change == 'distant-key':
        inc['key'] = 'F#'
    else:
        out.update(measured(duration=90))
    plan = plan_transition(out, inc)
    assert plan['technique'] != 'long_blend'


def test_local_grid_overrules_a_matching_global_bpm_for_technique_choice():
    out, inc = measured(), measured(bpm=130)
    inc['bpm'] = 120
    plan = plan_transition(out, inc)
    assert plan['technique'] == 'echo_cut'
    assert plan['playback_rate'] == 1
    assert plan['overlap_bars'] == 8


def test_half_time_pair_still_blends_automatically():
    plan = plan_transition(measured(bpm=90), measured(bpm=173))
    assert plan['technique'] == 'bass_swap'
    assert plan['playback_rate'] == pytest.approx(180 / 173, abs=1e-6)
