import copy
import json
import sqlite3

import pytest

from scripts.dj_session_report import report
from shared.playback_trace import validate_batch
from tests.conftest import TEST_USER_ID


def capture():
    rows = []

    def add(event, **facts):
        rows.append(dict(sequence=len(rows) + 1, elapsedMs=len(rows) * 1000,
                         event=event, facts=dict(djSession='session', **facts), media=[], program={}))

    add('dj.session_started', startKnown=True)
    for i in range(1, 5):
        add('dj.selected', edgeId=f'edge-{i}', selectionKnown=True, fromAnalysed=False, toAnalysed=False)
        add('dj.committed', edgeId=f'edge-{i}', transitionId=f'mix-{i}', ordinal=i,
            selectionKnown=True, manual=False, mixing=True, fromAnalysed=True, toAnalysed=True,
            score=i / 5, notesDelta=0, lufsDelta=1, flatnessDelta=0)
        add('mix.started', edgeId=f'edge-{i}', transitionId=f'mix-{i}', ordinal=i,
            technique='bass_swap', rate=1.01, overlap=16)
        add('dj.outcome', edgeId=f'edge-{i}', transitionId=f'mix-{i}', ordinal=i, outcome='completed')
    return dict(id='capture:1', userId=TEST_USER_ID, dropped=0, events=rows,
                capture=dict(id='capture', userId=TEST_USER_ID, startedAt='2026-10-30T10:00:00+00:00',
                             clientRevision='revision', deviceId='device', platform='test', displayMode='browser'))


def run(tmp_path, batch):
    path = tmp_path / 'traces.sqlite3'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE batches (id TEXT, received REAL, payload TEXT)')
        # Retry upload of the same events must not duplicate measurements.
        db.executemany('INSERT INTO batches VALUES (?, ?, ?)',
                       [('a', 1, json.dumps(batch)), ('b', 2, json.dumps(batch))])
    return report(path)


def test_schema_persists_linkage_and_report_pairs_the_actual_session(tmp_path):
    batch = validate_batch(capture(), TEST_USER_ID)
    result = run(tmp_path, batch)
    assert result['eligible_sessions'] == 1
    row = result['sessions'][0]
    assert row['completed_transitions'] == 4
    assert row['opening_analysis'] == 'not_ready'
    assert result['comparisons_by_client'][0]['opening_analysis'] == 'not_ready'
    assert row['early']['selected_ready_fraction'] == 0
    assert row['late']['committed_ready_fraction'] == 1
    assert row['early']['planner_score'] == 0.3
    assert row['late']['planner_score'] == 0.7
    assert row['late']['notes_delta'] == 0
    assert row['late']['executed_rate_change_percent'] == 1
    assert 'device' not in json.dumps(result)
    assert 'mix-1' not in json.dumps(result)


@pytest.mark.parametrize('change,reason', [
    (lambda b: b['events'][0]['facts'].update(startKnown=False), 'opening_not_observed'),
    (lambda b: b['events'].pop(0), 'opening_not_observed'),
    (lambda b: b['events'].pop(3), 'trace_loss'),
    (lambda b: b.update(dropped=1), 'trace_loss'),
    (lambda b: b['events'][2]['facts'].update(manual=True), 'manual_or_unmixed'),
    (lambda b: b['events'][2]['facts'].update(mixing=False), 'manual_or_unmixed'),
    (lambda b: b['events'][5].update(event='dj.direction_changed'), 'interaction_or_interruption'),
    (lambda b: b['events'][1].update(event='dj.interaction'), 'interaction_or_interruption'),
    (lambda b: b['events'][1].update(event='dj.capture_unavailable'), 'capture_unavailable'),
    (lambda b: b['events'][1].update(event='transport.pause'), 'interaction_or_interruption'),
    (lambda b: b['events'][1].update(event='connection.state', facts=dict(djSession='session', state='offline')), 'connection_interrupted'),
    (lambda b: b['events'][3]['facts'].pop('technique'), 'execution_missing'),
])
def test_missing_or_interrupted_evidence_cannot_become_an_unattended_session(tmp_path, change, reason):
    batch = copy.deepcopy(capture())
    change(batch)
    result = run(tmp_path, batch)
    assert result['eligible_sessions'] == 0
    assert reason in result['sessions'][0]['exclusions']
    assert result['comparisons_by_client'] == []


def test_unknown_measurements_are_not_zero_and_fallback_invalidates_beatmatch_claim(tmp_path):
    batch = capture()
    batch['events'][2]['facts']['score'] = None
    batch['events'][1]['facts']['fromAnalysed'] = None
    # A later rate fallback belongs to this attempt even after its completed callback.
    batch['events'].append(dict(sequence=18, elapsedMs=18000, event='mix.rate_fallback',
                                facts=dict(djSession='session', transitionId='mix-1'), media=[], program={}))
    result = run(tmp_path, batch)
    row = result['sessions'][0]
    assert row['early']['planner_score'] is None
    assert row['early']['selected_ready_fraction'] is None
    assert row['early']['execution_fallback_fraction'] == 0.5
    assert row['early']['executed_beatmatch_fraction'] == 0.5


def test_old_captures_are_not_reconstructed_from_timestamps(tmp_path):
    batch = capture()
    for row in batch['events']:
        row['facts'].pop('djSession')
    result = run(tmp_path, batch)
    assert result['linked_sessions'] == result['eligible_sessions'] == 0


def test_initial_source_configuration_before_any_selection_is_not_a_mid_session_edit(tmp_path):
    batch = capture()
    batch['events'].insert(1, dict(event='dj.direction_changed', facts=dict(djSession='session'), elapsedMs=500, media=[], program={}))
    for index, row in enumerate(batch['events'], 1):
        row['sequence'] = index
    assert run(tmp_path, batch)['eligible_sessions'] == 1
