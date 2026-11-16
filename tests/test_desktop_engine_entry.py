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
