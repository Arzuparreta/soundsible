"""Portable Soundsible instance layout.

An instance is the unit a person moves between machines.  The application
binary is installed separately; all durable instance data and media live below
one directory and are addressed relative to that directory.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


MARKER_FILENAME = "soundsible.instance.json"
DATABASE_FILENAME = "soundsible.db"
FORMAT_VERSION = 1


class InstanceError(RuntimeError):
    """Raised when a portable instance cannot be opened safely."""


@dataclass(frozen=True)
class InstanceLayout:
    root: Path

    @classmethod
    def at(cls, root: str | Path) -> "InstanceLayout":
        return cls(Path(root).expanduser().resolve())

    @property
    def marker(self) -> Path:
        return self.root / MARKER_FILENAME

    @property
    def database(self) -> Path:
        return self.root / DATABASE_FILENAME

    @property
    def media_dir(self) -> Path:
        return self.root / "media"

    @property
    def tracks_dir(self) -> Path:
        return self.media_dir / "tracks"

    @property
    def data_dir(self) -> Path:
        return self.root / "data"

    @property
    def telemetry_dir(self) -> Path:
        return self.data_dir / "telemetry"

    @property
    def cache_dir(self) -> Path:
        return self.root / "cache"

    @property
    def log_dir(self) -> Path:
        return self.root / "logs"

    @property
    def runtime_dir(self) -> Path:
        return self.root / "runtime"

    @property
    def backups_dir(self) -> Path:
        return self.root / "backups"

    def read_marker(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.marker.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise InstanceError(f"Not a Soundsible instance: {self.root}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise InstanceError(f"Invalid instance marker: {self.marker}") from exc
        if raw.get("format_version") != FORMAT_VERSION or not raw.get("instance_id"):
            raise InstanceError(f"Unsupported instance marker: {self.marker}")
        return raw

    @property
    def instance_id(self) -> str:
        return str(self.read_marker()["instance_id"])

    def ensure_directories(self) -> None:
        for path in (
            self.root,
            self.media_dir,
            self.tracks_dir,
            self.data_dir,
            self.telemetry_dir,
            self.cache_dir,
            self.log_dir,
            self.runtime_dir,
            self.backups_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def contains(self, path: str | Path) -> bool:
        try:
            Path(path).expanduser().resolve().relative_to(self.root)
            return True
        except (OSError, ValueError):
            return False

    def require_internal_path(self, path: str | Path) -> Path:
        resolved = Path(path).expanduser().resolve()
        if not self.contains(resolved):
            raise InstanceError(f"Path escapes the Soundsible instance: {resolved}")
        return resolved


def create_instance(root: str | Path, *, display_name: Optional[str] = None) -> InstanceLayout:
    layout = InstanceLayout.at(root)
    layout.root.mkdir(parents=True, exist_ok=True)
    if layout.marker.exists():
        layout.read_marker()
        layout.ensure_directories()
        _ensure_local_config(layout)
        return layout
    occupied = [p for p in layout.root.iterdir() if p.name != ".DS_Store"]
    if occupied:
        raise InstanceError(
            f"Choose an empty directory or an existing Soundsible instance: {layout.root}"
        )
    marker = {
        "format_version": FORMAT_VERSION,
        "instance_id": uuid.uuid4().hex,
        "display_name": (display_name or layout.root.name or "Soundsible").strip(),
        "created_at": int(time.time()),
    }
    layout.marker.write_text(json.dumps(marker, indent=2), encoding="utf-8")
    layout.ensure_directories()
    _ensure_local_config(layout)
    return layout


def _ensure_local_config(layout: InstanceLayout) -> None:
    """Create portable, non-secret local storage configuration."""
    path = layout.root / "config.json"
    if path.exists():
        return
    path.write_text(
        json.dumps(
            {
                "provider": "local",
                "endpoint": "media",
                "bucket": "",
                "access_key_id": "",
                "secret_access_key": "",
                "region": None,
                "public": False,
                "cache_max_size_gb": 50,
                "cache_location": "cache/musicplayer",
                "quality_preference": "high",
                "watch_folders": ["media/tracks"],
                "is_encrypted": False,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def open_instance(root: str | Path) -> InstanceLayout:
    layout = InstanceLayout.at(root)
    layout.read_marker()
    layout.ensure_directories()
    return layout


def inspect_instance(root: str | Path) -> dict[str, Any]:
    layout = open_instance(root)
    result: dict[str, Any] = {
        "ok": True,
        "root": str(layout.root),
        "instance_id": layout.instance_id,
        "format_version": FORMAT_VERSION,
        "database": str(layout.database),
        "database_exists": layout.database.is_file(),
        "media_files": 0,
        "media_bytes": 0,
    }
    for path in layout.tracks_dir.rglob("*"):
        if path.is_file():
            result["media_files"] += 1
            try:
                result["media_bytes"] += path.stat().st_size
            except OSError:
                pass
    if layout.database.is_file():
        try:
            with sqlite3.connect(layout.database) as conn:
                row = conn.execute("PRAGMA integrity_check").fetchone()
                result["integrity_check"] = row[0] if row else "unknown"
                result["schema_version"] = conn.execute("PRAGMA user_version").fetchone()[0]
            result["ok"] = result["integrity_check"] == "ok"
        except sqlite3.Error as exc:
            result["ok"] = False
            result["database_error"] = str(exc)
    return result


def backup_database(root: str | Path, destination: str | Path | None = None) -> Path:
    layout = open_instance(root)
    if not layout.database.is_file():
        raise InstanceError(f"Instance database does not exist: {layout.database}")
    if destination is None:
        destination = layout.backups_dir / time.strftime("soundsible-%Y%m%d-%H%M%S.db")
    target = Path(destination).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(layout.database) as source, sqlite3.connect(target) as output:
        source.backup(output)
    return target


class InstanceLock:
    """Cross-platform exclusive lock held for the lifetime of the engine."""

    def __init__(self, layout: InstanceLayout):
        self.layout = layout
        self.path = layout.runtime_dir / "instance.lock"
        self._handle = None

    def acquire(self) -> None:
        self.layout.runtime_dir.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, "a+", encoding="utf-8")
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError) as exc:
            handle.close()
            raise InstanceError(f"Instance is already open: {self.layout.root}") from exc
        handle.seek(0)
        handle.truncate()
        handle.write(json.dumps({"pid": os.getpid(), "opened_at": int(time.time())}))
        handle.flush()
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
            self._handle = None
            try:
                self.path.unlink()
            except OSError:
                pass

    def __enter__(self) -> "InstanceLock":
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()
