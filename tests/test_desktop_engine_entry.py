import json

from shared.desktop_engine_entry import bootstrap_only, run
from shared.runtime import get_config_dir, reset_runtime


def test_bootstrap_only_writes_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("SOUNDSIBLE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOUNDSIBLE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("SOUNDSIBLE_LOG_DIR", str(tmp_path / "logs"))
    reset_runtime()

    music = tmp_path / "music"
    music.mkdir()

    assert bootstrap_only(str(music)) == 0
    assert (get_config_dir() / "config.json").is_file()


def test_run_bootstraps_when_music_dir_provided(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("SOUNDSIBLE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOUNDSIBLE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("SOUNDSIBLE_LOG_DIR", str(tmp_path / "logs"))
    reset_runtime()

    music = tmp_path / "music"
    music.mkdir()

    # Avoid starting Flask; bootstrap path should succeed before engine boot.
    assert run(["--bootstrap", str(music)]) == 0
    payload = json.loads((get_config_dir() / "config.json").read_text())
    assert payload["provider"] == "local"


def test_tool_wait_marker_names_only_the_waiting_process():
    import os

    from shared.desktop_engine_entry import _tool_wait_state

    path = get_config_dir() / "desktop-engine-startup.json"
    _tool_wait_state(True)
    assert json.loads(path.read_text()) == {"pid": os.getpid(), "waiting_for_tools": True}
    _tool_wait_state(False)
    assert not path.exists()
    path.write_text(json.dumps({"pid": os.getpid() + 1, "waiting_for_tools": True}))
    _tool_wait_state(False)
    assert path.exists()  # Another process owns its own startup indication.
