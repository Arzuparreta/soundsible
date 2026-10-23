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
