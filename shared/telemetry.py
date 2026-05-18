"""
Local-only JSONL telemetry sinks under runtime data_dir/telemetry/.

See docs/TELEMETRY_PRIVACY.md. No network egress from this module.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Mapping, Optional

from shared.runtime import RuntimeConfig, get_runtime_config

logger = logging.getLogger(__name__)

DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_ROTATED = 5
FSYNC_EVENT_INTERVAL = 64
FSYNC_TIME_SEC = 5.0

_CATEGORY_FILENAMES = {
    "setup-events": "setup-events.jsonl",
    "migration-events": "migration-events.jsonl",
    "play-timing": "play-timing.jsonl",
}


def _normalize_category(category: str) -> str:
    key = category.strip().lower().replace("_", "-")
    aliases = {
        "setup": "setup-events",
        "migration": "migration-events",
        "play_timing": "play-timing",
        "playtiming": "play-timing",
    }
    key = aliases.get(key, key)
    if key not in _CATEGORY_FILENAMES:
        raise ValueError(
            f"Unknown telemetry category {category!r}; "
            f"expected one of {sorted(_CATEGORY_FILENAMES)}"
        )
    return key


def is_telemetry_enabled() -> bool:
    raw = os.environ.get("SOUNDSIBLE_TELEMETRY_ENABLED")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _max_rotated() -> int:
    raw = os.environ.get("SOUNDSIBLE_TELEMETRY_MAX_ROTATIONS")
    if raw:
        try:
            return max(1, int(raw.strip()))
        except ValueError:
            logger.warning("Invalid SOUNDSIBLE_TELEMETRY_MAX_ROTATIONS=%r", raw)
    return DEFAULT_MAX_ROTATED


def _max_file_bytes() -> int:
    raw = os.environ.get("SOUNDSIBLE_TELEMETRY_MAX_FILE_BYTES")
    if raw:
        try:
            return max(1024, int(raw.strip()))
        except ValueError:
            logger.warning("Invalid SOUNDSIBLE_TELEMETRY_MAX_FILE_BYTES=%r", raw)
    return DEFAULT_MAX_FILE_BYTES


class _CategorySink:
    """Append-only JSONL for one file with rotation and batched fsync."""

    def __init__(self, telemetry_dir: Path, filename: str, max_bytes: int, max_rotated: int) -> None:
        self.path = telemetry_dir / filename
        self.max_bytes = max_bytes
        self.max_rotated = max_rotated
        self._fh: Optional[Any] = None
        self._events_since_fsync = 0
        self._last_fsync_mono = 0.0

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.flush()
                os.fsync(self._fh.fileno())
            except OSError as e:
                logger.debug("telemetry sink fsync on close: %s", e)
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None

    def _ensure_open(self) -> None:
        if self._fh is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a", encoding="utf-8")
        self._last_fsync_mono = time.monotonic()

    def append_line(self, line: str) -> None:
        self._ensure_open()
        assert self._fh is not None
        self._fh.write(line)
        self._fh.flush()
        self._events_since_fsync += 1
        now = time.monotonic()
        if self._events_since_fsync >= FSYNC_EVENT_INTERVAL or (now - self._last_fsync_mono) >= FSYNC_TIME_SEC:
            try:
                os.fsync(self._fh.fileno())
            except OSError as e:
                logger.warning("telemetry fsync failed: %s", e)
            self._events_since_fsync = 0
            self._last_fsync_mono = now

        try:
            if self._fh.tell() >= self.max_bytes:
                self._rotate_unlocked()
        except OSError as e:
            logger.warning("telemetry rotation check failed: %s", e)

    def _rotate_unlocked(self) -> None:
        if self._fh is not None:
            self._fh.flush()
            try:
                os.fsync(self._fh.fileno())
            except OSError:
                pass
            self._fh.close()
            self._fh = None

        if not self.path.exists() or self.path.stat().st_size == 0:
            return

        last = self.path.with_name(f"{self.path.name}.{self.max_rotated}.gz")
        if last.exists():
            try:
                last.unlink()
            except OSError as e:
                logger.warning("telemetry could not remove oldest rotation: %s", e)

        for i in range(self.max_rotated - 1, 0, -1):
            src = self.path.with_name(f"{self.path.name}.{i}.gz")
            dst = self.path.with_name(f"{self.path.name}.{i + 1}.gz")
            if src.exists():
                try:
                    if dst.exists():
                        dst.unlink()
                    src.rename(dst)
                except OSError as e:
                    logger.warning("telemetry rotation rename %s -> %s: %s", src, dst, e)

        gz_path = self.path.with_name(f"{self.path.name}.1.gz")
        try:
            with open(self.path, "rb") as raw, gzip.open(gz_path, "wb") as gz:
                gz.write(raw.read())
            self.path.unlink()
        except OSError as e:
            logger.error("telemetry gzip rotate failed, leaving active file: %s", e)


class TelemetryWriter:
    def __init__(
        self,
        telemetry_dir: Path,
        *,
        max_bytes: Optional[int] = None,
        max_rotated: Optional[int] = None,
    ) -> None:
        self._telemetry_dir = telemetry_dir
        self._max_bytes = max_bytes if max_bytes is not None else _max_file_bytes()
        self._max_rotated = max_rotated if max_rotated is not None else _max_rotated()
        self._sinks: dict[str, _CategorySink] = {}

    def close(self) -> None:
        for sink in self._sinks.values():
            sink.close()
        self._sinks.clear()

    def emit_line(self, norm_category: str, line: str) -> None:
        sink = self._sinks.get(norm_category)
        if sink is None:
            sink = _CategorySink(
                self._telemetry_dir,
                _CATEGORY_FILENAMES[norm_category],
                self._max_bytes,
                self._max_rotated,
            )
            self._sinks[norm_category] = sink
        sink.append_line(line)


_lock = threading.Lock()
_writer: Optional[TelemetryWriter] = None


def init_telemetry(runtime_config: Optional[RuntimeConfig] = None) -> None:
    """Create telemetry sinks under ``data_dir/telemetry``. Safe to call again (replaces writer)."""
    global _writer
    runtime = runtime_config or get_runtime_config()
    telemetry_dir = runtime.data_dir / "telemetry"
    with _lock:
        if _writer is not None:
            _writer.close()
        telemetry_dir.mkdir(parents=True, exist_ok=True)
        _writer = TelemetryWriter(telemetry_dir)


def reset_telemetry() -> None:
    """Close sinks and clear the process-global writer (tests / process reload)."""
    global _writer
    with _lock:
        if _writer is not None:
            _writer.close()
        _writer = None


def emit(category: str, event: Mapping[str, Any]) -> None:
    """Append one JSON object as a line to the category's JSONL sink."""
    global _writer
    if not is_telemetry_enabled():
        return
    norm = _normalize_category(category)
    line = json.dumps(dict(event), ensure_ascii=False, separators=(",", ":")) + "\n"
    with _lock:
        if _writer is None:
            runtime = get_runtime_config()
            telemetry_dir = runtime.data_dir / "telemetry"
            telemetry_dir.mkdir(parents=True, exist_ok=True)
            _writer = TelemetryWriter(telemetry_dir)
        _writer.emit_line(norm, line)