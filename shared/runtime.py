"""
Runtime configuration and platform-aware app directory helpers.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Mapping, Optional

from platformdirs import PlatformDirs


APP_NAME = "soundsible"
MUSIC_DIR_PREFS_FILENAME = "music_dir.json"
LEGACY_CONFIG_DIR = Path("~/.config/soundsible").expanduser()
LEGACY_CACHE_DIR = Path("~/.cache/soundsible").expanduser()
LEGACY_DATA_DIR = Path("~/.local/share/soundsible").expanduser()


def _platform_dirs() -> PlatformDirs:
    return PlatformDirs(appname=APP_NAME, appauthor=False)


def _env_bool(value: Optional[str], default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _optional_path(value: Optional[str | Path]) -> Optional[Path]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def _default_music_dir() -> Path:
    return (Path.home() / "Music" / "Soundsible").expanduser().resolve()


def load_persisted_music_dir(config_dir: Path) -> Optional[Path]:
    """Return stored music library folder from ``config_dir/music_dir.json``, if valid."""
    path = (config_dir.expanduser().resolve() / MUSIC_DIR_PREFS_FILENAME)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        raw = data.get("path") or data.get("music_dir")
        if not raw or not isinstance(raw, str):
            return None
        return Path(raw).expanduser().resolve()
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def save_persisted_music_dir(config_dir: Path, music_dir: Path) -> None:
    """Write ``music_dir.json`` under config_dir (Phase 1 setup persistence)."""
    config_dir = config_dir.expanduser().resolve()
    config_dir.mkdir(parents=True, exist_ok=True)
    payload = {"path": str(music_dir.resolve()), "updated_at": int(time.time())}
    (config_dir / MUSIC_DIR_PREFS_FILENAME).write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )


def _reserve_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


@dataclass(frozen=True)
class RuntimeConfig:
    host: str
    port: int
    config_dir: Path
    data_dir: Path
    cache_dir: Path
    log_dir: Path
    music_dir: Path
    ui_dist: Optional[Path]
    owner_token_file: Optional[Path]
    lan_enabled: bool
    advanced_mode: bool

    @classmethod
    def default(cls, env: Optional[Mapping[str, str]] = None) -> "RuntimeConfig":
        environment = env or os.environ
        dirs = _platform_dirs()
        config_dir = _optional_path(environment.get("SOUNDSIBLE_CONFIG_DIR")) or Path(dirs.user_config_path).resolve()
        data_dir = _optional_path(environment.get("SOUNDSIBLE_DATA_DIR")) or Path(dirs.user_data_path).resolve()
        cache_dir = _optional_path(environment.get("SOUNDSIBLE_CACHE_DIR")) or Path(dirs.user_cache_path).resolve()
        log_dir = _optional_path(environment.get("SOUNDSIBLE_LOG_DIR")) or Path(dirs.user_log_path).resolve()
        music_dir = _optional_path(environment.get("SOUNDSIBLE_MUSIC_DIR"))
        if music_dir is None:
            persisted = load_persisted_music_dir(config_dir)
            music_dir = persisted if persisted is not None else _default_music_dir()
        ui_dist = _optional_path(environment.get("SOUNDSIBLE_UI_DIST"))
        owner_token_file = _optional_path(environment.get("SOUNDSIBLE_OWNER_TOKEN_FILE"))
        host = (environment.get("SOUNDSIBLE_HOST") or "0.0.0.0").strip() or "0.0.0.0"
        port_raw = (environment.get("SOUNDSIBLE_PORT") or "5005").strip()
        try:
            port = int(port_raw)
        except ValueError:
            port = 5005
        lan_enabled = _env_bool(environment.get("SOUNDSIBLE_LAN_ENABLED"), host not in {"127.0.0.1", "localhost"})
        advanced_mode = _env_bool(environment.get("SOUNDSIBLE_ADVANCED_MODE"), False)
        return cls(
            host=host,
            port=port,
            config_dir=config_dir,
            data_dir=data_dir,
            cache_dir=cache_dir,
            log_dir=log_dir,
            music_dir=music_dir,
            ui_dist=ui_dist,
            owner_token_file=owner_token_file,
            lan_enabled=lan_enabled,
            advanced_mode=advanced_mode,
        )

    def resolved_bind(self) -> tuple[str, int]:
        if self.port != 0:
            return self.host, self.port
        host = self.host or "127.0.0.1"
        return host, _reserve_port(host)


_active_runtime: Optional[RuntimeConfig] = None


def get_runtime_config() -> RuntimeConfig:
    global _active_runtime
    if _active_runtime is None:
        _active_runtime = RuntimeConfig.default()
    return _active_runtime


def configure_runtime(runtime_config: RuntimeConfig) -> RuntimeConfig:
    global _active_runtime
    _active_runtime = runtime_config
    return _active_runtime


def reset_runtime() -> None:
    global _active_runtime
    _active_runtime = None


def runtime_with_overrides(
    *,
    base: Optional[RuntimeConfig] = None,
    host: Optional[str] = None,
    port: Optional[int] = None,
    config_dir: Optional[str | Path] = None,
    data_dir: Optional[str | Path] = None,
    cache_dir: Optional[str | Path] = None,
    log_dir: Optional[str | Path] = None,
    music_dir: Optional[str | Path] = None,
    ui_dist: Optional[str | Path] = None,
    owner_token_file: Optional[str | Path] = None,
    lan_enabled: Optional[bool] = None,
    advanced_mode: Optional[bool] = None,
) -> RuntimeConfig:
    current = base or get_runtime_config()
    return replace(
        current,
        host=host if host is not None else current.host,
        port=port if port is not None else current.port,
        config_dir=_optional_path(config_dir) or current.config_dir,
        data_dir=_optional_path(data_dir) or current.data_dir,
        cache_dir=_optional_path(cache_dir) or current.cache_dir,
        log_dir=_optional_path(log_dir) or current.log_dir,
        music_dir=_optional_path(music_dir) or current.music_dir,
        ui_dist=_optional_path(ui_dist) if ui_dist is not None else current.ui_dist,
        owner_token_file=_optional_path(owner_token_file) if owner_token_file is not None else current.owner_token_file,
        lan_enabled=current.lan_enabled if lan_enabled is None else lan_enabled,
        advanced_mode=current.advanced_mode if advanced_mode is None else advanced_mode,
    )


def ensure_runtime_directories(runtime_config: Optional[RuntimeConfig] = None) -> RuntimeConfig:
    cfg = runtime_config or get_runtime_config()
    for path in (cfg.config_dir, cfg.data_dir, cfg.cache_dir, cfg.log_dir):
        path.mkdir(parents=True, exist_ok=True)
    return cfg


def migrate_legacy_app_dirs(runtime_config: Optional[RuntimeConfig] = None) -> RuntimeConfig:
    cfg = runtime_config or get_runtime_config()
    migrations = (
        (LEGACY_CONFIG_DIR, cfg.config_dir),
        (LEGACY_CACHE_DIR, cfg.cache_dir),
        (LEGACY_DATA_DIR, cfg.data_dir),
    )
    for source, target in migrations:
        if source.resolve() == target.resolve():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if not source.exists() or target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)
    return cfg


def get_config_dir() -> Path:
    return get_runtime_config().config_dir


def get_data_dir() -> Path:
    return get_runtime_config().data_dir


def get_cache_dir() -> Path:
    return get_runtime_config().cache_dir


def get_log_dir() -> Path:
    return get_runtime_config().log_dir


def get_music_dir() -> Path:
    return get_runtime_config().music_dir
