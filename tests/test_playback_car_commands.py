from flask import Flask
import pytest

from shared import playback_state
from shared.api.routes import playback as playback_routes
from shared.remote.dispatcher import send_command
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


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
    playback_state.reset_state()
    delivered = []

    playback_state.register_socket_instance(
        "default",
        "ios-car-client",
        "sid-1",
        device_name="iPhone",
        device_type="ios",
        form_factor="phone",
        instance_id="inst-1",
        protocol=1,
        commands=[
            "transport.play",
            "transport.pause",
            "transport.next",
            "transport.previous",
            "transport.seek",
            "play.tracks",
        ],
    )

    def fake_deliver(sid, payload, timeout):
        delivered.append({"sid": sid, "payload": payload, "timeout": timeout})
        return {"status": "applied", "rev": len(delivered)}

    def fake_send_command(scope, device_id, name, args=None, *, allow_internal=False):
        return send_command(scope, device_id, name, args, allow_internal=allow_internal, deliver=fake_deliver)

    def fake_get_api():
        return {
            "get_library": lambda: None,
            "get_track_by_id": lambda _lib, track_id: _FakeTrack() if track_id == "t1" else None,
            "get_downloader": lambda open_browser=False: None,
            "is_trusted_network": lambda remote_addr: True,
            "is_safe_path": lambda path, is_trusted=False: True,
            "WEB_UI_PATH": None,
            "get_playback_state": playback_state.get_state,
            "put_playback_state": playback_state.put_state,
            "get_scope_from_request": lambda: "default",
            "register_device": playback_state.register_device,
            "get_registered_device": playback_state.get_registered_device,
            "list_registered_devices": playback_state.list_registered_devices,
            "send_command": fake_send_command,
            "transfer_playback": lambda scope, src, dst: (400, {"status": "rejected", "reason": "invalid"}),
        }

    monkeypatch.setattr(playback_routes, "_get_api", fake_get_api)
    return delivered


def test_remote_previous_command_dispatches_transport_previous(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    delivered = _patch_api(monkeypatch)

    response = _make_app().test_client().post(
        "/api/playback/remote-command",
        json={"device_id": "ios-car-client", "command": "previous"},
    )

    assert response.status_code == 200
    assert response.get_json() == {"status": "applied", "rev": 1}
    assert delivered == [
        {
            "sid": "sid-1",
            "payload": {"name": "transport.previous", "args": {}},
            "timeout": 5.0,
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


def test_remote_play_command_dispatches_track_without_writing_state(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    delivered = _patch_api(monkeypatch)

    response = _make_app().test_client().post(
        "/api/playback/remote-command",
        json={"device_id": "ios-car-client", "command": "play", "track_id": "t1", "position_sec": 12},
    )

    assert response.status_code == 200
    assert response.get_json() == {"status": "applied", "rev": 1}
    assert delivered[0]["payload"] == {
        "name": "play.tracks",
        "args": {"tracks": [_FakeTrack().to_dict()], "index": 0},
    }
    assert playback_state.get_state("default", device_id="ios-car-client") is None


def test_remote_pause_then_resume_does_not_mutate_stored_state(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    delivered = _patch_api(monkeypatch)
    original = {
        "device_id": "ios-car-client",
        "track_id": "t1",
        "track": _FakeTrack().to_dict(),
        "position_sec": 42,
        "is_playing": True,
        "session": {"v": 1, "queue": [{"id": "t1", "queueId": "occurrence"}]},
    }
    playback_state.put_state("default", original)
    client = _make_app().test_client()

    pause_resp = client.post("/api/playback/remote-command", json={"device_id": "ios-car-client", "command": "pause"})
    assert pause_resp.status_code == 200
    assert delivered[-1]["payload"] == {"name": "transport.pause", "args": {}}
    stored = playback_state.get_state("default", device_id="ios-car-client")
    assert stored["is_playing"] is True
    assert stored["session"] == original["session"]

    play_resp = client.post("/api/playback/remote-command", json={"device_id": "ios-car-client", "command": "play"})
    assert play_resp.status_code == 200
    assert delivered[-1]["payload"] == {"name": "transport.play", "args": {}}


def test_device_list_exposes_online_and_socket_active_for_shared_clients(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    response = _make_app().test_client().get("/api/devices")
    assert response.status_code == 200
    body = response.get_json()
    assert isinstance(body["server_now_ms"], int)
    assert body["devices"][0]["online"] is True
    assert body["devices"][0]["socket_active"] is True


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
    delivered = _patch_api(monkeypatch)
    # URL DNS safety is tested in the podcast suite; this fixture never accesses the network.
    monkeypatch.setattr("shared.podcast_rss.assert_safe_http_url", lambda url: None)
    response = _make_app().test_client().post("/api/playback/remote-command", json={
        "device_id": "ios-car-client", "command": "play", "track_id": track["id"], "track": track,
    })
    assert response.status_code == 200
    sent = delivered[0]
    assert sent["sid"] == "sid-1"
    assert sent["payload"]["name"] == "play.tracks"
    assert sent["payload"]["args"]["tracks"][0].items() >= track.items()
    assert playback_state.get_state("default", device_id="ios-car-client") is None


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
    delivered = _patch_api(monkeypatch)
    response = _make_app().test_client().post("/api/playback/remote-command", json={
        "device_id": "ios-car-client", "command": "play", "track": track,
    })
    assert response.status_code == 400
    assert response.get_json() == {"status": "rejected", "reason": "invalid"}
    assert not delivered


def test_remote_play_uses_canonical_library_metadata_and_drops_device_urls(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    delivered = _patch_api(monkeypatch)
    client = _make_app().test_client()
    response = client.post("/api/playback/remote-command", json={
        "device_id": "ios-car-client", "command": "play",
        "track": {"id": "t1", "title": "Spoofed", "url": "file:///secret", "path": "/secret"},
    })
    assert response.status_code == 200
    assert delivered[-1]["payload"]["args"]["tracks"][0] == _FakeTrack().to_dict()
    response = client.post("/api/playback/remote-command", json={
        "device_id": "ios-car-client", "command": "play",
        "track": {"id": "dQw4w9WgXcQ", "source": "preview", "previewUrl": "file:///secret", "stream_token": "sender-token"},
    })
    assert response.status_code == 200
    sent_track = delivered[-1]["payload"]["args"]["tracks"][0]
    assert "previewUrl" not in sent_track
    assert "stream_token" not in sent_track


def test_remote_play_does_not_relay_to_a_device_outside_the_scope(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    delivered = _patch_api(monkeypatch)
    response = _make_app().test_client().post("/api/playback/remote-command", json={
        "device_id": "someone-elses-device", "command": "play",
        "track": {"id": "dQw4w9WgXcQ", "source": "preview"},
    })
    assert response.status_code == 404
    assert response.get_json() == {"status": "rejected", "reason": "unknown_device"}
    assert not delivered


@pytest.mark.parametrize("extra", [
    {"track_id": "another-id"}, {"position_sec": -1}, {"position_sec": "nan"}, {"position_sec": "not-a-number"},
])
def test_remote_play_rejects_mismatched_identity_or_invalid_position(tmp_path, monkeypatch, extra):
    reset_runtime()
    _make_runtime(tmp_path)
    delivered = _patch_api(monkeypatch)
    response = _make_app().test_client().post("/api/playback/remote-command", json={
        "device_id": "ios-car-client", "command": "play",
        "track": {"id": "dQw4w9WgXcQ", "source": "preview"}, **extra,
    })
    assert response.status_code == 400
    assert response.get_json() == {"status": "rejected", "reason": "invalid"}
    assert not delivered


def test_remote_podcast_uses_the_existing_enclosure_safety_gate(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    delivered = _patch_api(monkeypatch)

    def refuse(url):
        raise ValueError("Unsafe enclosure URL")

    monkeypatch.setattr("shared.podcast_rss.assert_safe_http_url", refuse)
    response = _make_app().test_client().post("/api/playback/remote-command", json={
        "device_id": "ios-car-client", "command": "play",
        "track": {"id": "episode", "source": "preview", "media_kind": "podcast_episode", "podcast_enclosure_url": "http://127.0.0.1/private"},
    })
    assert response.status_code == 400
    assert response.get_json() == {"status": "rejected", "reason": "invalid"}
    assert not delivered
