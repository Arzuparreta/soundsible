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
