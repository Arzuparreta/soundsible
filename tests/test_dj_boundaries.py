"""Pure responsibilities, wire absence and execution boundaries after P11."""

import copy
import json
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from shared.dj import analysis, contracts, features, rhythm, routes, store, structure, timing, transitions
from shared import dj_engine
from shared.dj_pool import _beatmatched, add_measured_bridges
from test_dj_sections import measured


def test_pure_planning_imports_do_not_load_storage_or_application():
    code = '''
import sys
assert not {'shared.dj.store', 'shared.api', 'sqlite3', 'subprocess', 'gevent'} & sys.modules.keys()
'''
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr


def test_public_facade_has_one_cache_worker_and_planner_owner():
    for name in ('analyse_audio', 'cached_analysis', 'request_analysis', 'analysis_identity'):
        assert getattr(dj_engine, name) is getattr(store, name)
    for name in ('order_route', 'order_continuous_route', 'route_to_request'):
        assert getattr(dj_engine, name) is getattr(routes, name)
    assert dj_engine.plan_transition is transitions.plan_transition
    assert dj_engine.ANALYSER_VERSION == contracts.ANALYSER_VERSION


def test_acquisition_keeps_one_job_64_pending_and_identity_deduplication(tmp_path, monkeypatch):
    # One job: inside the engine the analysis process measures one song at a time.
    source = tmp_path / 'audio'
    source.write_bytes(b'only a job fixture')
    release = threading.Event()
    started = threading.Event()
    seen = []

    def analyse(path, identity, **kwargs):
        seen.append(identity)
        started.set()
        assert release.wait(timeout=5)

    monkeypatch.setattr(store, '_pending', set())
    monkeypatch.setattr(store, 'analyse_audio', analyse)
    with ThreadPoolExecutor(max_workers=1) as executor:
        monkeypatch.setattr(store, '_pool', executor)
        from shared import work
        jobs = work.Executor('dj-analysis', 1)
        jobs.pool.shutdown()
        jobs.pool = executor
        monkeypatch.setattr(store, '_jobs', jobs)
        try:
            for index in range(65):
                store.request_analysis(source, str(index))
                store.request_analysis(source, str(index))
            assert started.wait(timeout=5)
            assert len(seen) == 1
            assert len(store._pending) == 64
            assert '64' not in store._pending
        finally:
            release.set()
    assert len(seen) == len(set(seen)) == 64
    assert not store._pending


def test_the_engine_pool_runs_one_job(monkeypatch):
    monkeypatch.setattr(store, '_pool', None)
    monkeypatch.setattr(store, '_jobs', None)
    pool = store._analysis_pool()
    try:
        assert pool._max_workers == 1
    finally:
        pool.shutdown(wait=False)


def test_compact_summary_distinguishes_unknown_and_measured_zero_without_mutating_analysis():
    unknown = contracts.fallback_analysis()
    zero = {**unknown, 'analysed': True, 'note_rate': 0., 'spectral_flatness': 0.,
            'loudness_lufs': None, 'beat_grid': list(range(20000)), 'future_measure': 0.}
    original = copy.deepcopy(zero)
    summary = contracts.analysis_summary(zero)
    assert summary['note_rate'] == summary['spectral_flatness'] == summary['future_measure'] == 0
    assert summary['loudness_lufs'] is None
    assert summary['outro_cue'] is None
    assert contracts.analysis_summary(unknown)['note_rate'] is None
    assert not {'beat_grid', 'downbeats', 'phrases', 'sections'} & summary.keys()
    assert len(json.dumps([summary] * 16).encode()) < 256 * 1024
    assert zero == original


@pytest.mark.parametrize('change', [
    {'sync': {}}, {'sync': None}, {'sync': {'out_period': 0, 'in_period': .5}},
    {'playback_rate': None}, {'playback_rate': float('nan')},
    {'overlap_seconds': -1}, {'overlap_seconds': float('inf')},
])
def test_bridge_boundary_rejects_invalid_or_old_incomplete_plans(change):
    analysis = measured()
    plan = {**transitions.plan_transition(analysis, analysis), **change}
    assert not _beatmatched(plan, analysis, analysis)


def test_bridge_boundary_uses_the_same_rounded_rate_and_full_overlap_budget():
    analysis = measured()
    plan = transitions.plan_transition(analysis, analysis)
    assert timing.rate_fits(plan) and _beatmatched(plan, analysis, analysis)
    plan['playback_rate'] += .001
    assert not timing.rate_fits(plan)
    assert not _beatmatched(plan, analysis, analysis)


def test_preserved_request_bridge_policy_differs_from_measured_cohort_admission():
    # P11-a in the handoff: do not silently change this musical policy during
    # extraction. Both legs exceed the players' 8 % range; the request bridge
    # wins on key alone, and a score is not a beatmatch certificate.
    seed, spare, target = ({**measured(bpm=bpm), 'key': key} for bpm, key in ((100, 'C'), (109, 'A'), (119, 'F#')))
    pool = [({'id': 'spare'}, spare)]
    destination = ({'id': 'target'}, target)
    requested = routes.route_to_request(seed, pool, destination, max_starts=3)
    assert [row['id'] for row in requested] == ['spare', 'target']
    assert [row['transition']['technique'] for row in requested] == ['echo_cut', 'echo_cut']
    assert [row['transition']['score'] for row in requested] == [.381, .381]
    assert transitions.plan_transition(seed, target)['score'] == .244
    ordinary = routes.order_continuous_route(seed, [destination])
    assert [row['id'] for row in add_measured_bridges(seed, ordinary, pool)] == ['target']
