"""Tests for the remote-control engine contract: registry, instances, live events, dispatcher, transfer, wrappers and agent API."""

from __future__ import annotations

import hashlib
from unittest.mock import patch

import pytest
from flask import Flask
from socketio.exceptions import DisconnectedError, TimeoutError as SocketIOTimeoutError

from shared import playback_state
from shared.api import app as main_app
from shared.api import on_playback_register, on_socket_disconnect, on_unwatch_device, on_watch_device
from shared.api.routes import agent as agent_routes
from shared.api.routes import playback as playback_routes
from shared.database import instance_db
from shared.hardening import SCOPE_PLAYBACK_CONTROL
from shared.remote.dispatcher import (
    DEFAULT_COMMAND_TIMEOUT_SEC,
    IMPORT_COMMAND_TIMEOUT_SEC,
    send_command,
    transfer_playback,
)
from shared.remote.validator import bound_track, load_registry, validate_command
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _configure_runtime(tmp_path):
    reset_runtime()
    playback_state.reset_state()
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
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)
    configure_runtime(runtime)
    return runtime


def _make_playback_app():
    app = Flask(__name__)
    app.register_blueprint(playback_routes.playback_bp)
    return app


def _make_agent_app():
    app = Flask(__name__)
    app.register_blueprint(agent_routes.agent_bp)
    return app


def _mint_agent_token(scopes=(SCOPE_PLAYBACK_CONTROL,)):
    from shared.user_context import current_user_id

    raw = "remote-test-agent-token"
    instance_db().create_auth_token(
        "tok-remote-test",
        hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        kind="agent",
        scopes=list(scopes),
        name="Test Agent",
        device_type="agent",
        user_id=current_user_id() or "testuser",
    )
    return raw


class _FakeTrack:
    def __init__(self, track_id="t1", title="One More Time", artist="Daft Punk"):
        self.id = track_id
        self.title = title
        self.artist = artist

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": "Discovery",
            "path": "/music/secret.mp3",
            "url": "file:///music/secret.mp3",
        }


class _FakeLibrary:
    def __init__(self, tracks):
        self._tracks = {t.id: t for t in tracks}

    def search(self, query):
        q = query.lower()
        return [t for t in self._tracks.values() if q in t.title.lower() or q in t.artist.lower()]

    def get(self, track_id):
        return self._tracks.get(track_id)


# ---------------------------------------------------------------------------
# 1. Registry & argument validation
# ---------------------------------------------------------------------------


def test_registry_matches_contract_commands_and_protocol():
    reg = load_registry()
    assert reg["protocol"] == 1
    expected = {
        "transport.play",
        "transport.pause",
        "transport.next",
        "transport.previous",
        "transport.seek",
        "transport.set_shuffle",
        "transport.set_repeat",
        "transport.set_volume",
        "transport.set_muted",
        "play.tracks",
        "queue.add",
        "queue.move",
        "queue.remove",
        "queue.play_entry",
        "radio.start",
        "radio.stop",
        "dj.start",
        "dj.start_from_current",
        "dj.stop",
        "dj.place",
        "dj.promote",
        "dj.avoid",
        "dj.add_source",
        "dj.remove_source",
        "dj.change_session",
        "dj.repair",
        "dj.set_mixing",
        "session.export",
        "session.import",
        "session.release",
    }
    assert set(reg["commands"].keys()) == expected


@pytest.mark.parametrize("name,args", [
    ("transport.play", {}),
    ("transport.pause", None),
    ("transport.seek", {"position_sec": 0}),
    ("transport.seek", {"position_sec": 42.5}),
    ("transport.set_shuffle", {"on": True}),
    ("transport.set_repeat", {"mode": "off"}),
    ("transport.set_repeat", {"mode": "all"}),
    ("transport.set_repeat", {"mode": "one"}),
    ("transport.set_volume", {"level": 0}),
    ("transport.set_volume", {"level": 0.75}),
    ("transport.set_volume", {"level": 1}),
    ("transport.set_muted", {"on": True}),
    ("transport.set_muted", {"on": False}),
    ("play.tracks", {"tracks": [{"id": "t1", "title": "Song"}], "index": 0}),
    (
        "play.tracks",
        {
            "tracks": [{"id": "t1"}, {"id": "dQw4w9WgXcQ", "source": "preview"}],
            "index": 1,
            "context": {"id": "pl-1", "kind": "playlist", "label": "Mix", "cover": "/c.jpg", "destination": "/p/1"},
        },
    ),
    ("queue.add", {"track": {"id": "t1"}, "at": "next"}),
    ("queue.add", {"track": {"id": "t1"}, "at": "end"}),
    ("queue.move", {"queue_id": "q1"}),
    ("queue.move", {"queue_id": "q1", "before_queue_id": None}),
    ("queue.move", {"queue_id": "q1", "before_queue_id": "q2"}),
    ("queue.remove", {"queue_id": "q1"}),
    ("queue.play_entry", {"queue_id": "q1"}),
    ("radio.start", {"track": {"id": "t1"}}),
    ("radio.stop", {}),
    ("dj.start", {"tracks": [{"id": "t1"}], "label": "Chill"}),
    ("dj.place", {"tracks": [{"id": "t1"}], "before_queue_id": "q2"}),
    ("dj.promote", {"queue_id": "q1"}),
    ("dj.avoid", {"queue_id": "q1"}),
    ("dj.add_source", {"tracks": [{"id": "t1"}], "label": "Radiohead"}),
    ("dj.remove_source", {"source_id": "src-1"}),
    ("dj.change_session", {"tracks": [{"id": "t1"}], "label": "New"}),
    ("dj.repair", {}),
    ("dj.set_mixing", {"on": False}),
])
def test_validate_command_accepts_good_arguments(name, args):
    validated_name, validated_args = validate_command(name, args)
    assert validated_name == name
    assert isinstance(validated_args, dict)


@pytest.mark.parametrize("name,args", [
    ("unknown.cmd", {}),
    (123, {}),
    ("transport.play", "not-a-dict"),
    ("transport.play", {"extra": 1}),
    ("transport.seek", {}),
    ("transport.seek", {"position_sec": True}),
    ("transport.seek", {"position_sec": float("nan")}),
    ("transport.seek", {"position_sec": float("inf")}),
    ("transport.seek", {"position_sec": -0.1}),
    ("transport.set_shuffle", {"on": 1}),
    ("transport.set_shuffle", {"on": "true"}),
    ("transport.set_repeat", {"mode": "shuffle"}),
    ("transport.set_volume", {"level": -0.01}),
    ("transport.set_volume", {"level": 1.01}),
    ("transport.set_volume", {"level": False}),
    ("transport.set_muted", {"on": 1}),
    ("transport.set_muted", {}),
    ("play.tracks", {"tracks": [], "index": 0}),
    ("play.tracks", {"tracks": [{"id": f"t{i}"} for i in range(501)], "index": 0}),
    ("play.tracks", {"tracks": [{"id": "t1"}], "index": 1}),
    ("play.tracks", {"tracks": [{"id": "t1"}], "index": -1}),
    ("play.tracks", {"tracks": [{"id": "t1"}], "index": True}),
    ("play.tracks", {"tracks": [{"id": "t1"}], "index": 0.0}),
    ("play.tracks", {"tracks": [{"id": "t1"}], "index": 0, "context": {"id": "1", "kind": "album"}}),
    ("play.tracks", {"tracks": [{"id": "t1"}], "index": 0, "context": {"id": "1", "kind": "album", "label": "x" * 4100}}),
    ("queue.add", {"track": {"id": "t1"}, "at": "middle"}),
    ("queue.move", {"queue_id": ""}),
    ("queue.move", {"queue_id": "x" * 129}),
    ("queue.move", {"queue_id": "q1", "before_queue_id": "y" * 129}),
    ("dj.start", {"tracks": [{"id": "t1"}], "label": "x" * 513}),
    ("dj.remove_source", {"source_id": "   "}),
    ("session.export", {}),
    ("session.import", {"state": {"track_id": "t1"}}),
    ("session.release", {}),
])
def test_validate_command_rejects_bad_arguments(name, args):
    with pytest.raises(ValueError):
        validate_command(name, args)


def test_validate_internal_session_commands_and_state_size():
    assert validate_command("session.export", {}, allow_internal=True) == ("session.export", {})
    assert validate_command("session.release", {}, allow_internal=True) == ("session.release", {})
    assert validate_command("session.import", {"state": {"track_id": "t1"}}, allow_internal=True)[0] == "session.import"
    with pytest.raises(ValueError):
        validate_command("session.import", {"state": {"blob": "x" * (256 * 1024 + 10)}}, allow_internal=True)


def test_bound_track_strips_unsafe_fields_and_bounds_preview(monkeypatch):
    monkeypatch.setattr("shared.podcast_rss.assert_safe_http_url", lambda url: None)
    bounded = bound_track({
        "id": "t1",
        "title": "Song",
        "path": "/etc/passwd",
        "url": "file:///secret",
        "stream_token": "tok",
        "duration": 180,
    })
    assert bounded == {"id": "t1", "title": "Song", "duration": 180}

    preview = bound_track({
        "id": "dQw4w9WgXcQ",
        "source": "preview",
        "title": "Video",
        "previewUrl": "https://signed.example/secret",
    })
    assert preview["youtube_id"] == "dQw4w9WgXcQ"
    assert "previewUrl" not in preview

    with pytest.raises(ValueError):
        bound_track({"id": "bad", "source": "preview"})


# ---------------------------------------------------------------------------
# 2. Instances, owning-instance rule, web device_type, form_factor, modes
# ---------------------------------------------------------------------------


def test_two_instances_owning_rule_and_disconnect_fallback(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-1"
    cmds = ["transport.pause", "transport.play"]

    row_a, _ = playback_state.register_socket_instance(
        scope, "browser-1", "sid-a",
        device_name="Firefox · Linux", device_type="web", form_factor="computer",
        instance_id="tab-a", protocol=1, commands=cmds,
    )
    assert row_a["device_type"] == "web"
    assert row_a["form_factor"] == "computer"
    assert row_a["online"] is True
    assert row_a["socket_active"] is True
    assert row_a["protocol"] == 1

    # Second tab registers -> most recently connected becomes owner until a track is published.
    playback_state.register_socket_instance(
        scope, "browser-1", "sid-b",
        device_name="Firefox · Linux", device_type="web", form_factor="computer",
        instance_id="tab-b", protocol=1, commands=["transport.pause"],
    )
    sent_sids = []

    def deliver(sid, payload, timeout):
        sent_sids.append(sid)
        return {"status": "applied", "rev": 1}

    status, _ = send_command(scope, "browser-1", "transport.pause", {}, deliver=deliver)
    assert status == 200
    assert sent_sids == ["sid-b"]

    # Tab A publishes a playing track -> Tab A becomes the owning instance.
    res = playback_state.put_state(scope, {
        "device_id": "browser-1",
        "instance_id": "tab-a",
        "seq": 1,
        "track_id": "t1",
        "track": {"id": "t1", "title": "Track"},
        "position_sec": 12.0,
        "is_playing": True,
    })
    assert res["status"] == "ok" and res["rev"] == 1

    status, _ = send_command(scope, "browser-1", "transport.pause", {}, deliver=deliver)
    assert status == 200
    assert sent_sids == ["sid-b", "sid-a"]

    # Tab A disconnects -> device stays online and owner falls back to Tab B.
    updated = playback_state.unregister_socket("sid-a")
    assert updated is not None
    _, row_after = updated
    assert row_after["online"] is True
    assert row_after["commands"] == ["transport.pause"]

    status, _ = send_command(scope, "browser-1", "transport.pause", {}, deliver=deliver)
    assert status == 200
    assert sent_sids == ["sid-b", "sid-a", "sid-b"]

    # Tab B disconnects -> device goes offline.
    _, row_offline = playback_state.unregister_socket("sid-b")
    assert row_offline["online"] is False
    assert row_offline["socket_active"] is False
    assert row_offline["protocol"] is None
    assert row_offline["commands"] == []


def test_seq_staleness_and_monotonic_rev_across_instances(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-seq"
    playback_state.register_socket_instance(
        scope, "dev-1", "sid-1", device_type="web", instance_id="inst-1", protocol=1, commands=[]
    )

    r1 = playback_state.put_state(scope, {
        "device_id": "dev-1", "instance_id": "inst-1", "seq": 1, "track_id": "t1", "position_sec": 10, "is_playing": True,
    })
    assert r1["status"] == "ok" and r1["rev"] == 1

    # Same or older seq for inst-1 is dropped as stale without bumping rev.
    assert playback_state.put_state(scope, {
        "device_id": "dev-1", "instance_id": "inst-1", "seq": 1, "track_id": "t2", "position_sec": 99, "is_playing": False,
    }) == {"status": "stale"}
    assert playback_state.put_state(scope, {
        "device_id": "dev-1", "instance_id": "inst-1", "seq": 0, "track_id": "t2", "position_sec": 99, "is_playing": False,
    }) == {"status": "stale"}
    assert playback_state.get_state(scope, device_id="dev-1")["track_id"] == "t1"

    # A second instance of the same device has its own seq counter and shares rev.
    r2 = playback_state.put_state(scope, {
        "device_id": "dev-1", "instance_id": "inst-2", "seq": 1, "track_id": "t2", "position_sec": 5, "is_playing": True,
    })
    assert r2["status"] == "ok" and r2["rev"] == 2

    # Next seq on inst-1 bumps rev to 3.
    r3 = playback_state.put_state(scope, {
        "device_id": "dev-1", "instance_id": "inst-1", "seq": 2, "track_id": "t3", "position_sec": 1, "is_playing": True,
    })
    assert r3["status"] == "ok" and r3["rev"] == 3


def test_device_row_playing_modes_and_live_replacement(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-modes"
    playback_state.register_device(scope, device_id="dev-1", device_name="Phone", device_type="android", form_factor="phone")

    assert playback_state.get_registered_device(scope, "dev-1")["playing"] is None

    # Normal music
    playback_state.put_state(scope, {
        "device_id": "dev-1", "track_id": "t1", "track": {"id": "t1", "title": "Song"}, "is_playing": True,
        "live": {"phase": "playing", "duration": 200, "dj": None},
    })
    row = playback_state.get_registered_device(scope, "dev-1")
    assert row["playing"]["mode"] == "normal"
    assert row["playing"]["rev"] == 1
    assert isinstance(row["playing"]["measured_at_ms"], int)

    # DJ via live.dj
    playback_state.put_state(scope, {
        "device_id": "dev-1", "track_id": "t1", "track": {"id": "t1"}, "is_playing": True,
        "live": {"phase": "playing", "duration": 200, "dj": {"phase": "active", "mixing": True}},
    })
    assert playback_state.get_registered_device(scope, "dev-1")["playing"]["mode"] == "dj"

    # live is replaced on every publication (omitting live clears live.dj)
    playback_state.put_state(scope, {
        "device_id": "dev-1", "track_id": "t1", "track": {"id": "t1"}, "is_playing": True,
    })
    assert playback_state.get_registered_device(scope, "dev-1")["playing"]["mode"] == "normal"
    assert playback_state.get_watch_state(scope, "dev-1")["live"] is None

    # DJ via session.mode == "auto"
    playback_state.put_state(scope, {
        "device_id": "dev-1", "track_id": "t1", "track": {"id": "t1"}, "is_playing": True,
        "session": {"mode": "auto"},
    })
    assert playback_state.get_registered_device(scope, "dev-1")["playing"]["mode"] == "dj"

    # Radio via session.radio.active
    playback_state.put_state(scope, {
        "device_id": "dev-1", "track_id": "t1", "track": {"id": "t1"}, "is_playing": True,
        "session": {"mode": "normal", "radio": {"active": True}},
    })
    assert playback_state.get_registered_device(scope, "dev-1")["playing"]["mode"] == "radio"

    # Podcast via track metadata
    playback_state.put_state(scope, {
        "device_id": "dev-1", "track_id": "ep-1",
        "track": {"id": "ep-1", "media_kind": "podcast_episode"},
        "is_playing": True, "session": None,
    })
    assert playback_state.get_registered_device(scope, "dev-1")["playing"]["mode"] == "podcast"


# ---------------------------------------------------------------------------
# 3. Socket.IO events: device_updated, device_state, watch_device scoping
# ---------------------------------------------------------------------------


def test_socket_events_device_updated_device_state_and_watch_scoping(tmp_path, monkeypatch):
    _configure_runtime(tmp_path)
    from flask import request

    emitted = []
    joined = []
    left = []

    monkeypatch.setattr("shared.realtime.socketio.emit", lambda ev, payload=None, room=None: emitted.append((ev, payload, room)))
    monkeypatch.setattr("shared.api.join_room", lambda room, sid=None: joined.append((room, sid)))
    monkeypatch.setattr("shared.api.leave_room", lambda room, sid=None: left.append((room, sid)))

    # Account A registers a device -> device_updated emitted to user:acct-a
    with main_app.test_request_context("/socket.io/"):
        request.sid = "sid-a1"
        with patch("shared.api._resolve_request_user_id", return_value="acct-a"):
            on_playback_register({
                "device_id": "dev-a",
                "device_name": "Chrome · Linux",
                "device_type": "web",
                "form_factor": "computer",
                "instance_id": "inst-a1",
                "protocol": 1,
                "commands": ["transport.play"],
            })
    assert emitted[-1][0] == "device_updated"
    assert emitted[-1][2] == "user:acct-a"
    assert emitted[-1][1]["device"]["device_id"] == "dev-a"
    assert isinstance(emitted[-1][1]["server_now_ms"], int)

    # Rename via playback_register emits device_updated
    with main_app.test_request_context("/socket.io/"):
        request.sid = "sid-a1"
        with patch("shared.api._resolve_request_user_id", return_value="acct-a"):
            on_playback_register({
                "device_id": "dev-a",
                "device_name": "Studio",
                "device_type": "web",
                "instance_id": "inst-a1",
                "protocol": 1,
                "commands": ["transport.play"],
            })
    assert emitted[-1][1]["device"]["device_name"] == "Studio"

    # Account B tries to watch Account A's device -> denied, never joins any room!
    with main_app.test_request_context("/socket.io/"):
        request.sid = "sid-b1"
        with patch("shared.api._resolve_request_user_id", return_value="acct-b"):
            ack_b = on_watch_device({"device_id": "dev-a"})
    assert ack_b["device"] is None
    assert ack_b["state"] is None
    assert joined == []

    # Account A publishes state with session via PUT /api/playback/state
    emitted.clear()
    app = _make_playback_app()
    orig_get_api = playback_routes._get_api
    monkeypatch.setattr(playback_routes, "_get_api", lambda: {**orig_get_api(), "get_scope_from_request": lambda: "acct-a"})

    client = app.test_client()
    resp1 = client.put("/api/playback/state", json={
        "device_id": "dev-a",
        "instance_id": "inst-a1",
        "seq": 1,
        "track_id": "t1",
        "track": {"id": "t1", "title": "Song"},
        "position_sec": 15.0,
        "is_playing": True,
        "live": {"phase": "playing", "duration": 200, "dj": None},
        "session": {"v": 1, "queue": [{"id": "t1", "queueId": "q1"}]},
    })
    assert resp1.status_code == 200
    assert resp1.get_json() == {"status": "ok", "rev": 1}

    events_by_name = {ev: (payload, room) for ev, payload, room in emitted}
    assert "device_updated" in events_by_name
    assert events_by_name["device_updated"][1] == "user:acct-a"
    assert "device_state" in events_by_name
    ds_payload, ds_room = events_by_name["device_state"]
    assert ds_room == "watch:acct-a:dev-a"
    assert ds_payload["rev"] == 1
    assert ds_payload["session"] == {"v": 1, "queue": [{"id": "t1", "queueId": "q1"}]}

    # Account A watches dev-a -> joins watch:acct-a:dev-a and ack carries full stored session
    with main_app.test_request_context("/socket.io/"):
        request.sid = "sid-a2"
        with patch("shared.api._resolve_request_user_id", return_value="acct-a"):
            ack_a = on_watch_device({"device_id": "dev-a"})
    assert joined == [("watch:acct-a:dev-a", "sid-a2")]
    assert ack_a["device"]["device_id"] == "dev-a"
    assert ack_a["state"]["rev"] == 1
    assert ack_a["state"]["session"] == {"v": 1, "queue": [{"id": "t1", "queueId": "q1"}]}
    assert isinstance(ack_a["server_now_ms"], int)

    # Next publication OMITS session -> device_state must omit session key, while watch ack keeps stored session
    emitted.clear()
    resp2 = client.put("/api/playback/state", json={
        "device_id": "dev-a",
        "instance_id": "inst-a1",
        "seq": 2,
        "track_id": "t1",
        "track": {"id": "t1", "title": "Song"},
        "position_sec": 30.0,
        "is_playing": True,
    })
    assert resp2.get_json() == {"status": "ok", "rev": 2}
    ds2 = [p for ev, p, _ in emitted if ev == "device_state"][0]
    assert "session" not in ds2
    assert playback_state.get_watch_state("acct-a", "dev-a")["session"] is not None

    # Stale publication emits NOTHING and answers {"status": "stale"}
    emitted.clear()
    resp_stale = client.put("/api/playback/state", json={
        "device_id": "dev-a",
        "instance_id": "inst-a1",
        "seq": 2,
        "track_id": "t1",
        "position_sec": 99.0,
        "is_playing": False,
    })
    assert resp_stale.status_code == 200
    assert resp_stale.get_json() == {"status": "stale"}
    assert emitted == []

    # Publication with explicit session: null includes "session": None in device_state
    resp3 = client.put("/api/playback/state", json={
        "device_id": "dev-a",
        "instance_id": "inst-a1",
        "seq": 3,
        "track_id": None,
        "is_playing": False,
        "session": None,
    })
    assert resp3.get_json() == {"status": "ok", "rev": 3}
    ds3 = [p for ev, p, _ in emitted if ev == "device_state"][0]
    assert "session" in ds3 and ds3["session"] is None

    # Unwatch leaves the room and acknowledges
    with main_app.test_request_context("/socket.io/"):
        request.sid = "sid-a2"
        with patch("shared.api._resolve_request_user_id", return_value="acct-a"):
            unwatch_ack = on_unwatch_device({"device_id": "dev-a"})
    assert unwatch_ack == {"ok": True, "device_id": "dev-a"}
    assert left == [("watch:acct-a:dev-a", "sid-a2")]

    # Disconnect emits device_updated with online: False
    emitted.clear()
    with main_app.test_request_context("/socket.io/"):
        request.sid = "sid-a1"
        on_socket_disconnect()
    assert emitted[-1][0] == "device_updated"
    assert emitted[-1][2] == "user:acct-a"
    assert emitted[-1][1]["device"]["online"] is False


# ---------------------------------------------------------------------------
# 4. Every row of the HTTP answer table & session.* refusal
# ---------------------------------------------------------------------------


def test_http_command_answer_table_and_session_refusal(tmp_path, monkeypatch):
    _configure_runtime(tmp_path)
    scope = playback_state.get_scope_from_request()

    # Devices: modern online, legacy online (no protocol), offline
    playback_state.register_socket_instance(
        scope, "modern", "sid-modern",
        device_type="web", instance_id="i-mod", protocol=1,
        commands=["transport.play", "transport.pause", "dj.repair", "queue.remove"],
    )
    playback_state.register_socket_instance(
        scope, "legacy", "sid-legacy",
        device_type="android",  # no instance_id -> protocol is None
    )
    playback_state.register_device(scope, device_id="offline", device_name="Offline", device_type="web")

    behavior = {"mode": "applied"}

    def fake_deliver(sid, payload, timeout):
        assert timeout == DEFAULT_COMMAND_TIMEOUT_SEC
        mode = behavior["mode"]
        if mode == "applied":
            return {"status": "applied", "rev": 7}
        if mode == "timeout":
            raise SocketIOTimeoutError("timed out")
        if mode == "disconnected":
            raise DisconnectedError("gone")
        return {"status": "rejected", "reason": mode}

    orig = playback_routes._get_api
    monkeypatch.setattr(playback_routes, "_get_api", lambda: {
        **orig(),
        "send_command": lambda s, d, n, a=None, allow_internal=False: send_command(
            s, d, n, a, allow_internal=allow_internal, deliver=fake_deliver
        ),
    })

    client = _make_playback_app().test_client()

    # 200 applied
    r = client.post("/api/devices/modern/commands", json={"name": "transport.pause", "args": {}})
    assert r.status_code == 200
    assert r.get_json() == {"status": "applied", "rev": 7}

    # 400 invalid: unknown command, bad args, and session.* refused on public endpoint
    for body in (
        {"name": "no.such.command", "args": {}},
        {"name": "transport.seek", "args": {"position_sec": -5}},
        {"name": "session.export", "args": {}},
        {"name": "session.import", "args": {"state": {"track_id": "t1"}}},
        {"name": "session.release", "args": {}},
    ):
        r = client.post("/api/devices/modern/commands", json=body)
        assert r.status_code == 400
        assert r.get_json() == {"status": "rejected", "reason": "invalid"}

    # 404 unknown_device
    r = client.post("/api/devices/missing/commands", json={"name": "transport.pause", "args": {}})
    assert r.status_code == 404
    assert r.get_json() == {"status": "rejected", "reason": "unknown_device"}

    # 409 update_required (online, no protocol)
    r = client.post("/api/devices/legacy/commands", json={"name": "transport.pause", "args": {}})
    assert r.status_code == 409
    assert r.get_json() == {"status": "rejected", "reason": "update_required"}

    # 409 unsupported (not declared)
    r = client.post("/api/devices/modern/commands", json={"name": "transport.set_volume", "args": {"level": 0.5}})
    assert r.status_code == 409
    assert r.get_json() == {"status": "rejected", "reason": "unsupported"}

    # 409 target rejection reasons
    for reason in ("invalid_state", "not_found", "locked", "needs_gesture", "nothing_playing"):
        behavior["mode"] = reason
        r = client.post("/api/devices/modern/commands", json={"name": "transport.play", "args": {}})
        assert r.status_code == 409
        assert r.get_json() == {"status": "rejected", "reason": reason}

    # 503 offline
    r = client.post("/api/devices/offline/commands", json={"name": "transport.pause", "args": {}})
    assert r.status_code == 503
    assert r.get_json() == {"status": "unreachable", "reason": "offline"}

    # 503 disconnected mid-call
    behavior["mode"] = "disconnected"
    r = client.post("/api/devices/modern/commands", json={"name": "transport.pause", "args": {}})
    assert r.status_code == 503
    assert r.get_json() == {"status": "unreachable", "reason": "offline"}

    # 504 timeout
    behavior["mode"] = "timeout"
    r = client.post("/api/devices/modern/commands", json={"name": "transport.pause", "args": {}})
    assert r.status_code == 504
    assert r.get_json() == {"status": "unreachable", "reason": "timeout"}

    # Commands wrote no playback state on any device's behalf
    assert playback_state.get_state(scope, device_id="modern") is None


# ---------------------------------------------------------------------------
# 5. Transfer order, fallbacks and failure handling
# ---------------------------------------------------------------------------


def test_transfer_success_order_and_import_timeout(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-xfer"
    session_cmds = ["session.export", "session.import", "session.release"]
    playback_state.register_socket_instance(
        scope, "src", "sid-src", device_type="web", instance_id="i-src", protocol=1, commands=session_cmds
    )
    playback_state.register_socket_instance(
        scope, "dst", "sid-dst", device_type="android", instance_id="i-dst", protocol=1, commands=session_cmds
    )

    calls = []
    exported = {"track_id": "t1", "track": {"id": "t1"}, "position_sec": 33.2, "is_playing": True, "session": {"v": 1}}

    def deliver(sid, payload, timeout):
        calls.append((sid, payload["name"], timeout, payload["args"]))
        if payload["name"] == "session.export":
            return {"status": "applied", "rev": 4, "state": exported}
        if payload["name"] == "session.import":
            return {"status": "applied", "rev": 1}
        if payload["name"] == "session.release":
            return {"status": "applied", "rev": 5}
        raise AssertionError(payload)

    status, body = transfer_playback(scope, "src", "dst", deliver=deliver)
    assert status == 200
    assert body == {"status": "applied", "rev": 1}
    assert [(sid, name, timeout) for sid, name, timeout, _ in calls] == [
        ("sid-src", "session.export", DEFAULT_COMMAND_TIMEOUT_SEC),
        ("sid-dst", "session.import", IMPORT_COMMAND_TIMEOUT_SEC),
        ("sid-src", "session.release", DEFAULT_COMMAND_TIMEOUT_SEC),
    ]
    assert calls[1][3] == {"state": exported}
    # Transfer wrote no state on the target's behalf.
    assert playback_state.get_state(scope, device_id="dst") is None


def test_transfer_falls_back_to_stored_state_when_source_offline_or_legacy(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-xfer-fallback"
    playback_state.register_device(scope, device_id="src-offline", device_type="web")
    playback_state.register_socket_instance(scope, "src-legacy", "sid-legacy", device_type="android")
    playback_state.register_socket_instance(
        scope, "dst", "sid-dst", device_type="web", instance_id="i-dst", protocol=1, commands=["session.import"]
    )
    playback_state.put_state(scope, {
        "device_id": "src-offline", "track_id": "t1", "track": {"id": "t1"}, "position_sec": 12, "is_playing": True,
        "session": {"v": 1, "queue": [{"id": "t1", "queueId": "q1"}]},
    })
    playback_state.put_state(scope, {
        "device_id": "src-legacy", "track_id": "t2", "track": {"id": "t2"}, "position_sec": 20, "is_playing": True,
    })

    calls = []

    def deliver(sid, payload, timeout):
        calls.append((sid, payload["name"], payload["args"]))
        return {"status": "applied", "rev": 2}

    # Offline source: no export/release sent; stored state imported into target
    s1, b1 = transfer_playback(scope, "src-offline", "dst", deliver=deliver)
    assert s1 == 200 and b1 == {"status": "applied", "rev": 2}
    assert [name for _, name, _ in calls] == ["session.import"]
    assert calls[0][2]["state"]["track_id"] == "t1"
    assert calls[0][2]["state"]["session"]["queue"][0]["queueId"] == "q1"

    # Legacy online source (no protocol): falls back to stored state, release fails quietly (update_required) -> still applied
    calls.clear()
    s2, b2 = transfer_playback(scope, "src-legacy", "dst", deliver=deliver)
    assert s2 == 200 and b2 == {"status": "applied", "rev": 2}
    assert [name for _, name, _ in calls] == ["session.import"]
    assert calls[0][2]["state"]["track_id"] == "t2"


def test_transfer_import_failure_leaves_source_untouched(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-xfer-fail"
    cmds = ["session.export", "session.import", "session.release"]
    playback_state.register_socket_instance(
        scope, "src", "sid-src", device_type="web", instance_id="i-src", protocol=1, commands=cmds
    )
    playback_state.register_socket_instance(
        scope, "dst", "sid-dst", device_type="web", instance_id="i-dst", protocol=1, commands=cmds
    )

    calls = []

    def deliver(sid, payload, timeout):
        calls.append((sid, payload["name"]))
        if payload["name"] == "session.export":
            return {"status": "applied", "rev": 1, "state": {"track_id": "t1", "position_sec": 5}}
        if payload["name"] == "session.import":
            return {"status": "rejected", "reason": "needs_gesture"}
        raise AssertionError("session.release must not be called when import fails")

    status, body = transfer_playback(scope, "src", "dst", deliver=deliver)
    assert status == 409
    assert body == {"status": "rejected", "reason": "needs_gesture", "step": "import"}
    assert calls == [("sid-src", "session.export"), ("sid-dst", "session.import")]


def test_transfer_release_failure_still_answers_applied(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-xfer-relfail"
    cmds = ["session.export", "session.import", "session.release"]
    playback_state.register_socket_instance(
        scope, "src", "sid-src", device_type="web", instance_id="i-src", protocol=1, commands=cmds
    )
    playback_state.register_socket_instance(
        scope, "dst", "sid-dst", device_type="web", instance_id="i-dst", protocol=1, commands=cmds
    )

    def deliver(sid, payload, timeout):
        if payload["name"] == "session.export":
            return {"status": "applied", "rev": 1, "state": {"track_id": "t1"}}
        if payload["name"] == "session.import":
            return {"status": "applied", "rev": 9}
        raise SocketIOTimeoutError("source vanished")

    status, body = transfer_playback(scope, "src", "dst", deliver=deliver)
    assert status == 200
    assert body == {"status": "applied", "rev": 9}


def test_transfer_nothing_playing(tmp_path):
    _configure_runtime(tmp_path)
    scope = "user-xfer-empty"
    cmds = ["session.export", "session.import", "session.release"]
    playback_state.register_socket_instance(
        scope, "src", "sid-src", device_type="web", instance_id="i-src", protocol=1, commands=cmds
    )
    playback_state.register_socket_instance(
        scope, "dst", "sid-dst", device_type="web", instance_id="i-dst", protocol=1, commands=cmds
    )

    def deliver(sid, payload, timeout):
        if payload["name"] == "session.export":
            return {"status": "applied", "rev": 1, "state": {"track_id": None}}
        raise AssertionError("should not import when nothing is playing")

    status, body = transfer_playback(scope, "src", "dst", deliver=deliver)
    assert status == 409
    assert body == {"status": "rejected", "reason": "nothing_playing", "step": "export"}


# ---------------------------------------------------------------------------
# 6. Wrappers, deleted notify-stop, and Agent API
# ---------------------------------------------------------------------------


def test_handoff_wrapper_and_deleted_notify_stop(tmp_path, monkeypatch):
    _configure_runtime(tmp_path)
    scope = playback_state.get_scope_from_request()
    seen = []
    orig = playback_routes._get_api
    monkeypatch.setattr(playback_routes, "_get_api", lambda: {
        **orig(),
        "transfer_playback": lambda s, src, dst: (seen.append((s, src, dst)) or (200, {"status": "applied", "rev": 4})),
    })

    client = _make_playback_app().test_client()
    r = client.post("/api/playback/handoff", json={"from_device_id": "a", "to_device_id": "b"})
    assert r.status_code == 200
    assert r.get_json() == {"status": "applied", "rev": 4}
    assert seen == [(scope, "a", "b")]

    # POST /api/playback/notify-stop was deleted
    gone = client.post("/api/playback/notify-stop", json={"device_id": "a"})
    assert gone.status_code == 404


def test_agent_endpoints_use_dispatcher_and_keep_target_picking_rule(tmp_path, monkeypatch):
    _configure_runtime(tmp_path)
    scope = "default"
    token = _mint_agent_token()
    headers = {"Authorization": f"Bearer {token}"}

    # Register an online agent, an offline desktop, and an online phone -> should pick online phone!
    playback_state.register_socket_instance(
        scope, "agent-1", "sid-agent", device_name="Agent", device_type="agent", instance_id="ia", protocol=1, commands=["transport.pause"]
    )
    playback_state.register_device(scope, device_id="desk-1", device_name="Desktop", device_type="desktop")
    playback_state.register_socket_instance(
        scope, "phone-1", "sid-phone", device_name="Pixel", device_type="android", form_factor="phone",
        instance_id="ip", protocol=1,
        commands=["transport.pause", "transport.play", "transport.next", "transport.previous", "transport.seek", "play.tracks"],
    )

    delivered = []

    def fake_deliver(sid, payload, timeout):
        delivered.append((sid, payload))
        return {"status": "applied", "rev": len(delivered)}

    fake_lib = _FakeLibrary([_FakeTrack("t1", "One More Time", "Daft Punk")])
    monkeypatch.setattr(agent_routes, "_scope", lambda: scope)
    monkeypatch.setattr(agent_routes, "_get_api", lambda: {
        "get_library": lambda: fake_lib,
        "get_downloader": lambda open_browser=False: None,
        "get_track_by_id": lambda lib, tid: lib.get(tid),
        "socketio": None,
        "list_registered_devices": playback_state.list_registered_devices,
        "resolve_registered_device": playback_state.resolve_registered_device,
        "send_command": lambda s, d, n, a=None: send_command(s, d, n, a, deliver=fake_deliver),
    })

    client = _make_agent_app().test_client()

    # Auto-picks online non-agent device ("phone-1")
    r_pause = client.post("/api/agent/command", json={"command": "pause"}, headers=headers)
    assert r_pause.status_code == 200
    assert r_pause.get_json() == {"status": "applied", "rev": 1}
    assert delivered[-1] == ("sid-phone", {"name": "transport.pause", "args": {}})

    # Seek accepts position_ms and targets by exact device_name
    r_seek = client.post("/api/agent/command", json={"command": "seek", "position_ms": 45500, "device_id": "Pixel"}, headers=headers)
    assert r_seek.status_code == 200
    assert delivered[-1] == ("sid-phone", {"name": "transport.seek", "args": {"position_sec": 45.5}})

    # Play library track by query -> bounded track (path/url stripped), no state written
    r_play = client.post("/api/agent/play", json={"query": "One More Time"}, headers=headers)
    assert r_play.status_code == 200
    assert r_play.get_json() == {"status": "applied", "rev": 3}
    sent_name = delivered[-1][1]["name"]
    sent_track = delivered[-1][1]["args"]["tracks"][0]
    assert sent_name == "play.tracks"
    assert sent_track["id"] == "t1"
    assert "path" not in sent_track and "url" not in sent_track
    assert playback_state.get_state(scope, device_id="phone-1") is None

    # Targeting offline desktop returns 503 offline
    r_off = client.post("/api/agent/command", json={"command": "pause", "device_id": "Desktop"}, headers=headers)
    assert r_off.status_code == 503
    assert r_off.get_json() == {"status": "unreachable", "reason": "offline"}
