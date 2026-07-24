"""
One-time move from a single-user install to the multi-user layout.

A pre-multiuser instance keeps everything flat in the config directory:
`library.json`, `library.db`, `favourites.json`, playback state, and the queue
in the data directory. Multi-user expects that to belong to *somebody*, so on
first boot we create the admin account and move that state under
`users/<id>/`.

Two properties matter more than elegance here:

* **Idempotent** — running it again on an already-migrated instance does
  nothing, so it is safe to call unconditionally from `start_api`.
* **Reversible** — originals are left in place renamed `*.singleuser.bak`
  rather than deleted, so a bad migration costs a rename to undo.
"""

from __future__ import annotations

import json
import logging
import shutil
import sqlite3
from pathlib import Path
from typing import Optional

from shared.database import INSTANCE_DB_FILENAME, INSTANCE_TABLES, USER_DB_FILENAME, instance_db
from shared.runtime import get_config_dir, get_data_dir

logger = logging.getLogger(__name__)

BACKUP_SUFFIX = ".singleuser.bak"
DEFAULT_ADMIN_USERNAME = "owner"

# config_dir/<source> -> users/<id>/<target>
_CONFIG_FILES = (
    ("library.json", "library.json"),
    (USER_DB_FILENAME, USER_DB_FILENAME),
    ("favourites.json", "favourites.json"),
    ("discovery_settings.json", "discovery_settings.json"),
    ("playback_state_default.json", "playback_state.json"),
)

# data_dir/<source> -> users/<id>/<target>
_DATA_FILES = (("queue_state.json", "queue_state.json"),)

# data_dir/telemetry/<name> -> users/<id>/telemetry/<name>, rotations included
_USER_TELEMETRY_STEMS = ("listening-events.jsonl", "play-timing.jsonl")


def _copy_with_backup(source: Path, target: Path) -> bool:
    """Copy ``source`` to ``target`` and park the original as a backup."""
    if not source.exists() or target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    backup = source.with_name(source.name + BACKUP_SUFFIX)
    try:
        if backup.exists():
            backup.unlink()
        source.rename(backup)
    except OSError as e:
        logger.warning("multiuser migration: kept %s in place (%s)", source, e)
    return True


def _table_columns(conn: sqlite3.Connection, schema: str, table: str) -> list[str]:
    # Schema-qualified PRAGMA is `PRAGMA <schema>.table_info(<table>)`; the
    # `table_info(schema.table)` spelling silently returns nothing.
    try:
        return [row[1] for row in conn.execute(f"PRAGMA {schema}.table_info({table})").fetchall()]
    except sqlite3.OperationalError:
        return []


def migrate_instance_tables(legacy_db: Path, target_db: Path) -> dict[str, int]:
    """Copy accounts, credentials, pairing, and shared caches out of a legacy DB.

    Without this, an upgrade would silently drop paired devices and agent
    tokens and start every shared cache cold. Copies only columns both schemas
    have, so an older `library.db` migrates cleanly.
    """
    copied: dict[str, int] = {}
    if not legacy_db.exists() or legacy_db.resolve() == target_db.resolve():
        return copied

    conn = sqlite3.connect(target_db)
    try:
        conn.execute("ATTACH DATABASE ? AS legacy", (str(legacy_db),))
        try:
            for table in INSTANCE_TABLES:
                target_columns = _table_columns(conn, "main", table)
                legacy_columns = _table_columns(conn, "legacy", table)
                shared = [c for c in target_columns if c in legacy_columns]
                if not shared:
                    continue
                column_list = ", ".join(shared)
                cursor = conn.execute(
                    f"INSERT OR IGNORE INTO main.{table} ({column_list}) "
                    f"SELECT {column_list} FROM legacy.{table}"
                )
                if cursor.rowcount and cursor.rowcount > 0:
                    copied[table] = cursor.rowcount
            conn.commit()
        finally:
            conn.execute("DETACH DATABASE legacy")
    finally:
        conn.close()

    if copied:
        logger.info("multiuser migration: carried over instance rows %s", copied)
    return copied


def _has_single_user_data(config_dir: Path) -> bool:
    return any((config_dir / name).exists() for name, _ in _CONFIG_FILES)


def _adopt_files(user_id: str) -> list[str]:
    """Move the flat single-user state into the new owner's directories."""
    from shared.user_context import user_config_dir, user_data_dir

    config_dir = get_config_dir()
    data_dir = get_data_dir()
    target_config = user_config_dir(user_id)
    target_data = user_data_dir(user_id)
    moved: list[str] = []

    for source_name, target_name in _CONFIG_FILES:
        if _copy_with_backup(config_dir / source_name, target_config / target_name):
            moved.append(source_name)

    for source_name, target_name in _DATA_FILES:
        if _copy_with_backup(data_dir / source_name, target_data / target_name):
            moved.append(source_name)

    telemetry_source = data_dir / "telemetry"
    if telemetry_source.is_dir():
        for stem in _USER_TELEMETRY_STEMS:
            for path in sorted(telemetry_source.glob(f"{stem}*")):
                if path.name.endswith(BACKUP_SUFFIX):
                    continue
                if _copy_with_backup(path, target_data / "telemetry" / path.name):
                    moved.append(f"telemetry/{path.name}")

    return moved


def _adopt_download_queue(user_id: str) -> int:
    """Tag queued downloads that predate accounts so they stay visible."""
    path = get_config_dir() / "download_queue.json"
    if not path.is_file():
        return 0
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    if not isinstance(items, list):
        return 0

    tagged = 0
    for item in items:
        if isinstance(item, dict) and not item.get("user_id"):
            item["user_id"] = user_id
            tagged += 1
    if tagged:
        try:
            path.write_text(json.dumps(items, indent=2), encoding="utf-8")
        except OSError as e:
            logger.warning("multiuser migration: could not tag download queue: %s", e)
            return 0
    return tagged


def ensure_multiuser_layout() -> Optional[dict]:
    """Make sure the instance has at least one account and a user directory.

    Returns a summary dict when something happened, ``None`` when the instance
    was already in shape.
    """
    from shared.users import ROLE_ADMIN, create_user

    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)

    instance_path = config_dir / INSTANCE_DB_FILENAME
    fresh_instance_db = not instance_path.exists()
    db = instance_db()  # creates the file and schema

    if fresh_instance_db:
        migrate_instance_tables(config_dir / USER_DB_FILENAME, instance_path)

    if db.count_users(include_disabled=True) > 0:
        return None

    adopting = _has_single_user_data(config_dir)
    user = create_user(DEFAULT_ADMIN_USERNAME, role=ROLE_ADMIN, display_name="Owner")

    summary = {
        "user_id": user["id"],
        "username": user["username"],
        "adopted_existing_library": adopting,
        "moved": _adopt_files(user["id"]) if adopting else [],
        "download_queue_items_tagged": _adopt_download_queue(user["id"]) if adopting else 0,
    }

    if adopting:
        logger.info(
            "multiuser migration: existing library now belongs to %r (%s); moved %d file(s)",
            user["username"],
            user["id"],
            len(summary["moved"]),
        )
    else:
        logger.info("multiuser migration: created first account %r (%s)", user["username"], user["id"])
    return summary
