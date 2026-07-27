"""Non-destructive migration from the legacy app-dir layout to one instance."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from shared.instance_layout import InstanceError, create_instance, inspect_instance
from shared.models import LibraryMetadata
from shared.runtime import RuntimeConfig, configure_runtime, get_runtime_config


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _assert_no_external_symlinks(root: Path) -> None:
    if not root.exists():
        return
    resolved_root = root.resolve()
    for path in root.rglob("*"):
        if not path.is_symlink():
            continue
        try:
            path.resolve().relative_to(resolved_root)
        except (OSError, ValueError) as exc:
            raise InstanceError(f"Media symlink escapes the source library: {path}") from exc


def _copy_media(source: Path, destination: Path) -> tuple[int, int]:
    if not source.is_dir():
        return 0, 0
    _assert_no_external_symlinks(source)
    count = 0
    size = 0
    for path in source.rglob("*"):
        if not path.is_file() or path.name == "library.json":
            continue
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target, follow_symlinks=True)
        count += 1
        size += target.stat().st_size
    return count, size


def _copy_shared_instance_tables(source: Path, target: Path) -> dict[str, int]:
    from shared.multiuser_migration import migrate_instance_tables

    return migrate_instance_tables(source, target)


def _copy_discovery(source: Path, target: Path, user_id: str) -> dict[str, int]:
    if not source.is_file():
        return {}
    copied: dict[str, int] = {}
    with sqlite3.connect(target) as conn:
        conn.execute("ATTACH DATABASE ? AS legacy_user", (str(source),))
        try:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM legacy_user.sqlite_master WHERE type='table'"
                ).fetchall()
            }
            if "discovery_signals" in tables:
                cursor = conn.execute(
                    """
                    INSERT OR REPLACE INTO portable_discovery_signals (
                        user_id, identity, media_type, title, artist, show_title,
                        positive_weight, negative_count, updated_at
                    )
                    SELECT ?, identity, media_type, title, artist, show_title,
                           positive_weight, negative_count, updated_at
                    FROM legacy_user.discovery_signals
                    """,
                    (user_id,),
                )
                copied["discovery_signals"] = max(0, cursor.rowcount)
            if "discovery_events" in tables:
                cursor = conn.execute(
                    """
                    INSERT OR REPLACE INTO portable_discovery_events (
                        user_id, id, event, identity, media_type, positive_delta,
                        negative_delta, payload_json, created_at, undone_at
                    )
                    SELECT ?, id, event, identity, media_type, positive_delta,
                           negative_delta, payload_json, created_at, undone_at
                    FROM legacy_user.discovery_events
                    """,
                    (user_id,),
                )
                copied["discovery_events"] = max(0, cursor.rowcount)
            conn.commit()
        finally:
            conn.execute("DETACH DATABASE legacy_user")
    return copied


def _import_user(
    user_id: str,
    legacy_config: Path,
    legacy_data: Path,
) -> dict[str, Any]:
    from shared.database import user_db

    source_config = legacy_config / "users" / user_id
    source_data = legacy_data / "users" / user_id
    if not source_config.is_dir():
        source_config = legacy_config
    if not source_data.is_dir():
        source_data = legacy_data
    db = user_db(user_id)
    manifest = source_config / "library.json"
    metadata = (
        LibraryMetadata.from_json(manifest.read_text(encoding="utf-8"))
        if manifest.is_file()
        else LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    )
    db.sync_from_metadata(metadata)

    favourites = _read_json(source_config / "favourites.json", None)
    if isinstance(favourites, dict):
        db.set_state("favourites", favourites)
    queue = _read_json(source_data / "queue_state.json", None)
    if isinstance(queue, dict):
        db.set_state("queue", queue)
    playback = _read_json(source_config / "playback_state.json", None)
    if isinstance(playback, dict):
        db.set_state("playback", playback)
    discovery_settings = _read_json(source_config / "discovery_settings.json", None)
    if isinstance(discovery_settings, dict):
        db.set_state("discovery_settings", discovery_settings)

    telemetry_count = 0
    telemetry_source = source_data / "telemetry"
    telemetry_target = get_runtime_config().data_dir / "telemetry"
    if telemetry_source.is_dir():
        telemetry_target.mkdir(parents=True, exist_ok=True)
        for path in telemetry_source.iterdir():
            if not path.is_file():
                continue
            shutil.copy2(path, telemetry_target / f"{user_id}-{path.name}")
            telemetry_count += 1

    discovery = _copy_discovery(
        source_config / "library.db",
        get_runtime_config().config_dir / "soundsible.db",
        user_id,
    )
    return {
        "tracks": len(metadata.tracks),
        "playlists": len(metadata.playlists),
        "telemetry_files": telemetry_count,
        **discovery,
    }


def _portable_config_from_legacy(source: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    raw = _read_json(source, {})
    if not isinstance(raw, dict):
        raw = {}
    pending = {
        key: raw.get(key)
        for key in ("provider", "endpoint", "bucket", "region", "public")
        if raw.get(key) not in (None, "")
    }
    portable = dict(raw)
    portable.update(
        {
            "provider": "local",
            "endpoint": "media",
            "bucket": "",
            "access_key_id": "",
            "secret_access_key": "",
            "is_encrypted": False,
            "cache_location": "cache/musicplayer",
            "watch_folders": ["media/tracks"],
        }
    )
    return portable, pending


def migrate_legacy_instance(
    destination: str | Path,
    *,
    legacy_config_dir: Optional[str | Path] = None,
    legacy_data_dir: Optional[str | Path] = None,
    legacy_music_dir: Optional[str | Path] = None,
) -> dict[str, Any]:
    """Create a verified portable instance without mutating the source."""
    source_runtime = RuntimeConfig.default({})
    config_dir = Path(legacy_config_dir or source_runtime.config_dir).expanduser().resolve()
    data_dir = Path(legacy_data_dir or source_runtime.data_dir).expanduser().resolve()
    music_dir = Path(legacy_music_dir or source_runtime.music_dir).expanduser().resolve()
    target = Path(destination).expanduser().resolve()
    if target.exists() and any(target.iterdir()):
        raise InstanceError(f"Migration destination must be empty: {target}")
    if target.exists():
        target.rmdir()

    staging = target.with_name(f".{target.name}.migrating-{uuid.uuid4().hex[:8]}")
    layout = create_instance(staging, display_name=target.name)
    report: dict[str, Any] = {
        "source": {
            "config_dir": str(config_dir),
            "data_dir": str(data_dir),
            "music_dir": str(music_dir),
        },
        "destination": str(target),
        "started_at": int(time.time()),
        "users": {},
    }
    try:
        runtime = RuntimeConfig.default({"SOUNDSIBLE_INSTANCE_DIR": str(staging)})
        configure_runtime(runtime)

        from shared.database import instance_db
        from shared.users import create_user, list_users

        target_db = instance_db()
        source_instance = config_dir / "instance.db"
        report["instance_tables"] = _copy_shared_instance_tables(
            source_instance if source_instance.is_file() else config_dir / "library.db",
            Path(target_db.db_path),
        )
        if not list_users():
            create_user("owner", role="admin", display_name="Owner")

        portable_config, pending_cloud = _portable_config_from_legacy(config_dir / "config.json")
        (layout.root / "config.json").write_text(
            json.dumps(portable_config, indent=2),
            encoding="utf-8",
        )
        if pending_cloud and pending_cloud.get("provider") not in (None, "local"):
            target_db.set_instance_state("cloud_reauthentication", pending_cloud)

        media_files, media_bytes = _copy_media(music_dir, layout.media_dir)
        report["media_files"] = media_files
        report["media_bytes"] = media_bytes

        catalog_path = music_dir / "library.json"
        if catalog_path.is_file():
            catalog = LibraryMetadata.from_json(catalog_path.read_text(encoding="utf-8"))
            target_db.set_instance_state(
                "physical_catalog",
                json.loads(catalog.to_json()),
            )
            report["catalog_tracks"] = len(catalog.tracks)

        queue = _read_json(config_dir / "download_queue.json", None)
        if isinstance(queue, list):
            target_db.set_instance_state("download_queue", queue)
            report["download_queue_items"] = len(queue)

        for user in list_users():
            user_id = user["id"]
            report["users"][user_id] = _import_user(user_id, config_dir, data_dir)

        report["finished_at"] = int(time.time())
        report_path = layout.data_dir / "migration-report.json"
        audit_report = {
            **report,
            "source": {
                "config_dir_name": config_dir.name,
                "data_dir_name": data_dir.name,
                "music_dir_name": music_dir.name,
            },
            "destination": ".",
        }
        report_path.write_text(json.dumps(audit_report, indent=2), encoding="utf-8")
        check = inspect_instance(staging)
        if not check.get("ok"):
            raise InstanceError(f"Migrated database failed integrity check: {check}")
        os.replace(staging, target)
        report["instance_id"] = check["instance_id"]
        report["integrity_check"] = check.get("integrity_check")
        return report
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
