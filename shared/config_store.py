"""Instance configuration with machine-local portable secrets."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from platformdirs import PlatformDirs

from shared.crypto import CredentialManager
from shared.instance_layout import InstanceLayout
from shared.runtime import get_runtime_config


SECRET_FIELDS = (
    "access_key_id",
    "secret_access_key",
    "r2_access_key",
    "r2_secret_key",
)
PORTABLE_DOWNLOADER_STATE = "downloader_config"


def _secret_path(instance_id: str) -> Path:
    root = Path(PlatformDirs(appname="soundsible", appauthor=False).user_config_path)
    return root / "machine-secrets" / f"{instance_id}.json"


def _instance_id() -> str | None:
    runtime = get_runtime_config()
    if runtime.instance_dir is None:
        return None
    return InstanceLayout.at(runtime.instance_dir).instance_id


def load_machine_secrets() -> dict[str, str]:
    instance_id = _instance_id()
    if not instance_id:
        return {}
    path = _secret_path(instance_id)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, str] = {}
    for field in SECRET_FIELDS:
        encrypted = raw.get(field)
        if not isinstance(encrypted, str):
            continue
        value = CredentialManager.decrypt(encrypted)
        if value is not None:
            out[field] = value
    return out


def save_machine_secrets(values: dict[str, Any]) -> None:
    instance_id = _instance_id()
    if not instance_id:
        return
    existing = load_machine_secrets()
    for field in SECRET_FIELDS:
        value = values.get(field)
        if isinstance(value, str) and value:
            existing[field] = value
    path = _secret_path(instance_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        field: CredentialManager.encrypt(value)
        for field, value in existing.items()
        if field in SECRET_FIELDS and value
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_config_dict(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if get_runtime_config().instance_dir is not None:
        data.update(load_machine_secrets())
        data["is_encrypted"] = False
    return data


def save_config_dict(path: Path, data: dict[str, Any]) -> None:
    from shared.models import PlayerConfig

    path.parent.mkdir(parents=True, exist_ok=True)
    if get_runtime_config().instance_dir is not None:
        save_machine_secrets(data)
        portable = dict(data)
        for field in SECRET_FIELDS:
            portable[field] = ""
        portable["is_encrypted"] = False
        config = PlayerConfig.from_dict(portable)
        path.write_text(json.dumps(config.to_dict(encrypt=False), indent=2), encoding="utf-8")
        return
    config = PlayerConfig.from_dict(data)
    path.write_text(config.to_json(), encoding="utf-8")


def load_portable_downloader_config() -> dict[str, Any]:
    """Return portable downloader settings, merging machine-bound credentials."""
    runtime = get_runtime_config()
    if runtime.instance_dir is None:
        return {}
    from shared.database import instance_db

    stored = instance_db().get_instance_state(PORTABLE_DOWNLOADER_STATE, {})
    config = dict(stored) if isinstance(stored, dict) else {}
    secrets = load_machine_secrets()
    for field in ("r2_access_key", "r2_secret_key"):
        if secrets.get(field):
            config[field] = secrets[field]
    config["output_dir"] = str(runtime.music_dir)
    return config


def save_portable_downloader_config(data: dict[str, Any]) -> dict[str, Any]:
    """Persist portable settings in SQLite and credentials on this machine."""
    runtime = get_runtime_config()
    if runtime.instance_dir is None:
        raise RuntimeError("Portable downloader settings require an instance")
    from shared.database import instance_db

    current = load_portable_downloader_config()
    allowed = {
        "quality",
        "auto_update_ytdlp",
        "r2_account_id",
        "r2_bucket",
    }
    stored = {key: current[key] for key in allowed if key in current}
    for key in allowed:
        if key in data:
            stored[key] = data[key]
    save_machine_secrets(data)
    instance_db().set_instance_state(PORTABLE_DOWNLOADER_STATE, stored)
    return load_portable_downloader_config()
