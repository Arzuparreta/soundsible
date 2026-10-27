"""Revalidate the final production analyser/cache/HTTP on frozen P12 inputs.

Uses local audio and the existing HTTP test fixture, with provider lookups and
background acquisition disabled. Analysis is real, never injected into SQLite.
The runtime, SQLite and generated long recording are disposable; the station's
data is never opened. Run in a separate process, with prepared model weights:

  python -I docs/dj/detector_comparison/final_pipeline.py LAB OUTPUT.json
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from docs.dj.detector_comparison.common import scratch, write_json
from docs.dj.detector_comparison.integrated_probe import frozen_manifest, provenance


def run(lab):
    references = Path(__file__).parent / 'results'
    aac_path, wav_path = lab / 'corpus/aac.json', lab / 'corpus/manifest.json'
    aac = frozen_manifest(aac_path, references / 'aac-references.json')
    wav = frozen_manifest(wav_path, references / 'manifest-references.json')
    ids = ['synthetic_uniform_pulse', 'synthetic_change_aligned', 'synthetic_change_unaligned']
    cases = {c['id']: c for c in aac['cases']}
    cases.update({c['id']: c for c in wav['cases'] if c['id'] in ids})
    target = 'aac_synthetic_4_2_plain'
    pairs = [(key, target) for key in cases]
    pairs += [(target, 'aac_synthetic_2_3_slow'), ('aac_synthetic_2_3_slow', target)]
    with tempfile.TemporaryDirectory(prefix='p12-final-', dir=scratch(lab)) as temporary:
        temp = Path(temporary)
        env = {f'SOUNDSIBLE_{kind}_DIR': str(temp / kind.lower())
               for kind in ('CONFIG', 'DATA', 'CACHE', 'LOG', 'MUSIC')}
        with patch.dict(os.environ, env):
            sys.path.insert(0, str(ROOT / 'tests'))
            import test_discovery_save_route as fixture
            from shared import dj_engine
            from shared.dj import contracts, store, timing, weights
            from shared.hardening import _reset_rate_limits_for_tests
            from shared.runtime import reset_runtime
            from shared.user_context import bind_user, unbind_user

            fixture._make_runtime(temp)
            token = bind_user('p12-final-validation')
            try:
                if weights.model_path(download=False) is None:
                    raise RuntimeError('Prepare verified model weights before measuring')
                refs = {key: dict(id=key, track_id=key, title=key, artist='P12 final validation', duration=case['duration'])
                        for key, case in cases.items()}
                paths = {key: Path(case['file']) for key, case in cases.items()}
                api = fixture._mock_api()
                api['get_core'].return_value = (fixture._FakeLibrary(None), None, None)
                auto = fixture._auto_mode
                database = temp / 'analysis.sqlite3'
                with (patch.object(store, '_cache_path', return_value=database),
                      patch.object(auto, '_get_api', return_value=api),
                      patch.object(auto, '_dj_source_path', side_effect=lambda _, item: paths[item['id']]),
                      patch.object(auto, 'request_analysis'),
                      patch.object(auto, '_planner_context_related', return_value=auto._GraphWalk([], False, False)),
                      patch('shared.preview_cache.request_prefetch', return_value=[])):
                    client = fixture._make_app().test_client()
                    # Matching content stamps must not promote the previous version.
                    with store._connect() as connection:
                        for key in cases:
                            connection.execute('INSERT INTO audio_analysis VALUES (?, ?, ?, ?, ?)',
                                (dj_engine.analysis_identity(refs[key]), store._source_stamp(paths[key]),
                                 contracts.ANALYSER_VERSION - 1, json.dumps({'analysed': True, 'bpm': 120}), 0))
                    for outgoing, incoming in pairs:
                        _reset_rate_limits_for_tests()
                        response = client.post('/api/discovery/music/dj-transition',
                                               json={'from': refs[outgoing], 'to': refs[incoming]})
                        assert response.status_code == 200
                        cold = response.get_json()
                        assert cold['measured'] is False
                        assert cold['transition']['sync']['alignment'] == 'none'

                    analyses = {}
                    with patch.object(store, '_decode_measured', wraps=store._decode_measured) as decode:
                        for key in cases:
                            measured = dj_engine.analyse_audio(paths[key], dj_engine.analysis_identity(refs[key]))
                            assert measured['analysed'] and measured['version'] == contracts.ANALYSER_VERSION
                            assert dj_engine.cached_analysis(paths[key], dj_engine.analysis_identity(refs[key])) == measured
                            analyses[key] = measured
                        assert decode.call_count == len(cases)
                        decode_count = decode.call_count

                    rows = []
                    with patch.object(store, '_decode_measured', side_effect=AssertionError('Warm path decoded audio')):
                        for outgoing, incoming in pairs:
                            _reset_rate_limits_for_tests()
                            seed, track = refs[outgoing], refs[incoming]
                            refined = client.post('/api/discovery/music/dj-transition', json={'from': seed, 'to': track})
                            assert refined.status_code == 200 and refined.get_json()['measured'] is True
                            expected = refined.get_json()['transition']
                            sizes = {'dj-transition': len(refined.data)}
                            common = dict(seed=seed, limit=1)
                            for endpoint, payload in [
                                ('dj-plan', {**common, 'sources': [{'id': 's', 'tracks': [track]}]}),
                                ('dj-place', {**common, 'track': track, 'requested_queue_id': 'requested'}),
                                ('dj-repair', {**common, 'route': [{**track, 'queue_id': 'requested', 'route_kind': 'user'}]}),
                            ]:
                                response = client.post('/api/discovery/music/' + endpoint, json=payload)
                                assert response.status_code == 200, response.get_json()
                                assert response.get_json()['items'][0]['transition'] == expected, endpoint
                                assert len(response.data) < 256 * 1024
                                if endpoint == 'dj-plan':
                                    assert not {'beat_grid', 'metric_regions'} & response.get_json()['items'][0]['analysis'].keys()
                                sizes[endpoint] = len(response.data)
                            with patch.object(auto, '_build_music_plan', return_value=({'items': [track]}, 200)):
                                legacy = client.post('/api/discovery/music/dj-plan', json=common)
                            assert legacy.status_code == 200 and legacy.get_json()['items'][0]['transition'] == expected
                            sizes['legacy'] = len(legacy.data)
                            for kind, request in [
                                ('track', {'id': 'track-request', 'kind': 'track', 'track': track}),
                                ('artist', {'id': 'artist-request', 'kind': 'artist', 'artist': {'name': track['artist']}}),
                            ]:
                                with (patch.object(auto, '_build_music_plan', return_value=({'items': []}, 200)),
                                      patch.object(auto, '_planner_artist_candidates', return_value=[dict(track)])):
                                    response = client.post('/api/discovery/music/dj-plan',
                                                           json={**common, 'requests': [request]})
                                assert response.status_code == 200, response.get_json()
                                assert response.get_json()['items'][0]['transition'] == expected, kind
                                sizes['request-' + kind] = len(response.data)
                            assert max(sizes.values()) < 256 * 1024
                            if outgoing == 'synthetic_uniform_pulse':
                                assert expected['sync']['alignment'] != 'bars'
                            rows.append(dict(pair=[outgoing, incoming], cold_measured=False, warm_measured=True,
                                             no_warm_decode=True, endpoint_bytes=sizes, transition=expected))
                            print(outgoing, incoming, expected['sync']['alignment'], flush=True)
                        for key in cases:
                            assert dj_engine.analyse_audio(paths[key], dj_engine.analysis_identity(refs[key])) == analyses[key]

                    # A bounded long recording has unknown middle coverage, even
                    # when its repeated content would make arithmetic tempting.
                    source = next(c['file'] for c in wav['cases'] if c['id'] == 'synthetic_4_2_plain')
                    long_path = temp / 'long.wav'
                    subprocess.run([store.ffmpeg_executable(), '-v', 'error', '-stream_loop', '-1', '-i', source,
                                    '-t', '600', '-c:a', 'pcm_s16le', str(long_path)], check=True)
                    with patch.object(store, '_decode_measured', wraps=store._decode_measured) as decode:
                        long = dj_engine.analyse_audio(long_path, 'p12-long')
                        assert decode.call_count == 2
                        windows = [dict(start=call.kwargs.get('start', 0), length=call.kwargs['length'])
                                   for call in decode.call_args_list]
                    assert long['analysed'] and long['duration'] == 600
                    assert all(r['end'] <= 90.001 or r['start'] >= 479.999 for r in long['metric_regions'])
                    assert not any(90 < t < 480 for t in long['beat_grid'])
                    period = 60 / long['bpm']
                    gap = timing.metric_sync(long, long, 300, 300, 8, 1, period, period)
                    assert gap['alignment'] == 'none'
                    return dict(provenance=provenance(aac_path, references / 'aac-references.json'),
                                boundary='Local files -> real production analysis -> isolated SQLite -> HTTP test client; providers/acquisition stubbed',
                                previous_version_rejected=True, cold_pairs=len(pairs), decode_calls=decode_count,
                                analyses=analyses, rows=rows,
                                long_recording=dict(duration=long['duration'], decode_windows=windows,
                                                    metric_regions=long['metric_regions'], gap_sync=gap))
            finally:
                unbind_user(token)
                reset_runtime()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lab', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    write_json(args.output, run(args.lab))
