import pytest
from flask import Flask, jsonify

from scripts.android_dj_fixture import install_refinement


def test_refinement_fixture_is_bounded_isolated_and_returns_measured_on_third_attempt():
    app = Flask(__name__)
    install_refinement(app)
    @app.post('/api/discovery/music/dj-plan')
    def plan():
        return jsonify(items=[{'id': 'member-pcm-loud'}])
    @app.post('/api/discovery/music/dj-transition')
    def transition():
        return jsonify(real=True)
    client = app.test_client()
    headers = {'X-Android-Fixture': 'isolated'}
    assert client.post('/__fixture/dj-refinement', json={'pending': 2}).status_code == 403
    assert client.post('/__fixture/dj-refinement', headers=headers, json={'pending': 4}).status_code == 400
    assert client.post('/__fixture/dj-refinement', headers=headers, json={'pending': 2}).status_code == 200
    body = client.post('/api/discovery/music/dj-plan', json={'seed': {'id': 'member-pcm-soft'}}).get_json()
    assert body['items'][0]['transition']['confidence'] == .18
    ref = {'from': {'id': 'member-pcm-soft'}}
    assert [client.post('/api/discovery/music/dj-transition', json=ref).get_json()['measured'] for _ in range(3)] == [False, False, True]
    assert client.post('/api/discovery/music/dj-transition', json={'from': {'id': 'other'}}).get_json() == {'real': True}
    assert client.get('/__fixture/dj-refinement', headers=headers).get_json()['calls'] == 3
    client.post('/__fixture/dj-refinement', headers=headers, json={'active': False})
    assert client.post('/api/discovery/music/dj-transition', json=ref).get_json() == {'real': True}


def test_shared_tempo_fixture_writes_known_clicks_and_counts_split_clients(tmp_path):
    import wave
    import numpy as np
    from scripts.android_dj_fixture import SHARED_TEMPO, install_shared_tempo, shared_tempo_plan
    from shared.dj.timing import deck_rates, split_rates

    tracks = tmp_path / 'music/tracks'
    tracks.mkdir(parents=True)
    for name, rate, channels, seconds in (('member-pcm-soft', 16000, 1, 90), ('member-pcm-loud', 48000, 2, 60)):
        with wave.open(str(tracks / f'{name}.wav'), 'wb') as output:
            output.setnchannels(channels)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(b'\0\0' * channels * rate * seconds)
    app = Flask(__name__)
    install_shared_tempo(app, tmp_path)

    @app.post('/api/discovery/music/dj-plan')
    def plan():
        return jsonify(items=[{'id': 'member-pcm-loud', 'transition': {'technique': 'safe_fade'}}])

    client = app.test_client()
    headers = {'X-Android-Fixture': 'isolated'}
    assert client.post('/__fixture/dj-shared-tempo').status_code == 403
    assert client.post('/__fixture/dj-shared-tempo', headers=headers).status_code == 200
    for name, bpm, tone in (('member-pcm-soft', 120, 1000), ('member-pcm-loud', 132, 3000)):
        with wave.open(str(tracks / f'{name}.wav'), 'rb') as source:
            rate, channels = source.getframerate(), source.getnchannels()
            pcm = np.frombuffer(source.readframes(source.getnframes()), '<i2').reshape(-1, channels)[:, 0]
        kicks = np.flatnonzero((np.abs(pcm[1:]) > 4000) & (np.abs(pcm[:-1]) <= 4000))
        starts = kicks[np.insert(np.diff(kicks) > rate * .1, 0, True)] / rate
        assert np.allclose(np.diff(starts[:20]), 60 / bpm, atol=.002)
        assert starts[0] == pytest.approx(SHARED_TEMPO['first'], abs=.003)
    body = client.post('/api/discovery/music/dj-plan', json={'seed': {'id': 'member-pcm-soft'}},
                       headers={'X-Soundsible-Dj-Rates': 'split'}).get_json()
    assert body['items'][0]['transition'] == shared_tempo_plan()
    client.post('/api/discovery/music/dj-plan', json={'seed': {'id': 'member-pcm-soft'}})
    state = client.get('/__fixture/dj-shared-tempo', headers=headers).get_json()
    assert (state['split_requests'], state['other_requests']) == (1, 1)
    # The same speeds the engine plans for this pair.
    transition = shared_tempo_plan()
    with split_rates(True):
        out, _ = deck_rates(transition['playback_rate'])
    assert out == pytest.approx(transition['out_playback_rate'], abs=1e-6)
