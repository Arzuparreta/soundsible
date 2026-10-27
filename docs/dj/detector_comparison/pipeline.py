"""AAC -> experimental backend output -> #394 SQLite -> actual HTTP planners.

Run with the application environment and a pinned #394 snapshot. Backends run
outside production; inject their normalized results at the SQLite boundary in
a disposable runtime. This does not install a new detector in the application.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

from .common import scratch, write_json
from .normalize import to_analysis


def probe(root):
    snapshot = root/'snapshots/2ca8ccf2'
    with tempfile.TemporaryDirectory(prefix='dj-detector-pipeline-', dir=scratch(root)) as temporary:
        temp = Path(temporary)
        for kind in ['CONFIG', 'DATA', 'CACHE', 'LOG', 'MUSIC']:
            os.environ[f'SOUNDSIBLE_{kind}_DIR'] = str(temp/kind.lower())
        sys.path[:0] = [str(snapshot), str(snapshot/'tests')]
        import test_discovery_save_route as fixture
        from shared.dj import contracts, store
        from shared import dj_engine
        from shared.hardening import _reset_rate_limits_for_tests
        from shared.user_context import bind_user, unbind_user
        from shared.runtime import reset_runtime
        fixture._make_runtime(temp)
        token = bind_user('detector-experiment')
        manifest = json.loads((root/'corpus/aac.json').read_text())
        cases = {c['id']: c for c in manifest['cases']}
        wav_ids = ['synthetic_uniform_pulse', 'synthetic_change_aligned', 'synthetic_change_unaligned']
        cases.update({c['id']: c for c in json.loads((root/'corpus/manifest.json').read_text())['cases']
                      if c['id'] in wav_ids})
        pairs = [('aac_synthetic_4_2_plain', 'aac_synthetic_4_2_plain'),
                 ('aac_synthetic_3_2_plain', 'aac_synthetic_4_2_plain'),
                 ('aac_synthetic_2_3_plain', 'aac_synthetic_4_2_plain'),
                 ('aac_synthetic_2_3_slow', 'aac_synthetic_4_2_plain'),
                 ('aac_gtzan_blues_00000', 'aac_synthetic_4_2_plain')]
        pairs += [(case, 'aac_synthetic_4_2_plain') for case in wav_ids]
        rows = []
        try:
            for directory in sorted((root/'results/aac').glob('*')):
                if not (directory/'metadata.json').exists():
                    continue
                method = directory.name
                for index, (out_id, in_id) in enumerate(pairs):
                    _reset_rate_limits_for_tests()
                    inputs = [(root/'results'/method if case in wav_ids else directory)/(case+'.json')
                              for case in (out_id, in_id)]
                    if not all(p.exists() and not json.loads(p.read_text()).get('failure') for p in inputs):
                        rows.append(dict(method=method, pair=[out_id, in_id], unavailable=True))
                        continue
                    config = hashlib.sha256((method+json.dumps(json.loads((directory/'metadata.json').read_text()), sort_keys=True)).encode()).hexdigest()
                    database = temp/(config+f'-{index}.sqlite3')
                    refs = {key: dict(id=key, track_id=key, title=key, artist='Detector experiment', duration=cases[case]['duration'])
                            for key, case in [('outgoing', out_id), ('incoming', in_id)]}
                    paths = {key: Path(cases[case]['file']) for key, case in [('outgoing', out_id), ('incoming', in_id)]}
                    api = fixture._mock_api()
                    metadata = fixture.LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                    api['get_core'].return_value = (fixture._FakeLibrary(metadata), None, None)
                    auto = fixture._auto_mode
                    with (patch.object(store, '_cache_path', return_value=database),
                          patch.object(auto, '_get_api', return_value=api),
                          patch.object(auto, '_dj_source_path', side_effect=lambda _, item: paths[item['id']]),
                          patch.object(auto, 'request_analysis'),
                          patch.object(auto, '_planner_context_related', return_value=auto._GraphWalk([], False, False)),
                          patch('shared.preview_cache.request_prefetch', return_value=[])):
                        client = fixture._make_app().test_client()
                        pair = {'from': refs['outgoing'], 'to': refs['incoming']}
                        cold = client.post('/api/discovery/music/dj-transition', json=pair)
                        assert cold.status_code == 200 and cold.get_json()['measured'] is False
                        assert cold.get_json()['transition']['sync']['alignment'] == 'none'
                        with store._connect() as connection:
                            for key, file in zip(['outgoing', 'incoming'], inputs):
                                raw = json.loads(file.read_text())['raw']
                                normalized = to_analysis(raw, contracts)
                                connection.execute('INSERT INTO audio_analysis VALUES (?, ?, ?, ?, ?)',
                                    (dj_engine.analysis_identity(refs[key]), store._source_stamp(paths[key]),
                                     contracts.ANALYSER_VERSION, json.dumps(normalized), time.time()))
                        with patch.object(store, '_decode_measured', side_effect=AssertionError('Warm planning decoded audio')):
                            refined = client.post('/api/discovery/music/dj-transition', json=pair)
                            assert refined.status_code == 200 and refined.get_json()['measured'] is True
                            expected = refined.get_json()['transition']
                            common = {'seed': refs['outgoing']}
                            endpoints = []
                            for endpoint, payload in [
                                ('dj-plan', {**common, 'sources': [{'id': 's', 'tracks': [refs['incoming']]}], 'limit': 1}),
                                ('dj-place', {**common, 'track': refs['incoming'], 'requested_queue_id': 'requested'}),
                                ('dj-repair', {**common, 'route': [{**refs['incoming'], 'queue_id': 'requested', 'route_kind': 'user'}]})]:
                                response = client.post('/api/discovery/music/'+endpoint, json=payload)
                                assert response.status_code == 200, response.get_json()
                                assert response.get_json()['items'][0]['transition'] == expected, endpoint
                                assert len(response.data) < 256*1024
                                if endpoint == 'dj-plan':
                                    assert not {'metric_regions', 'beat_grid'} & response.get_json()['items'][0]['analysis'].keys()
                                endpoints.append(endpoint)
                            with patch.object(auto, '_build_music_plan', return_value=({'items': [refs['incoming']]}, 200)):
                                legacy = client.post('/api/discovery/music/dj-plan', json={**common, 'limit': 1})
                            assert legacy.get_json()['items'][0]['transition'] == expected
                            for kind, requested in [
                                ('track', {'id': 'request-track', 'track': refs['incoming']}),
                                ('artist', {'id': 'request-artist', 'kind': 'artist', 'artist': {'name': 'Detector experiment'}})]:
                                with (patch.object(auto, '_build_music_plan', return_value=({'items': []}, 200)),
                                      patch.object(auto, '_planner_artist_candidates', return_value=[dict(refs['incoming'])])):
                                    requested_response = client.post('/api/discovery/music/dj-plan',
                                        json={**common, 'requests': [requested], 'limit': 1})
                                assert requested_response.status_code == 200, requested_response.get_json()
                                assert requested_response.get_json()['items'][0]['transition'] == expected, kind
                                endpoints.append('request-'+kind)
                        rows.append(dict(method=method, pair=[out_id, in_id], cold_measured=False, warm_measured=True,
                                         no_warm_decode=True, compact=True, endpoint_equivalence=endpoints+['legacy', 'dj-transition'],
                                         input_formats=['WAV' if case in wav_ids else 'AAC' for case in (out_id, in_id)],
                                         bar_claim_on_unidentifiable_first=(expected['sync'].get('alignment') == 'bars') if out_id == 'synthetic_uniform_pulse' else None,
                                         transition=expected, confidence_policy='native P12 or explicit zero for absent evidence'))
                    print(method, out_id, expected['sync'].get('alignment'), flush=True)
        finally:
            unbind_user(token)
            reset_runtime()
        write_json(root/'pipeline-results.json', dict(snapshot='2ca8ccf2', results=rows,
                    boundary='Backend output injected into isolated SQLite; production acquisition is unchanged.'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    probe(parser.parse_args().root)
