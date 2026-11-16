from shared.playback_state import get_state, put_state
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _configure_runtime(tmp_path):
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
        advanced_mode=False,
    )
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)
    configure_runtime(runtime)
    return runtime


def test_exclude_device_falls_back_to_same_device_persisted_state(tmp_path):
    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "same_device_resume"
    put_state(
        scope,
        {
            "device_id": "dev1",
            "device_name": "Desktop",
            "track_id": "t1",
            "track": {"id": "t1", "title": "One", "artist": "Artist"},
            "position_sec": 42,
            "is_playing": False,
        },
    )

    state = get_state(scope, exclude_device_id="dev1")

    assert state is not None
    assert state["device_id"] == "dev1"
    assert state["track_id"] == "t1"
    assert state["position_sec"] == 42


def _session(track_id="t1", queue_id="q1"):
    return {
        "v": 1,
        "mode": "auto",
        "queue": [{"id": track_id, "queueId": queue_id, "title": "One", "artist": "Artist"}],
        "index": 0,
        "shuffle": False,
        "repeat": "off",
        "radio": {"active": False, "seedId": None},
        "auto": {"profile": "balanced", "sources": [], "plan": {}},
    }


def _put(scope, **overrides):
    payload = {
        "device_id": "dev1",
        "device_name": "Desktop",
        "track_id": "t1",
        "track": {"id": "t1", "title": "One", "artist": "Artist"},
        "position_sec": 10,
        "is_playing": True,
    }
    payload.update(overrides)
    put_state(scope, payload)


def test_session_travels_with_the_state_that_carries_it(tmp_path):
    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "session_publish"

    _put(scope, session=_session())

    state = get_state(scope, exclude_device_id="dev2")
    assert state["session"]["mode"] == "auto"
    assert state["session"]["queue"][0]["queueId"] == "q1"


def test_position_ping_without_a_session_keeps_the_one_already_stored(tmp_path):
    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "session_delta"
    _put(scope, session=_session())

    _put(scope, position_sec=99)

    state = get_state(scope, device_id="dev1")
    assert state["position_sec"] == 99
    assert state["session"]["queue"][0]["id"] == "t1"


def test_explicit_null_ends_the_session_rather_than_leaving_it_resumable(tmp_path):
    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "session_cleared"
    _put(scope, session=_session())

    _put(scope, track_id=None, track=None, is_playing=False, session=None)

    assert get_state(scope, device_id="dev1").get("session") is None


def test_session_outlives_a_restart_through_the_persisted_state(tmp_path):
    from shared import playback_state

    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "session_restart"
    _put(scope, session=_session())

    # What a restarted engine has: the file, and no memory of any device.
    playback_state._active_devices.clear()
    playback_state._registered_devices.clear()
    _put(scope, position_sec=120)

    state = get_state(scope, device_id="dev1")
    assert state["position_sec"] == 120
    assert state["session"]["queue"][0]["id"] == "t1"


def test_a_session_too_big_to_be_one_is_not_stored(tmp_path):
    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "session_oversized"
    oversized = _session()
    oversized["queue"] = [
        {"id": f"t{i}", "queueId": f"q{i}", "title": "x" * 512, "artist": "Artist"}
        for i in range(1000)
    ]

    _put(scope, session=oversized)

    assert get_state(scope, device_id="dev1").get("session") is None


def test_a_session_that_is_not_an_object_is_not_stored(tmp_path):
    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "session_malformed"

    _put(scope, session="resume me")

    assert get_state(scope, device_id="dev1").get("session") is None


def test_a_state_finishing_after_a_newer_one_does_not_overwrite_it(tmp_path):
    import json
    from shared import playback_state

    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "out_of_order"
    _put(scope, position_sec=10)
    older = playback_state._newest_state[scope]
    _put(scope, position_sec=20)

    # The request that took the older state reaches the disk last.
    playback_state._persist_state(scope, older, json.dumps({"position_sec": 10}))

    stored = json.loads(playback_state._state_path(scope).read_text(encoding="utf-8"))
    assert stored["position_sec"] == 20


def test_the_file_is_replaced_whole_never_rewritten_in_place(tmp_path, monkeypatch):
    from shared import playback_state

    reset_runtime()
    _configure_runtime(tmp_path)
    scope = "whole_file"
    _put(scope, position_sec=10)
    path = playback_state._state_path(scope)
    before = path.read_bytes()

    def interrupted(handle):
        handle.write(b'{"position_sec": 2')
        raise OSError("power lost")

    monkeypatch.setattr(playback_state, "text_pieces", lambda pieces: interrupted)
    _put(scope, position_sec=20)  # The failure is logged, not raised.

    assert path.read_bytes() == before
    assert not [p for p in path.parent.iterdir() if p.name.startswith(f".{path.name}.")]
