from flask import Flask

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
