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


def test_owned_engine_preserves_folder_selection_without_a_separate_bootstrap(tmp_path, monkeypatch):
    from shared import desktop_engine_entry
    from shared.runtime import load_persisted_music_dir

    first = tmp_path / 'first'
    second = tmp_path / 'second'
    first.mkdir()
    second.mkdir()
    bootstrap_only(str(first))
    monkeypatch.setattr(desktop_engine_entry, 'run_desktop_engine', lambda args: None)
    assert run(['--music-dir', str(second)]) == 0
    assert load_persisted_music_dir(get_config_dir()) == second.resolve()


def test_interrupted_owned_bootstrap_never_publishes_a_partial_config(tmp_path, monkeypatch):
    import pytest
    from shared import atomic_file
    from shared.desktop_bootstrap import ensure_consumer_config

    def interrupted(fd):
        raise OSError('interrupted durable publication')

    monkeypatch.setattr(atomic_file, 'sync_file', interrupted)
    with pytest.raises(OSError, match='interrupted durable publication'):
        ensure_consumer_config(tmp_path / 'music')
    assert not (get_config_dir() / 'config.json').exists()
