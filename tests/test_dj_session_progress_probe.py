"""Guard the study's inference boundaries, especially incomplete evidence."""
import gzip
import hashlib
import json
import sqlite3

from docs.dj.session_progress_probe import (
    ANALYSER_VERSION, delivery_runs, paired_summary, plan_report, read_timing,
    replay_report, trace_report,
)


def delivery(index, *, device='one', trigger=None, outcome='handoff', start=None):
    start = index * 100 if start is None else start
    return dict(device_id=device, attempt_id=str(index), track_id=f'track-{index}',
                phase='ui_play_delivery', ts=start + 100, trigger=trigger or ('selection' if index == 0 else 'handoff'),
                terminal_state=outcome, segments=dict(audible_ms=100_000))


def test_runs_never_bridge_manual_selection_resume_missing_delivery_or_devices():
    rows = [delivery(i) for i in range(6)]
    assert len(delivery_runs(rows)) == 1
    assert len(delivery_runs(rows[::-1])) == 1
    for trigger in ['selection', 'resume', 'next', 'ended']:
        changed = [dict(row) for row in rows]
        changed[3]['trigger'] = trigger
        assert delivery_runs(changed) == []
    assert delivery_runs(rows[:3] + rows[4:]) == []
    changed = [dict(row) for row in rows]
    changed[3]['device_id'] = 'two'
    assert delivery_runs(changed) == []


def test_run_boundary_uses_play_start_not_upload_end():
    rows = [delivery(i) for i in range(5)]
    rows[2] = delivery(2, start=206)
    assert delivery_runs(rows) == []
    assert len(delivery_runs(rows, max_gap=10)) == 1


def test_timing_deduplicates_rotations_by_device_and_attempt(tmp_path):
    a = delivery(0)
    b = delivery(0, device='two')
    active = tmp_path / 'play-timing.jsonl'
    rotated = tmp_path / 'play-timing.jsonl.1.gz'
    active.write_text(json.dumps(a) + '\n' + json.dumps(b) + '\n')
    with gzip.open(rotated, 'wt') as stream:
        stream.write(json.dumps(a) + '\n')
    assert len(read_timing([active, rotated], 0)) == 2
    assert read_timing([active, rotated], 101) == []


def test_plans_require_opening_and_deduplicate_retries(tmp_path):
    def line(session, segment, ready, route=4, minute=0):
        return (f'2026-10-30 10:{minute:02}:00,000 INFO dj-plan session={session} segment={segment} '
                f'route={route} sources=1 analysis_candidates=24 analysis_cohort=16 '
                f'analysis_cohort_ready={ready} cache_hit=1 cache_miss=0\n')

    path = tmp_path / 'plans.log'
    path.write_text(line('a', 0, 0, route=0) + line('a', 0, 1, minute=1)
                    + line('a', 0, 16, minute=2) + line('a', 1, 4, minute=3)
                    + line('partial', 1, 16) + line('partial', 2, 16, minute=5))
    report = plan_report(path, 'Europe/Madrid', 0)
    assert report['logged_sessions'] == 2
    assert len(report['paired_sessions']) == 1
    assert report['paired_sessions'][0]['early']['cohort_ready'] == 1
    assert report['paired_summary']['cohort_ready_fraction']['late_minus_early'] == 3 / 16


def test_pair_summary_does_not_impute_unknown_values_or_pool_sessions():
    report = paired_summary([{'early': {'x': 0}, 'late': {'x': 1}},
                             {'early': {'x': 1}, 'late': {'x': 0}},
                             {'early': {'x': None}, 'late': {'x': 100}}], ['x'])['x']
    assert report['sessions'] == 2
    assert report['late_minus_early'] == 0
    assert report['increased'] == report['decreased'] == 1


def test_replay_never_fills_missing_current_analysis_with_old_version(tmp_path):
    cache = tmp_path / 'analysis.sqlite3'
    with sqlite3.connect(cache) as db:
        db.execute('CREATE TABLE audio_analysis(identity TEXT, payload TEXT, analyser_version INTEGER)')
        for i in range(5):
            db.execute('INSERT INTO audio_analysis VALUES(?,?,?)',
                       (hashlib.sha256(f'track-{i}'.encode()).hexdigest(),
                        json.dumps({'analysed': True}), ANALYSER_VERSION - 1))
    report = replay_report([list(delivery_runs([delivery(i) for i in range(5)])[0])], cache, 1)
    assert report['excluded_runs'] == {'missing_current_analysis': 1}
    assert report['runs'] == []
    assert report['paired_summary'] == {}
    assert report['same_pair_cold_warm']['pairs'] == 0


def test_trace_counts_missing_sequences_and_reuploads_without_inventing_technique(tmp_path):
    path = tmp_path / 'traces.sqlite3'
    batch = dict(capture=dict(id='capture', startedAt='2026-10-30T10:00:00+00:00',
                             clientRevision='revision', platform='other'), dropped=2,
                 events=[dict(sequence=3, elapsedMs=0, event='mix.started', facts={}),
                         dict(sequence=5, elapsedMs=1000, event='handoff.retirement', facts={})])
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE batches(id TEXT, received REAL, payload TEXT)')
        db.executemany('INSERT INTO batches VALUES(?,?,?)', [('a', 1, json.dumps(batch)), ('b', 2, json.dumps(batch))])
    result = trace_report(path, 0)[0]
    assert result['sequence_gaps'] == 3
    assert result['reported_loss'] == 2
    assert result['retirements'] == 1
    assert result['mix_starts_with_technique'] == 0
