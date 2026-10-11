from flask import Flask
import pytest

from shared.api.routes import playback as playback_routes
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


class _FakeSocketIO:
    def __init__(self):
        self.events = []

    def emit(self, event, payload, room=None):
        self.events.append({"event": event, "payload": payload, "room": room})


class _FakeQueue:
    def __init__(self):
        self.consumed = []

    def consume_head_if_id(self, track_id):
        self.consumed.append(track_id)


class _FakeTrack:
    id = "t1"
    title = "Track One"

    def to_dict(self):
        return {"id": self.id, "title": self.title, "artist": "Artist", "album": "Album"}


def _make_runtime(tmp_path):
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=True,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        path.mkdir(parents=True, exist_ok=True)


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(playback_routes.playback_bp)
    return app


def _patch_api(monkeypatch):
    from shared.playback_state import register_device

    socketio = _FakeSocketIO()
    queue = _FakeQueue()
    states = {}
    device = {
        "device_id": "ios-car-client",
        "device_name": "iPhone",
        "device_type": "ios",
        "active_sid": "sid-1",
    }

    def get_state(_scope, exclude_device_id=None, device_id=None):
        return states.get(device_id or "default")

    def put_state(_scope, state):
        states[state.get("device_id") or "default"] = dict(state)

    def fake_get_api():
        return {
            "get_core": lambda: (None, None, queue),
            "get_track_by_id": lambda _lib, track_id: _FakeTrack() if track_id == "t1" else None,
            "socketio": socketio,
            "get_downloader": lambda open_browser=False: None,
            "is_trusted_network": lambda remote_addr: True,
            "is_safe_path": lambda path, is_trusted=False: True,
            "WEB_UI_PATH": None,
            "get_playback_state": get_state,
            "put_playback_state": put_state,
            "get_scope_from_request": lambda: "default",
            "register_device": register_device,
            "get_registered_device": lambda scope, device_id: device if device_id == device["device_id"] else None,
            "list_registered_devices": lambda scope: [device],
        }

    monkeypatch.setattr(playback_routes, "_get_api", fake_get_api)
    return socketio, queue, states


def test_remote_previous_command_emits_previous_event(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    socketio, _, _ = _patch_api(monkeypatch)

    response = _make_app().test_client().post(
        "/api/playback/remote-command",
        json={"device_id": "ios-car-client", "command": "previous"},
    )

    assert response.status_code == 200
    assert response.get_json()["command"] == "previous"
    assert socketio.events == [
        {
            "event": "playback_previous_requested",
            "payload": {},
            "room": "playback:default:ios-car-client",
        }
    ]


def test_remote_command_accepts_ios_device_registration(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)

    response = _make_app().test_client().post(
        "/api/devices/register",
        json={"device_id": "ios-car-client", "device_name": "iPhone", "device_type": "ios"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "registered"
    assert body["device"]["device_type"] == "ios"


def test_remote_play_command_writes_track_payload_for_native_clients(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    socketio, queue, states = _patch_api(monkeypatch)

    response = _make_app().test_client().post(
        "/api/playback/remote-command",
        json={"device_id": "ios-car-client", "command": "play", "track_id": "t1", "position_sec": 12},
    )

    assert response.status_code == 200
    assert queue.consumed == ["t1"]
    assert states["ios-car-client"]["track"]["title"] == "Track One"
    assert states["ios-car-client"]["position_sec"] == 12
    assert socketio.events[0]["event"] == "playback_start_requested"
    assert socketio.events[0]["payload"]["track"]["id"] == "t1"


def test_remote_pause_then_resume_preserves_track_position_and_session(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    socket, _, states = _patch_api(monkeypatch)
    original = {'device_id': 'ios-car-client', 'track_id': 't1', 'track': _FakeTrack().to_dict(),
                'position_sec': 42, 'is_playing': True, 'session': {'v': 1, 'queue': [{'id': 't1', 'queueId': 'occurrence'}]}}
    states['ios-car-client'] = original
    client = _make_app().test_client()
    assert client.post('/api/playback/remote-command', json={'device_id': 'ios-car-client', 'command': 'pause'}).status_code == 200
    paused = states['ios-car-client']
    assert paused['track_id'] == 't1'
    assert paused['position_sec'] == 42
    assert paused['session'] == original['session']
    assert paused['is_playing'] is False
    assert client.post('/api/playback/remote-command', json={'device_id': 'ios-car-client', 'command': 'play'}).status_code == 200
    assert socket.events[-1]['payload']['state']['session'] == original['session']


def test_device_list_exposes_live_socket_flag_for_shared_clients(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    response = _make_app().test_client().get('/api/devices')
    assert response.status_code == 200
    assert response.get_json()['devices'][0]['socket_active'] is True


def test_start_event_distinguishes_handoff_from_transport_resume():
    socket = _FakeSocketIO()
    api = {'socketio': socket}
    playback_routes._emit_playback_start(api, 'member', 'android', {'session': {}}, handoff=True)
    playback_routes._emit_playback_start(api, 'member', 'android', {'session': {}})
    assert socket.events[0]['payload']['handoff'] is True
    assert 'handoff' not in socket.events[1]['payload']


@pytest.mark.parametrize("track", [
    {"id": "dQw4w9WgXcQ", "title": "Stream", "artist": "Artist", "source": "preview", "originKeys": ["deezer:42"]},
    {"id": "episode", "title": "Episode", "artist": "Show", "source": "preview", "media_kind": "podcast_episode",
     "podcast_episode_guid": "episode", "podcast_feed_id": "feed", "podcast_enclosure_url": "https://example.com/episode.mp3"},
    {"id": "deezer:42", "title": "Unmatched", "artist": "Artist", "source": "preview",
     "pendingResolve": {"catalogItemId": "deezer:42", "title": "Unmatched", "artist": "Artist"}},
])
def test_remote_play_relays_portable_elements_without_library_files(tmp_path, monkeypatch, track):
    reset_runtime()
    _make_runtime(tmp_path)
    socket, queue, states = _patch_api(monkeypatch)
    # URL DNS safety is tested in the podcast suite; this fixture never accesses the network.
    monkeypatch.setattr("shared.podcast_rss.assert_safe_http_url", lambda url: None)
    states['ios-car-client'] = {'track_id': 't1', 'session': {'v': 1, 'mode': 'auto'}}
    response = _make_app().test_client().post('/api/playback/remote-command', json={
        'device_id': 'ios-car-client', 'command': 'play', 'track_id': track['id'], 'track': track,
    })
    assert response.status_code == 200
    assert queue.consumed == []
    sent = socket.events[0]
    assert sent['room'] == 'playback:default:ios-car-client'
    assert sent['payload']['track'].items() >= track.items()
    assert sent['payload']['state']['session'] is None
    assert states['ios-car-client']['track']['source'] == 'preview'


@pytest.mark.parametrize("track", [
    None, [], {}, {"id": 1}, {"id": "x", "source": "live"},
    {"id": "invalid", "source": "preview"},
    {"id": "episode", "source": "preview", "media_kind": "podcast_episode"},
    {"id": "pending", "source": "preview", "pendingResolve": {"title": "Song"}},
    {"id": "dQw4w9WgXcQ", "source": "preview", "title": "x" * 33000},
])
def test_remote_play_rejects_invalid_elements_without_changing_state(tmp_path, monkeypatch, track):
    reset_runtime()
    _make_runtime(tmp_path)
    socket, queue, states = _patch_api(monkeypatch)
    response = _make_app().test_client().post('/api/playback/remote-command', json={
        'device_id': 'ios-car-client', 'command': 'play', 'track': track,
    })
    assert response.status_code == 400
    assert not socket.events and not states and not queue.consumed


def test_remote_play_uses_canonical_library_metadata_and_drops_device_urls(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    socket, _, _ = _patch_api(monkeypatch)
    client = _make_app().test_client()
    response = client.post('/api/playback/remote-command', json={
        'device_id': 'ios-car-client', 'command': 'play',
        'track': {'id': 't1', 'title': 'Spoofed', 'url': 'file:///secret', 'path': '/secret'},
    })
    assert response.status_code == 200
    assert socket.events[-1]['payload']['track'] == _FakeTrack().to_dict()
    response = client.post('/api/playback/remote-command', json={
        'device_id': 'ios-car-client', 'command': 'play',
        'track': {'id': 'dQw4w9WgXcQ', 'source': 'preview', 'previewUrl': 'file:///secret', 'stream_token': 'sender-token'},
    })
    assert response.status_code == 200
    assert 'previewUrl' not in socket.events[-1]['payload']['track']
    assert 'stream_token' not in socket.events[-1]['payload']['track']


def test_remote_play_does_not_relay_to_a_device_outside_the_scope(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    socket, _, states = _patch_api(monkeypatch)
    response = _make_app().test_client().post('/api/playback/remote-command', json={
        'device_id': 'someone-elses-device', 'command': 'play',
        'track': {'id': 'dQw4w9WgXcQ', 'source': 'preview'},
    })
    assert response.status_code == 404
    assert not socket.events and not states


@pytest.mark.parametrize("extra", [
    {'track_id': 'another-id'}, {'position_sec': -1}, {'position_sec': 'nan'}, {'position_sec': 'not-a-number'},
])
def test_remote_play_rejects_mismatched_identity_or_invalid_position(tmp_path, monkeypatch, extra):
    reset_runtime()
    _make_runtime(tmp_path)
    socket, _, states = _patch_api(monkeypatch)
    response = _make_app().test_client().post('/api/playback/remote-command', json={
        'device_id': 'ios-car-client', 'command': 'play',
        'track': {'id': 'dQw4w9WgXcQ', 'source': 'preview'}, **extra,
    })
    assert response.status_code == 400
    assert not socket.events and not states


def test_remote_podcast_uses_the_existing_enclosure_safety_gate(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    socket, _, states = _patch_api(monkeypatch)
    def refuse(url):
        raise ValueError('Unsafe enclosure URL')
    monkeypatch.setattr('shared.podcast_rss.assert_safe_http_url', refuse)
    response = _make_app().test_client().post('/api/playback/remote-command', json={
        'device_id': 'ios-car-client', 'command': 'play',
        'track': {'id': 'episode', 'source': 'preview', 'media_kind': 'podcast_episode', 'podcast_enclosure_url': 'http://127.0.0.1/private'},
    })
    assert response.status_code == 400
    assert not socket.events and not states
