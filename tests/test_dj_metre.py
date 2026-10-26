"""Known metric signals: measure pulse, grouping, subdivision and first separately."""
import numpy as np
import pytest

from shared.dj.analysis import _compose

RATE = 11025


def metric_signal(*, beats_per_bar=4, subdivision=2, period=.5, seconds=72., first=.25,
                  pickup=0, weak_first=False, syncopated=False, change=None, drift=0.):
    rng = np.random.default_rng(1804)
    samples = np.zeros(round(seconds * RATE), dtype=np.float32)
    beats, bars = [], []

    def add(at, sound, gain):
        start = round(at * RATE)
        end = min(len(samples), start + len(sound))
        if start >= 0 and end > start:
            samples[start:end] += gain * sound[:end-start]

    t = np.arange(round(.15 * RATE)) / RATE
    kick = np.sin(2 * np.pi * (65 * t + 3 * (1 - np.exp(-t / .02)))) * np.exp(-t / .04)
    kick[:22] += rng.normal(0, .3, 22)
    hat_t = np.arange(round(.035 * RATE)) / RATE
    hat = rng.normal(0, 1, len(hat_t)) * np.exp(-hat_t / .006)
    at, index, bar = first, 0, 0
    while at < seconds - .4:
        size = beats_per_bar if change is None or at < change[0] else change[1]
        position = (index - pickup) % size
        local_period = period * (1 + drift * np.sin(at / 6))
        beats.append(at)
        add(at, kick, .7 if position == 0 and weak_first else 1. if position == 0 else .7)
        if subdivision:
            for fraction in range(1, subdivision):
                add(at + local_period * fraction / subdivision, hat, .15)
        if syncopated:
            add(at + local_period / 2, hat, .4)
        if position == 0:
            bars.append(at)
            chord = ((0, 4, 7), (5, 9, 0), (7, 11, 2), (9, 0, 4))[bar % 4]
            chord_t = np.arange(round(local_period * size * RATE)) / RATE
            sound = sum(np.sin(2*np.pi*220*2**(pitch/12)*chord_t) for pitch in chord)
            sound *= np.minimum(chord_t / .015, 1) * np.minimum((chord_t[-1] - chord_t) / .015, 1)
            add(at, sound, .08)
            bar += 1
        at += local_period
        index += 1
    samples += rng.normal(0, .0001, len(samples))
    return samples, np.array(beats), np.array(bars)


def analyse_signal(**kwargs):
    samples, beats, bars = metric_signal(**kwargs)
    return _compose(samples, samples, RATE, duration=len(samples)/RATE, tail_start=0), beats, bars


@pytest.mark.parametrize('size,subdivision', [(3, 2), (4, 2), (2, 3)])
@pytest.mark.parametrize('first,pickup,weak', [(.25, 0, False), (.83, 1, True)])
def test_known_metre_is_not_four_by_default(size, subdivision, first, pickup, weak):
    analysis, beats, bars = analyse_signal(beats_per_bar=size, subdivision=subdivision,
                                         first=first, pickup=pickup, weak_first=weak)
    assert analysis['bpm'] == pytest.approx(120, abs=.03)
    grid = np.array(analysis['beat_grid'])
    assert max(min(abs(grid - t)) for t in beats[2:-2]) < .003
    regions = analysis['metric_regions']
    known = [row for row in regions if row['beats_per_bar'] is not None]
    assert known
    assert all(row['beats_per_bar'] == size for row in known), regions
    assert all(row['subdivision'] == subdivision for row in known), regions
    detected = np.array(analysis['downbeats'])
    assert len(detected)
    assert np.mean([min(abs(bars - t)) < .01 for t in detected[1:-1]]) > .95
    assert sum(row['end']-row['start'] for row in known) / analysis['duration'] > .8


@pytest.mark.parametrize('period', [.375, .75])
@pytest.mark.parametrize('size,subdivision', [(3, 2), (4, 2), (2, 3)])
def test_pulse_octave_and_ternary_subdivision_are_evaluated_together(period, size, subdivision):
    analysis, _, _ = analyse_signal(beats_per_bar=size, subdivision=subdivision, period=period)
    assert analysis['bpm'] == pytest.approx(60 / period, abs=.03)
    known = [row for row in analysis['metric_regions'] if row['beats_per_bar'] is not None]
    assert known
    assert all(row['beats_per_bar'] == size for row in known)
    assert all(row['subdivision'] == subdivision for row in known)


def test_uniform_pulses_do_not_invent_a_bar_or_a_subdivision():
    samples = np.zeros(72 * RATE, dtype=np.float32)
    times = np.arange(round(.1 * RATE)) / RATE
    hit = np.sin(2 * np.pi * 80 * times) * np.exp(-times / .025)
    for at in np.arange(.25, 71, .5):
        start = round(at * RATE)
        samples[start:start + len(hit)] += hit
    analysis = _compose(samples, samples, RATE, duration=72, tail_start=0)
    assert analysis['tempo_confidence'] > .9
    assert analysis['bar_seconds'] is None
    assert analysis['beats_per_bar'] is None
    assert analysis['metre_confidence'] == 0
    assert analysis['downbeat_confidence'] == 0
    assert analysis['downbeats'] == []
    assert all(row['subdivision'] is None for row in analysis['metric_regions'])


def test_changes_are_local_and_not_interpolated_across_long_track_windows():
    analysis, _, _ = analyse_signal(change=(36.25, 3))
    regions = analysis['metric_regions']
    assert [row['beats_per_bar'] for row in regions] == [4, 3]
    assert regions[0]['end'] == regions[1]['start'] == pytest.approx(36.25, abs=.01)
    assert analysis['bar_seconds'] is None
    # Independent head/tail windows cannot manufacture bars in the middle.
    samples, _, _ = metric_signal(seconds=72)
    long = _compose(samples, samples.copy(), RATE, duration=600, tail_start=528)
    assert all(row['end'] <= 72 or row['start'] >= 528 for row in long['metric_regions'])
    assert not any(72 < t < 528 for t in long['downbeats'])
    assert not any(s['start'] < 72 and s['end'] > 72 for s in long['sections'])


@pytest.mark.parametrize('options', [{'syncopated': True}, {'drift': .015}, {'subdivision': None}])
def test_syncopation_drift_and_missing_subdivisions_preserve_separate_confidences(options):
    analysis, _, bars = analyse_signal(**options)
    known = [row for row in analysis['metric_regions'] if row['beats_per_bar']]
    assert known and all(row['beats_per_bar'] == 4 for row in known)
    assert all(min(abs(bars - t)) < .015 for t in analysis['downbeats'])
    if options.get('drift'):
        assert analysis['tempo_confidence'] <= .6
    if 'subdivision' in options:
        assert all(row['subdivision'] is None for row in known)


def metric_analysis(*, size=4, period=.5, subdivision=2, duration=240, offset=.25, coverage_start=0.):
    """Exact measured contract; independent of the detector's success on music."""
    from test_dj_sections import measured
    analysis = measured(bpm=60 / period, duration=duration, offset=offset)
    bars = analysis['beat_grid'][::size]
    analysis.update(downbeats=bars, phrase_boundaries=bars[::8], bar_seconds=period * size,
                    outro_cue=bars[-min(len(bars), 17)])
    analysis['metric_regions'] = [{
        'start': coverage_start, 'end': duration, 'period': period, 'pulse_unit': 'dotted_quarter' if subdivision == 3 else 'quarter',
        'beats_per_bar': size, 'subdivision': subdivision, 'bar_seconds': period * size,
        'pulse_confidence': 1., 'metre_confidence': 1., 'downbeat_confidence': 1.,
        'subdivision_confidence': 1., 'downbeats': bars,
    }]
    return analysis


@pytest.mark.parametrize('left,right,aligned', [
    (metric_analysis(size=3), metric_analysis(), False),
    (metric_analysis(size=3), metric_analysis(size=3, period=.48), True),
    (metric_analysis(size=4), metric_analysis(size=2, period=1.), True),
    (metric_analysis(size=2, subdivision=3), metric_analysis(size=2, subdivision=3), True),
])
def test_pair_promises_only_executable_whole_bar_alignment(left, right, aligned):
    from shared.dj_engine import plan_transition
    from shared.dj.timing import BEATMATCH_TECHNIQUES, rate_fits
    plan = plan_transition(left, right)
    assert (plan['technique'] in BEATMATCH_TECHNIQUES) == aligned
    assert (plan['sync']['alignment'] == 'bars') == aligned
    assert rate_fits(plan) == aligned
    assert plan['overlap_bars'] == pytest.approx(plan['overlap_seconds'] / (left['bar_seconds']), abs=.001)
    if aligned:
        assert plan['sync']['in_bar_seconds'] / plan['playback_rate'] == pytest.approx(plan['sync']['out_bar_seconds'], abs=.000005)
    else:
        assert plan['score'] == 0
        assert plan['echo_delay_seconds'] == .5  # Pulse, never the 1.5 s bar.
        assert plan['playback_rate'] == 1


@pytest.mark.parametrize('side', [0, 1])
@pytest.mark.parametrize('change', ['unknown', 'end', 'drift', 'gap', 'local-period'])
def test_full_overlap_must_have_consistent_evidence(side, change):
    from shared.dj_engine import plan_transition
    from shared.dj.timing import BEATMATCH_TECHNIQUES
    pair = [metric_analysis(), metric_analysis()]
    analysis = pair[side]
    if change == 'unknown':
        analysis['metric_regions'] = []
    elif change == 'end':
        analysis['metric_regions'][0]['end'] = 12
    elif change == 'drift':
        analysis['beat_grid'] = [t + (.01 if 4 < t < 230 else 0) for t in analysis['beat_grid']]
    elif change == 'gap':
        analysis['beat_grid'] = [t for t in analysis['beat_grid'] if not (4 < t < 12 or 200 < t < 210)]
    else:
        different = metric_analysis(period=.55)
        analysis.update(beat_grid=different['beat_grid'], downbeats=different['downbeats'])
    plan = plan_transition(*pair)
    assert plan['technique'] not in BEATMATCH_TECHNIQUES
    assert plan['sync']['alignment'] == 'none'
    assert plan['score'] == 0


def test_mixed_block_abstains_when_a_change_falls_inside_it():
    analysis, _, bars = analyse_signal(change=(31.25, 3))
    unknown = [row for row in analysis['metric_regions'] if row['beats_per_bar'] is None]
    assert any(row['start'] < 31.25 < row['end'] for row in unknown)
    assert all(min(abs(bars - t)) < .01 for t in analysis['downbeats'])


def test_unpulsed_material_keeps_metre_unknown_even_with_a_clear_key():
    samples = (.2 * np.sin(2 * np.pi * 220 * np.arange(24 * RATE) / RATE)).astype(np.float32)
    analysis = _compose(samples, samples, RATE, duration=24, tail_start=0)
    assert analysis['bpm'] == 0
    assert analysis['metric_regions'] == []
    assert analysis['bar_seconds'] is None
    assert analysis['downbeats'] == []


def test_metric_pair_cannot_be_promoted_by_key_or_composite_confidence():
    from shared.dj_engine import plan_transition
    left = metric_analysis(size=3)
    right = metric_analysis()
    left.update(key='C', mode='major', confidence=1., tempo_confidence=1.)
    right.update(key='C', mode='major', confidence=1., tempo_confidence=1.)
    plan = plan_transition(left, right)
    assert plan['fallback'] and plan['score'] == 0
    assert plan['sync']['alignment'] == 'none'


def test_metric_fallback_and_old_plans_remain_explicitly_distinguishable():
    from shared.dj.contracts import fallback_analysis
    from shared.dj_engine import plan_transition
    from test_dj_sections import measured
    old = plan_transition(measured(), measured())
    assert 'alignment' not in old['sync']  # Legacy four-pulse prior, no measured claim.
    cold = plan_transition(fallback_analysis(), metric_analysis())
    assert cold['sync']['alignment'] == 'none'
    assert cold['sync']['out_bar_seconds'] is None
    assert cold['overlap_bars'] is None


def test_routes_requests_placement_repair_and_pool_share_metric_admission():
    from shared.dj_engine import order_continuous_route, order_route, route_to_request
    from shared.dj.routes import choose_placement, choose_request_segment, repair_route
    from shared.dj_pool import add_measured_bridges
    from shared.dj.timing import beatmatch_fits
    seed = metric_analysis()
    matching = ({'id': 'matching'}, metric_analysis())
    mismatch = ({'id': 'three'}, metric_analysis(size=3))
    candidates = [mismatch, matching]
    for order in (order_continuous_route(seed, candidates), order_route(seed, candidates, limit=2)):
        assert order[0]['id'] == 'matching'
        assert beatmatch_fits(order[0]['transition'], seed, matching[1])
        assert order[-1]['transition']['sync']['alignment'] == 'none'
    # A clean first leg cannot conceal an incompatible final leg via an average.
    assert [row['id'] for row in route_to_request(seed, [matching], mismatch)] == ['three']
    segment, _ = choose_request_segment(seed, [matching], [mismatch], max_starts=3)
    assert [row['id'] for row in segment] == ['three']
    _, segment, _ = choose_placement(seed, [], mismatch, [matching])
    assert [row['id'] for row in segment] == ['three']
    repaired = repair_route(seed, [(True, dict(mismatch[0], route_kind='user'), mismatch[1])], [matching], target=1)
    assert [row['id'] for row in repaired] == ['three']
    route = [{'id': 'three', 'analysis': mismatch[1]}]
    assert [row['id'] for row in add_measured_bridges(seed, route, [matching])] == ['three']


def test_a_metric_bridge_is_admitted_when_both_executed_legs_fit():
    from shared.dj_engine import route_to_request
    from shared.dj.timing import beatmatch_fits
    seed = metric_analysis(period=.6)
    bridge = ({'id': 'bridge'}, metric_analysis(period=60 / 105))
    target = ({'id': 'target'}, metric_analysis(period=60 / 110))
    route = route_to_request(seed, [bridge], target)
    assert [row['id'] for row in route] == ['bridge', 'target']
    assert beatmatch_fits(route[0]['transition'], seed, bridge[1])
    assert beatmatch_fits(route[1]['transition'], bridge[1], target[1])


def test_shared_metric_vectors_are_the_actual_server_plans():
    import json
    from pathlib import Path
    from shared.dj_engine import plan_transition
    cases = json.loads((Path(__file__).resolve().parents[1] / 'shared/contracts/dj_metric_plans.json').read_text())
    for case in cases:
        assert plan_transition(metric_analysis(**case['outgoing']), metric_analysis(**case['incoming'])) == case['transition'], case['name']


def test_missing_head_or_middle_cannot_borrow_a_remote_downbeat_or_echo_pulse():
    from shared.dj_engine import plan_transition
    tail_only = metric_analysis(duration=600, coverage_start=528)
    tail_only['beat_grid'] = [t for t in tail_only['beat_grid'] if t >= 528]
    tail_only['downbeats'] = [t for t in tail_only['downbeats'] if t >= 528]
    tail_only['metric_regions'][0]['downbeats'] = tail_only['downbeats']
    tail_only['intro_cue'] = 0.
    incoming = plan_transition(metric_analysis(duration=600), tail_only)
    assert incoming['in_cue'] == 0  # Never seek to the only known bar at 528 s.
    assert incoming['sync']['alignment'] == 'none'
    tail_only['outro_cue'] = 300.
    outgoing = plan_transition(tail_only, metric_analysis(duration=600))
    assert outgoing['out_cue'] == 300
    assert outgoing['technique'] == 'structural_fade'
    assert 'echo_delay_seconds' not in outgoing


def test_measured_binary_and_ternary_attacks_can_leave_subdivision_ambiguous():
    analysis, _, _ = analyse_signal(beats_per_bar=2, subdivision=3, syncopated=True)
    assert all(row['beats_per_bar'] == 2 for row in analysis['metric_regions'])
    assert all(row['subdivision'] is None for row in analysis['metric_regions'])
    assert all(row['pulse_unit'] is None for row in analysis['metric_regions'])
