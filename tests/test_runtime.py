from pathlib import Path
import json

from shared.runtime import RuntimeConfig, migrate_legacy_app_dirs, runtime_with_overrides


def test_runtime_config_defaults_follow_env(monkeypatch, tmp_path):
    monkeypatch.setenv("SOUNDSIBLE_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("SOUNDSIBLE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOUNDSIBLE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("SOUNDSIBLE_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("SOUNDSIBLE_MUSIC_DIR", str(tmp_path / "music"))
    monkeypatch.setenv("SOUNDSIBLE_HOST", "127.0.0.1")
    monkeypatch.setenv("SOUNDSIBLE_PORT", "5044")
    monkeypatch.setenv("SOUNDSIBLE_LAN_ENABLED", "false")
    monkeypatch.setenv("SOUNDSIBLE_ADVANCED_MODE", "true")

    runtime = RuntimeConfig.default()

    assert runtime.config_dir == (tmp_path / "cfg").resolve()
    assert runtime.data_dir == (tmp_path / "data").resolve()
    assert runtime.cache_dir == (tmp_path / "cache").resolve()
    assert runtime.log_dir == (tmp_path / "logs").resolve()
    assert runtime.music_dir == (tmp_path / "music").resolve()
    assert runtime.host == "127.0.0.1"
    assert runtime.port == 5044
    assert runtime.lan_enabled is False
    assert runtime.advanced_mode is True


def test_runtime_with_overrides_reserves_random_loopback_port(tmp_path, monkeypatch):
    base = RuntimeConfig.default(
        env={
            "SOUNDSIBLE_CONFIG_DIR": str(tmp_path / "cfg"),
            "SOUNDSIBLE_DATA_DIR": str(tmp_path / "data"),
            "SOUNDSIBLE_CACHE_DIR": str(tmp_path / "cache"),
            "SOUNDSIBLE_LOG_DIR": str(tmp_path / "logs"),
            "SOUNDSIBLE_MUSIC_DIR": str(tmp_path / "music"),
        }
    )
    runtime = runtime_with_overrides(base=base, host="127.0.0.1", port=0)
    monkeypatch.setattr("shared.runtime._reserve_port", lambda host: 49152)

    bind_host, bind_port = runtime.resolved_bind()

    assert bind_host == "127.0.0.1"
    assert isinstance(bind_port, int)
    assert bind_port > 0


def test_migrate_legacy_dirs_copies_existing_data(tmp_path):
    legacy_config = tmp_path / "legacy-config"
    legacy_cache = tmp_path / "legacy-cache"
    legacy_data = tmp_path / "legacy-data"
    legacy_config.mkdir()
    legacy_cache.mkdir()
    legacy_data.mkdir()
    (legacy_config / "config.json").write_text('{"ok":true}')
    (legacy_cache / "cover.txt").write_text("cover")
    (legacy_data / "db.sqlite").write_text("db")

    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=tmp_path / "new-config",
        data_dir=tmp_path / "new-data",
        cache_dir=tmp_path / "new-cache",
        log_dir=tmp_path / "new-logs",
        music_dir=tmp_path / "music",
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=False,
    )

    from shared import runtime as runtime_module

    original_config = runtime_module.LEGACY_CONFIG_DIR
    original_cache = runtime_module.LEGACY_CACHE_DIR
    original_data = runtime_module.LEGACY_DATA_DIR
    runtime_module.LEGACY_CONFIG_DIR = legacy_config
    runtime_module.LEGACY_CACHE_DIR = legacy_cache
    runtime_module.LEGACY_DATA_DIR = legacy_data
    try:
        migrate_legacy_app_dirs(runtime)
    finally:
        runtime_module.LEGACY_CONFIG_DIR = original_config
        runtime_module.LEGACY_CACHE_DIR = original_cache
        runtime_module.LEGACY_DATA_DIR = original_data

    assert (runtime.config_dir / "config.json").read_text() == '{"ok":true}'
    assert (runtime.cache_dir / "cover.txt").read_text() == "cover"
    assert (runtime.data_dir / "db.sqlite").read_text() == "db"


def test_migrate_legacy_dirs_skips_bulk_audio_caches(tmp_path):
    """Previews and the LRU media cache are re-fetchable, so they don't migrate.

    Copying them doubled disk use on first launch — the real cache reached
    several GB of preview audio — and made every test that pointed
    SOUNDSIBLE_CACHE_DIR at a tmp dir clone the developer's whole cache.
    """
    legacy_cache = tmp_path / "legacy-cache"
    (legacy_cache / "previews").mkdir(parents=True)
    (legacy_cache / "media").mkdir()
    (legacy_cache / "covers").mkdir()
    (legacy_cache / "previews" / "abc.audio").write_text("bulk")
    (legacy_cache / "media" / "track.opus").write_text("bulk")
    (legacy_cache / "cache_index.db").write_text("index")
    (legacy_cache / "covers" / "art.jpg").write_text("art")

    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=tmp_path / "new-config",
        data_dir=tmp_path / "new-data",
        cache_dir=tmp_path / "new-cache",
        log_dir=tmp_path / "new-logs",
        music_dir=tmp_path / "music",
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=False,
    )

    from shared import runtime as runtime_module

    original_cache = runtime_module.LEGACY_CACHE_DIR
    runtime_module.LEGACY_CACHE_DIR = legacy_cache
    try:
        migrate_legacy_app_dirs(runtime)
    finally:
        runtime_module.LEGACY_CACHE_DIR = original_cache

    # Small, expensive-to-rebuild entries still come across.
    assert (runtime.cache_dir / "covers" / "art.jpg").read_text() == "art"
    # Bulk audio and the index that describes it do not.
    assert not (runtime.cache_dir / "previews").exists()
    assert not (runtime.cache_dir / "media").exists()
    assert not (runtime.cache_dir / "cache_index.db").exists()


def test_cache_manager_defaults_under_the_runtime_cache_dir(isolated_runtime):
    """CacheManager used to hardcode ~/.cache/soundsible/media.

    That put the media cache and its SQLite index outside the directory the
    desktop appliance manages, and made the test suite write into the
    developer's real home despite conftest's isolated runtime.
    """
    from player.cache import CacheManager

    manager = CacheManager()

    assert manager.cache_dir == isolated_runtime.cache_dir / "media"
    assert manager.db_path.parent == isolated_runtime.cache_dir
    assert Path("~/.cache/soundsible").expanduser() not in manager.db_path.parents


def test_runtime_uses_persisted_music_dir_when_env_unset(monkeypatch, tmp_path):
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    persisted = (tmp_path / "from_prefs").resolve()
    (cfg / "music_dir.json").write_text(
        json.dumps({"path": str(persisted)}),
        encoding="utf-8",
    )
    monkeypatch.setenv("SOUNDSIBLE_CONFIG_DIR", str(cfg))
    monkeypatch.setenv("SOUNDSIBLE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOUNDSIBLE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("SOUNDSIBLE_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.delenv("SOUNDSIBLE_MUSIC_DIR", raising=False)
    monkeypatch.setenv("SOUNDSIBLE_HOST", "127.0.0.1")
    monkeypatch.setenv("SOUNDSIBLE_PORT", "5044")
    monkeypatch.setenv("SOUNDSIBLE_LAN_ENABLED", "false")

    runtime = RuntimeConfig.default()
    assert runtime.music_dir == persisted
