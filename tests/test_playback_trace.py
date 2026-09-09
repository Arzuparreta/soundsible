import copy
import json
import sqlite3

import pytest
from flask import Flask
from shared.api.routes.playback import playback_bp
from shared.playback_trace import save_batch, validate_batch
from shared.telemetry import user_telemetry_dir
from tests.conftest import TEST_USER_ID
from tests.test_migration_routes import _make_runtime, _agent_play
from shared.database import instance_db


def sample():
    return dict(id='capture:1', userId=TEST_USER_ID, dropped=0,
                capture=dict(id='capture', userId=TEST_USER_ID, clientRevision='test', deviceId='device', platform='test', displayMode='browser', startedAt='2026-09-09T00:00:00.000Z'),
                events=[dict(sequence=1, elapsedMs=0, event='media.pause', facts={'node': 'deck-1'},
                             program={'activeIndex': 1}, media=[{'id': 'deck-1', 'paused': True}], declaredState='playing', visibility='hidden')])


def test_deduplicated_durable_evidence(tmp_path):
    batch = validate_batch(sample(), TEST_USER_ID)
    save_batch(batch, tmp_path)
    save_batch(batch, tmp_path)
    with sqlite3.connect(tmp_path / 'playback-traces.sqlite3') as db:
        rows = db.execute('SELECT payload FROM batches').fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0][0])['events'][0]['declaredState'] == 'playing'


@pytest.mark.parametrize('change', [
    lambda b: b.update(userId='another-user'),
    lambda b: b.update(events=[]),
    lambda b: b.update(events=[b['events'][0]] * 25),
    lambda b: b['events'][0].update(elapsedMs=float('nan')),
    lambda b: b['events'][0].update(sequence=True),
    lambda b: b['events'][0].update(media=[{}] * 5),
    lambda b: b['events'][0]['facts'].update(node='https://secret.invalid'),
    lambda b: b.update(id='different:1'),
])
def test_rejects_invalid_evidence(change):
    batch = sample()
    change(batch)
    with pytest.raises(ValueError):
        validate_batch(batch, TEST_USER_ID)


def test_unknown_fields_never_stored():
    batch = sample()
    batch['events'][0]['media'][0]['src'] = 'https://private.invalid'
    batch['events'][0]['facts']['title'] = 'secret'
    assert 'private' not in json.dumps(validate_batch(batch, TEST_USER_ID))
    assert 'secret' not in json.dumps(validate_batch(batch, TEST_USER_ID))


def test_retention_and_size_budget(tmp_path, monkeypatch):
    import shared.playback_trace as trace
    monkeypatch.setattr(trace, 'MAX_BYTES', 700)
    for index in range(1, 10):
        b = sample()
        b['id'] = f'capture:{index}'
        b['events'][0]['sequence'] = index
        save_batch(validate_batch(b, TEST_USER_ID), tmp_path)
    with sqlite3.connect(tmp_path / 'playback-traces.sqlite3') as db:
        assert db.execute('SELECT SUM(length(payload)) FROM batches').fetchone()[0] <= 700
        assert db.execute('SELECT id FROM batches ORDER BY received DESC LIMIT 1').fetchone()[0] == 'capture:9'
    monkeypatch.setattr(trace.time, 'time', lambda: 1e12)
    save_batch(validate_batch(sample(), TEST_USER_ID), tmp_path)
    with sqlite3.connect(tmp_path / 'playback-traces.sqlite3') as db:
        assert db.execute('SELECT COUNT(*) FROM batches').fetchone()[0] == 1


def test_authenticated_endpoint_ack_and_disabled(tmp_path, monkeypatch):
    _make_runtime(tmp_path)
    app = Flask(__name__)
    app.register_blueprint(playback_bp)
    client = app.test_client()
    headers = {'Authorization': f'Bearer {_agent_play(instance_db())}'}
    res = client.post('/api/playback/trace', json=sample(), headers=headers)
    assert res.status_code == 200
    assert res.json == {'id': 'capture:1', 'enabled': True}
    path = user_telemetry_dir() / 'playback-traces.sqlite3'
    assert path.exists()
    bad = copy.deepcopy(sample())
    bad['userId'] = 'another-account'
    assert client.post('/api/playback/trace', json=bad, headers=headers).status_code == 400
    assert client.post('/api/playback/trace', data='x' * 48001, headers=headers).status_code == 413
    monkeypatch.setenv('SOUNDSIBLE_TELEMETRY_ENABLED', '0')
    modified = sample()
    modified['id'] = 'capture:2'
    modified['events'][0]['sequence'] = 2
    assert client.post('/api/playback/trace', json=modified, headers=headers).json['enabled'] is False
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM batches').fetchone()[0] == 1


def test_storage_failure_is_not_acknowledged(tmp_path, monkeypatch):
    _make_runtime(tmp_path)
    app = Flask(__name__)
    app.register_blueprint(playback_bp)
    headers = {'Authorization': f'Bearer {_agent_play(instance_db())}'}
    def fail(*args):
        raise OSError('full disk')
    monkeypatch.setattr('shared.playback_trace.save_batch', fail)
    assert app.test_client().post('/api/playback/trace', json=sample(), headers=headers).status_code == 503


def test_operator_report_orders_offline_delivery_and_exposes_gaps(tmp_path):
    from scripts.playback_trace_report import report
    second = sample()
    second['id'] = 'capture:3'
    second['events'][0].update(sequence=3, elapsedMs=1000, event='handoff.retirement')
    save_batch(validate_batch(second, TEST_USER_ID), tmp_path)
    save_batch(validate_batch(sample(), TEST_USER_ID), tmp_path)
    result = report(tmp_path / 'playback-traces.sqlite3', '2026-09-08T21:30:00+02:00')
    assert 'missing-sequences=1' in result
    assert result.index('#1 ') < result.index('#3 ')
    assert 'NOT an acknowledgement' in result


def clock_rows():
    return [dict(sequence=i + 1, elapsedMs=i * 5000, event='media.timeupdate',
                 facts={'node': 'deck-1'}, visibility='visible', declaredState='playing',
                 program=dict(activeIndex=0, contextState='running', mixPhase='idle', outputMode='direct', contextTime=i * 4.983),
                 media=[dict(id='deck-1', deckIndex=0, paused=False, sourceKind='track', rate=1, position=i * 5)])
            for i in range(4)]


def test_clock_report_measures_stable_drift_without_carrier(tmp_path):
    from scripts.playback_trace_report import report
    batch = sample()
    batch['events'] = clock_rows()
    save_batch(validate_batch(batch, TEST_USER_ID), tmp_path)
    result = report(tmp_path / 'playback-traces.sqlite3')
    assert 'Clocks mode=direct visibility=visible intervals=3' in result
    assert 'context/wall=0.996600 source/wall=1.000000 context-drift=-0.340%' in result
    assert 'not measured audible pitch' in result


@pytest.mark.parametrize('interrupt', [
    lambda r: r.update(event='media.seeking'),
    lambda r: r.update(event='call.play'),
    lambda r: r.update(declaredState='paused'),
    lambda r: r.update(visibility='hidden'),
    lambda r: r['program'].update(mixPhase='crossfading'),
    lambda r: r['program'].update(contextState='suspended'),
    lambda r: r['program'].update(activeIndex=1),
    lambda r: r['media'][0].update(rate=1.05),
    lambda r: r['media'][0].update(position=70),
    lambda r: r.update(sequence=9),
])
def test_clock_report_does_not_bridge_interruptions(interrupt):
    from scripts.playback_trace_report import clock_comparison
    rows = clock_rows()
    interrupt(rows[1])
    assert clock_comparison(rows) == []
