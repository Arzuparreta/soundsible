"""Phrases, sections and roles against arrangements with known answers (P13).

Every signal is synthesised with known bars and known arrangement changes.
The beat model's events are given exactly, on its 20 ms frames, as in
`test_dj_metre`: what is measured here is the structure's own error. Wrong
model bars are given on purpose to show which error is inherited.
"""
import numpy as np
import pytest

from shared.dj.analysis import _compose
from shared.dj.structure import phrase_length
from shared.dj_engine import plan_transition
from test_dj_metre import metric_signal, model_events

RATE = 11025
FULL = {'kick': 1., 'bass': .3, 'hat': .15, 'chords': .08, 'lead': 0., 'riser': 0.}


def arrangement(layers, *, bars=96, beats_per_bar=4, subdivision=2, period=.5, first=.25, seed=1813, rate=RATE):
    """Samples, beats and first beats of `bars` bars; `layers(bar)` overrides `FULL` gains.

    Kick on every beat and a bass note per bar (44-177 Hz), hats on the
    subdivisions, a chord per bar from a four-bar loop (220-554 Hz), a lead at
    880 Hz and a riser of 2-4 kHz noise.
    """
    rng = np.random.default_rng(seed)
    bar_seconds = beats_per_bar * period
    samples = np.zeros(round((first + bars * bar_seconds + 1) * rate), dtype=np.float32)
    t = np.arange(round(.15 * rate)) / rate
    kick = np.sin(2 * np.pi * (65 * t + 3 * (1 - np.exp(-t / .02)))) * np.exp(-t / .04)
    hat_t = np.arange(round(.035 * rate)) / rate
    hat = rng.normal(0, 1, len(hat_t)) * np.exp(-hat_t / .006)
    spectrum = np.fft.rfft(rng.normal(0, 1, len(samples)))
    frequencies = np.fft.rfftfreq(len(samples), 1 / rate)
    riser = np.fft.irfft(np.where((frequencies >= 2000) & (frequencies <= 4000), spectrum, 0), len(samples))
    riser /= np.sqrt(np.mean(riser ** 2))

    def add(at, sound, gain):
        start = round(at * rate)
        stop = min(len(samples), start + len(sound))
        if gain and stop > start:
            samples[start:stop] += gain * sound[:stop - start]

    beats, ones = [], []
    for bar in range(bars):
        gains = {**FULL, **layers(bar)}
        at = first + bar * bar_seconds
        ones.append(at)
        start, stop = round(at * rate), round((at + bar_seconds) * rate)
        tt = np.arange(stop - start) / rate
        ramp = np.minimum(tt / .01, 1) * np.minimum((tt[-1] - tt) / .01, 1)
        root = (0, 5, 7, 9)[bar % 4]
        tone = gains['bass'] * np.sin(2 * np.pi * 55 * 2 ** (root / 12) * tt)
        tone += gains['chords'] * sum(np.sin(2 * np.pi * 220 * 2 ** ((root + step) / 12) * tt) for step in (0, 4, 7))
        tone += gains['lead'] * np.sin(2 * np.pi * 880 * tt)
        samples[start:stop] += ramp * (tone + gains['riser'] * riser[start:stop])
        for beat in range(beats_per_bar):
            beats.append(at + beat * period)
            add(beats[-1], kick, gains['kick'] * (1 if beat == 0 else .7))
            for fraction in range(1, subdivision):
                add(beats[-1] + period * fraction / subdivision, hat, gains['hat'])
    samples += rng.normal(0, 1e-4, len(samples)).astype(np.float32)
    return samples, np.array(beats), np.array(ones)


def analyse(samples, beats, ones, model=model_events):
    events = model(beats, ones)
    return _compose(samples, samples, RATE, duration=len(samples) / RATE, tail_start=0, events=(events, events))


def bars_of(times, ones):
    """Bar index of each time, which must lie on a known first beat."""
    ones = np.asarray(ones)
    found = []
    for at in times:
        index = int(np.argmin(np.abs(ones - at)))
        assert abs(ones[index] - at) < .01, (at, ones[index])
        found.append(index)
    return found


def toggling(phrase_bars, offset):
    """A lead that enters or leaves every `phrase_bars` bars from bar `offset`."""
    return lambda bar: {'lead': .1 * (bar >= offset and (bar - offset) // phrase_bars % 2 == 0)}


METRES = [(4, 2), (3, 2), (2, 3)]  # 4/4, 3/4 and 6/8 as two dotted-quarter pulses.


@pytest.mark.parametrize('beats_per_bar,subdivision', METRES)
@pytest.mark.parametrize('phrase_bars,offset', [(4, 4), (8, 5), (16, 4)])
def test_measured_changes_give_phrase_length_and_phase(beats_per_bar, subdivision, phrase_bars, offset):
    samples, beats, ones = arrangement(toggling(phrase_bars, offset), beats_per_bar=beats_per_bar,
                                       subdivision=subdivision)
    analysis = analyse(samples, beats, ones)
    measured = len(ones) - 1  # The last first beat closes no whole bar.
    known = list(range(offset, measured - 4 + 1, phrase_bars))
    boundaries = [row['start'] for row in analysis['phrases'] if row['evidence'] == 'boundary']
    assert bars_of(boundaries, ones) == known
    # Phase from the changes, not from the first one: bar 5 is not a
    # multiple of eight bars from the start.
    starts = bars_of([row['start'] for row in analysis['phrases']], ones)
    assert starts == list(range(offset % phrase_bars, measured, phrase_bars))
    assert 'assumed' not in {row['evidence'] for row in analysis['phrases']}
    assert all(row['bars'] == phrase_bars for row in analysis['phrases'][:-1])


def test_an_extended_phrase_restarts_the_count_without_inventing_a_short_one():
    changes = [8, 16, 26, 34, 42, 50, 58, 66, 74, 82]

    def layers(bar):
        return {'lead': .1 * (sum(bar >= change for change in changes) % 2)}

    samples, beats, ones = arrangement(layers)
    analysis = analyse(samples, beats, ones)
    phrases = analysis['phrases']
    assert bars_of([row['start'] for row in phrases if row['evidence'] == 'boundary'], ones) == changes
    assert bars_of([row['start'] for row in phrases], ones) == [0] + changes + [90]
    assert [row['bars'] for row in phrases][:4] == [8, 8, 10, 8]


def test_without_a_shared_length_phrases_are_an_assumption_counted_from_each_change():
    changes = [8, 13, 25, 31, 45, 55, 62, 76]

    def layers(bar):
        return {'lead': .1 * (sum(bar >= change for change in changes) % 2)}

    samples, beats, ones = arrangement(layers)
    analysis = analyse(samples, beats, ones)
    phrases = analysis['phrases']
    assert bars_of([row['start'] for row in phrases if row['evidence'] == 'boundary'], ones) == changes
    assigned = {bar: row['evidence'] for bar, row in zip(bars_of([row['start'] for row in phrases], ones), phrases)}
    # Eight bars from each change, never closer than four bars to the next.
    assert assigned == {0: 'assumed', 8: 'boundary', 13: 'boundary', 21: 'assumed', 25: 'boundary',
                        31: 'boundary', 39: 'assumed', 45: 'boundary', 55: 'boundary', 62: 'boundary',
                        70: 'assumed', 76: 'boundary', 84: 'assumed', 92: 'assumed'}


@pytest.mark.parametrize('intervals,expected', [
    ([16] * 5, 16), ([8] * 7, 8), ([4] * 20, 4), ([12] * 6, 12), ([8, 8, 10, 8, 8, 8], 8),
    ([16, 16, 16], None),  # Three intervals cannot exclude chance at the three-sigma level.
    ([5, 12, 6, 14, 10, 7, 14], None),
])
def test_phrase_length_needs_more_shared_intervals_than_chance(intervals, expected):
    changes = list(np.cumsum([4] + intervals))
    assert phrase_length(changes, changes[-1] + 8) == expected


def roles(layout):
    """`layers` for consecutive (bars, gains) sections."""
    edges = np.cumsum([0] + [bars for bars, _ in layout])

    def layers(bar):
        index = int(np.searchsorted(edges, bar, side='right')) - 1
        gains = layout[min(index, len(layout) - 1)][1]
        return gains(bar - edges[index]) if callable(gains) else gains
    return layers


THIN = {'bass': 0., 'chords': 0.}  # Kick and hats only.
LEAD = {'lead': .1}
NO_BEAT = {'kick': 0., 'bass': 0., 'lead': .1}


def labels(analysis, ones):
    return [(bars_of([row['start']], ones)[0], row['label']) for row in analysis['sections']]


@pytest.mark.parametrize('beats_per_bar,subdivision', METRES)
def test_roles_follow_measured_conditions_not_eight_bar_blocks(beats_per_bar, subdivision):
    layout = [(12, THIN), (20, LEAD), (12, NO_BEAT), (20, LEAD), (12, {**THIN, 'lead': 0.}), (20, LEAD)]
    samples, beats, ones = arrangement(roles(layout), bars=96, beats_per_bar=beats_per_bar, subdivision=subdivision)
    analysis = analyse(samples, beats, ones)
    # Changes at bars 12, 32, 44, 64 and 76, none on the old eight-bar
    # blocks but 32 and 64. The sparser section at 64 and the full one at 76
    # both carry the beat: one body, and no outro since sound returns at 76.
    assert labels(analysis, ones) == [(0, 'intro'), (12, 'body'), (32, 'breakdown'), (44, 'drop'), (64, 'body')]
    assert bars_of([row['start'] for row in analysis['phrases'] if row['evidence'] == 'boundary'], ones) == [
        12, 32, 44, 64, 76]
    sections = {bars_of([row['start']], ones)[0]: row for row in analysis['sections']}
    assert sections[32]['label'] == 'breakdown' and sections[32]['low_db'] <= -10
    assert sections[44]['label'] == 'drop' and sections[44]['low_db'] > -3
    # A section with the beat but fewer sounds, between full ones, is not a
    # breakdown: its kick/bass octaves are within 10 dB.
    assert sections[64]['label'] == 'body' and -10 < sections[64]['low_db']


def test_outro_starts_where_changes_only_remove_sound_and_build_needs_a_measured_rise():
    def build(bar):
        # A riser enters and grows 0.6 dB a bar: under the 3 dB a change
        # needs between four bars, more than 3 dB across the section.
        return {**NO_BEAT, 'riser': .2 * 10 ** (.03 * bar)}

    layout = [(16, LEAD), (8, NO_BEAT), (8, build), (32, LEAD), (16, {'lead': 0.}), (16, THIN)]
    samples, beats, ones = arrangement(roles(layout), bars=96)
    analysis = analyse(samples, beats, ones)
    assert labels(analysis, ones) == [(0, 'body'), (16, 'breakdown'), (24, 'build'), (32, 'drop'),
                                      (64, 'outro')]
    sections = analysis['sections']
    assert [row['starts_on_change'] for row in sections] == [False, True, True, True, True]
    assert sum(row['bars'] for row in sections) == 95


@pytest.mark.parametrize('change', [
    {'kick': 2., 'bass': .6, 'hat': .3, 'chords': .16, 'lead': .2},  # Everything 6 dB louder.
    {'kick': .5, 'bass': .15, 'hat': .075, 'chords': .04, 'lead': .05},  # Everything 6 dB quieter.
])
def test_a_level_jump_alone_is_neither_a_drop_nor_a_breakdown(change):
    samples, beats, ones = arrangement(roles([(32, LEAD), (16, change), (48, LEAD)]))
    analysis = analyse(samples, beats, ones)
    assert bars_of([row['start'] for row in analysis['phrases'] if row['evidence'] == 'boundary'], ones) == [32, 48]
    sections = analysis['sections']
    assert not {'drop', 'breakdown', 'build', None} & {row['label'] for row in sections}
    assert all(row['low_db'] > -10 for row in sections)
    if change['kick'] > 1:
        # Opening while each change only adds sound, closing once each
        # change only removes it: measured intro and outro, not a drop.
        assert labels(analysis, ones) == [(0, 'intro'), (32, 'body'), (48, 'outro')]


def test_ambiguous_material_claims_no_change_or_role():
    # A steady loop, a lead 1.6 dB louder (under a doubling of the band's
    # power), and a lead fading in by 0.5 dB a bar for 32 bars.
    cases = [lambda bar: LEAD, lambda bar: {'lead': .1 if bar < 48 else .12},
             lambda bar: {'lead': .1 * 10 ** (.025 * min(max(bar - 32, 0), 32))}]
    for layers in cases:
        samples, beats, ones = arrangement(layers)
        analysis = analyse(samples, beats, ones)
        assert not [row for row in analysis['phrases'] if row['evidence'] == 'boundary']
        assert {row['evidence'] for row in analysis['phrases']} == {'assumed'}
        assert [row['label'] for row in analysis['sections']] == [None]
        assert bars_of([row['start'] for row in analysis['phrases']], ones) == list(range(0, 95, 8))


def test_wrong_model_bars_move_changes_by_the_inherited_error_only():
    samples, beats, ones = arrangement(toggling(8, 8))

    def shifted(times, firsts):
        times, _ = model_events(times, firsts)
        return times, times[1::4]  # Every bar one beat late, as the network can be.

    analysis = analyse(samples, beats, ones, model=shifted)
    boundaries = np.array([row['start'] for row in analysis['phrases'] if row['evidence'] == 'boundary'])
    true = ones[np.arange(8, 92, 8)]
    # The change is found on the model's next bar line: one beat after the
    # real one. Its phrase length in model bars is still the measured eight.
    assert len(boundaries) == len(true)
    np.testing.assert_allclose(boundaries - true, .5, atol=.01)
    assert {row['bars'] for row in analysis['phrases'][1:-1]} == {8}
    assert {row['evidence'] for row in analysis['phrases']} == {'boundary', 'counted'}


def test_no_phrase_or_section_crosses_unknown_bars_or_unmeasured_windows():
    # An unaligned change of metre: the block holding it has no bar (P12).
    # On a steady pulse P12-b counts whole bars into it from the next one
    # (`projected_bar`), and structure inherits those bars; on a followed,
    # drifting pulse nothing is counted across it.
    samples, beats, bars = metric_signal(change=(30.75, 3), drift=.015)
    events = model_events(beats, bars)
    analysis = _compose(samples, samples, RATE, duration=72, tail_start=0, events=(events, events))
    unknown = [row for row in analysis['metric_regions'] if row['beats_per_bar'] is None]
    assert unknown and analysis['tempo_confidence'] <= .6
    for gap in unknown:
        assert not any(gap['start'] < row['start'] < gap['end'] for row in analysis['phrases'])
        assert not any(row['start'] < gap['end'] and row['end'] > gap['start'] for row in analysis['sections'])
    after = [row for row in analysis['phrases'] if row['start'] >= unknown[-1]['end']]
    assert after[0]['start'] == pytest.approx(min(t for t in analysis['downbeats'] if t >= unknown[-1]['end']))
    # Head and tail of a long recording are measured apart: no structure in
    # the gap, an intro only at the head, an outro only at the tail.
    layout = [(8, THIN), (28, LEAD)]
    head, head_beats, head_ones = arrangement(roles(layout), bars=36)
    tail, tail_beats, tail_ones = arrangement(roles([(28, LEAD), (8, THIN)]), bars=36)
    events = (model_events(tail_beats, tail_ones), model_events(head_beats, head_ones))
    tail_start = 600 - len(tail) / RATE
    long = _compose(tail, head, RATE, duration=600, tail_start=tail_start, events=events)
    head_end = len(head) / RATE
    assert not any(head_end < row['start'] < tail_start for row in long['phrases'])
    assert all(row['end'] <= head_end or row['start'] >= tail_start for row in long['sections'])
    assert [row['label'] for row in long['sections'] if row['start'] < head_end] == ['intro', 'body']
    assert [row['label'] for row in long['sections'] if row['start'] >= tail_start] == ['body', 'outro']


def test_measured_phrases_and_roles_choose_the_blend_end_and_the_drop():
    """The incoming drop lands on a measured outgoing phrase, not on the old eight-bar count."""
    outgoing = analyse(*arrangement(toggling(8, 5), bars=119))
    incoming = analyse(*arrangement(roles([(8, THIN), (8, LEAD), (16, NO_BEAT), (87, LEAD)]), bars=119))
    drop = next(row['start'] for row in incoming['sections'] if row['label'] == 'drop')
    assert drop == pytest.approx(.25 + 32 * 2, abs=.005)
    plan = plan_transition(outgoing, incoming)
    end = plan['out_cue'] + plan['overlap_seconds']
    assert plan['technique'] == 'bass_swap'
    assert end in [row['start'] for row in outgoing['phrases'] if row['evidence'] != 'assumed']
    assert round((end - .25) / 2) % 8 == 5
    assert (drop - plan['in_cue']) / plan['playback_rate'] == pytest.approx(plan['overlap_seconds'], abs=.005)
    # Counted from the first one, as before P13, the blend ended elsewhere.
    counted = {**outgoing, 'phrases': [{'start': t, 'bars': 8, 'evidence': 'assumed'}
                                       for t in outgoing['downbeats'][::8]]}
    before = plan_transition(counted, incoming)
    assert round((before['out_cue'] + before['overlap_seconds'] - .25) / 2) % 8 == 0
    # The eight-bar assumption remains a reserve: without a measured phrase
    # in reach, the drop still lands on an assumed one.
    reserve = {**outgoing, 'phrases': [{**row, 'evidence': 'assumed'} for row in counted['phrases']]}
    assert plan_transition(reserve, incoming)['in_cue'] == before['in_cue']
    # A louder section without the beat returning is not a drop to aim at.
    louder = analyse(*arrangement(roles([(32, LEAD), (16, {'lead': .4}), (71, LEAD)]), bars=119))
    assert 'drop' not in {row['label'] for row in louder['sections']}
    assert plan_transition(outgoing, louder)['in_cue'] == pytest.approx(.25, abs=.005)  # Its first beat.
