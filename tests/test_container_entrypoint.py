import json

import pytest

from shared.container_entrypoint import bootstrap_local_config


def _environment(tmp_path, **overrides):
    values = {
        "SOUNDSIBLE_CONFIG_DIR": str(tmp_path / "config"),
        "SOUNDSIBLE_CACHE_DIR": str(tmp_path / "cache"),
        "SOUNDSIBLE_MUSIC_DIR": str(tmp_path / "music"),
        "OUTPUT_DIR": str(tmp_path / "music"),
        "SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE": "true",
    }
    values.update(overrides)
    return values


def test_bootstrap_creates_persistent_local_configuration(tmp_path):
    environment = _environment(tmp_path)

    assert bootstrap_local_config(environment) is True

    config_dir = tmp_path / "config"
    music_dir = (tmp_path / "music").resolve()
    config = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    assert config["provider"] == "local"
    assert config["endpoint"] == str(music_dir)
    assert config["watch_folders"] == [str(music_dir)]
    assert (config_dir / "output_dir").read_text(encoding="utf-8").strip() == str(music_dir)
    assert json.loads((config_dir / "music_dir.json").read_text(encoding="utf-8"))["path"] == str(music_dir)


def test_bootstrap_never_overwrites_existing_configuration(tmp_path):
    environment = _environment(tmp_path)
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    config_path = config_dir / "config.json"
    config_path.write_text('{"provider": "r2"}\n', encoding="utf-8")

    assert bootstrap_local_config(environment) is False
    assert config_path.read_text(encoding="utf-8") == '{"provider": "r2"}\n'


def test_bootstrap_can_require_preprovisioned_configuration(tmp_path):
    environment = _environment(tmp_path, SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE="false")

    with pytest.raises(RuntimeError, match="not configured"):
        bootstrap_local_config(environment)
