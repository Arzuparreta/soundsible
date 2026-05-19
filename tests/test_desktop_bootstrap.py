import json

from shared.desktop_bootstrap import ensure_consumer_config
from shared.models import PlayerConfig, StorageProvider
from shared.runtime import get_config_dir, load_persisted_music_dir, reset_runtime


def test_ensure_consumer_config_writes_local_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("SOUNDSIBLE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOUNDSIBLE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("SOUNDSIBLE_LOG_DIR", str(tmp_path / "logs"))
    reset_runtime()

    music = tmp_path / "music"
    music.mkdir()
    (music / "a.flac").write_bytes(b"x")

    path = ensure_consumer_config(music)
    assert path.exists()
    data = json.loads(path.read_text())
    assert data["provider"] == StorageProvider.LOCAL.value
    assert data["endpoint"] == str(music.resolve())

    persisted = load_persisted_music_dir(get_config_dir())
    assert persisted == music.resolve()

    # Idempotent
    ensure_consumer_config(music)
    assert PlayerConfig.from_dict(json.loads(path.read_text())).provider == StorageProvider.LOCAL
