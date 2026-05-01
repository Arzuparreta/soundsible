"""
Download queue manager and library file watcher for the Station Engine.
"""

import json
import logging
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from watchdog.events import FileSystemEventHandler

from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME, SourceType
from shared.url_utils import normalize_youtube_url, extract_youtube_video_id

logger = logging.getLogger(__name__)


def _merge_display_fields(base: dict, item: dict, effective_video_id: str | None) -> dict:
    """Attach UI-facing fields from the client (title, cover, duration)."""
    dt = item.get("display_title")
    if dt is not None and str(dt).strip():
        base["display_title"] = str(dt).strip()
    da = item.get("display_artist")
    if da is not None and str(da).strip():
        base["display_artist"] = str(da).strip()
    tu = item.get("thumbnail_url")
    if tu is not None and str(tu).strip():
        base["thumbnail_url"] = str(tu).strip()
    elif effective_video_id:
        base["thumbnail_url"] = f"https://img.youtube.com/vi/{effective_video_id}/mqdefault.jpg"
    ds = item.get("duration_sec")
    if ds is not None:
        try:
            base["duration_sec"] = int(ds)
        except (TypeError, ValueError):
            pass
    return base


def parse_intake_item(item: dict) -> tuple[dict | None, str | None]:
    """Validate and normalize intake schema for /api/downloader/queue."""
    if not isinstance(item, dict):
        return None, "Item must be an object"

    source_type = (item.get("source_type") or item.get("type") or "").strip() or None
    song_str = (item.get("song_str") or "").strip()
    video_id = (item.get("video_id") or "").strip() or None
    metadata_evidence = item.get("metadata_evidence") if isinstance(item.get("metadata_evidence"), dict) else None
    output_dir = item.get("output_dir")
    
    if item.get("spotify_data") or (song_str and "spotify.com" in song_str):
        return None, "This link type is not supported"

    # Note: Normalize source_type to standardized enums
    # Note: Handle legacy aliases (like 'music' or 'ytmusic') to canonical enums
    if source_type in ("music", "ytmusic", "ytmusic_search"):
        if source_type != SourceType.YTMUSIC_SEARCH:
            logger.info("API: Normalizing legacy source '%s' to '%s'", source_type, SourceType.YTMUSIC_SEARCH)
        source_type = SourceType.YTMUSIC_SEARCH
    elif source_type in ("youtube", "youtube_search"):
        if source_type != SourceType.YOUTUBE_SEARCH:
            logger.info("API: Normalizing legacy source '%s' to '%s'", source_type, SourceType.YOUTUBE_SEARCH)
        source_type = SourceType.YOUTUBE_SEARCH

    if source_type in {SourceType.YOUTUBE_URL, SourceType.YOUTUBE_SEARCH, SourceType.YTMUSIC_SEARCH}:
        normalized = normalize_youtube_url(song_str)
        extracted_id = extract_youtube_video_id(normalized or song_str)
        effective_video_id = video_id or extracted_id or (metadata_evidence or {}).get("video_id")
        
        if not normalized or ("youtube.com" not in normalized and "youtu.be" not in normalized) or not effective_video_id:
            return None, "Invalid or unsupported YouTube URL or missing video_id"

        base = {
            "source_type": source_type,
            "song_str": normalized,
            "output_dir": output_dir,
            "metadata_evidence": metadata_evidence,
            "video_id": effective_video_id,
        }
        _merge_display_fields(base, item, effective_video_id)
        return base, None

    if song_str:
        if "youtube.com" in song_str or "youtu.be" in song_str:
            normalized = normalize_youtube_url(song_str)
            extracted_id = extract_youtube_video_id(normalized)
            if not extracted_id:
                return None, "Playlist-only or invalid YouTube URL (missing v=)"
            base = {
                "source_type": SourceType.YOUTUBE_URL,
                "song_str": normalized,
                "output_dir": output_dir,
                "metadata_evidence": metadata_evidence,
                "video_id": extracted_id,
            }
            _merge_display_fields(base, item, extracted_id)
            return base, None
        return {
            "source_type": "manual",
            "song_str": song_str,
            "output_dir": output_dir,
            "metadata_evidence": metadata_evidence,
        }, None

    return None, "Missing source_type/song_str"


class LibraryFileWatcher(FileSystemEventHandler):
    """Watches library.json for changes and triggers SocketIO updates."""

    def __init__(self, lib_manager, socketio=None):
        self.lib_manager = lib_manager
        self.socketio = socketio
        self.last_sync = 0

    def on_modified(self, event):
        if event.src_path.endswith(LIBRARY_METADATA_FILENAME):
            now = time.time()
            if now - self.last_sync < 2:
                return
            self.last_sync = now

            logger.info("API: Detected external change to %s. Refreshing...", LIBRARY_METADATA_FILENAME)
            self.lib_manager.refresh_if_stale()
            if self.socketio:
                self.socketio.emit("library_updated")


class DownloadQueueManager:
    """Manages the download queue for the Station Engine."""

    def __init__(self, storage_path=None, socketio=None):
        if storage_path is None:
            storage_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "download_queue.json"
        self.storage_path = Path(storage_path)
        self.socketio = socketio

        if self.storage_path.exists():
            try:
                self.storage_path.unlink()
            except OSError:
                pass

        self.queue = []
        self.lock = threading.RLock()
        self.is_processing = False
        self.log_buffer = []
        self.max_logs = 50
        self._progress_emit_min_gap_sec = 0.3
        self._progress_emit_min_pct_delta = 2.0

    def add_log(self, msg):
        log_entry = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        with self.lock:
            self.log_buffer.append(log_entry)
            if len(self.log_buffer) > self.max_logs:
                self.log_buffer.pop(0)
        logger.info("API: [Queue] %s", msg)
        if self.socketio:
            self.socketio.emit("downloader_log", {"data": msg})

    def _load(self):
        if self.storage_path.exists():
            try:
                with open(self.storage_path, "r") as f:
                    data = json.load(f)
                    return data if isinstance(data, list) else []
            except Exception as e:
                logger.warning("API: Error loading download queue: %s", e)
        return []

    def save(self):
        try:
            self.storage_path.parent.mkdir(parents=True, exist_ok=True)
            with self.lock:
                with open(self.storage_path, "w") as f:
                    json.dump(self.queue, f, indent=2)
        except Exception as e:
            logger.warning("API: Error saving download queue: %s", e)

    def add(self, item):
        with self.lock:
            if not isinstance(item, dict):
                item = {"song_str": str(item)}

            item["id"] = item.get("id", str(uuid.uuid4()))
            item["status"] = "pending"
            item["added_at"] = datetime.utcnow().isoformat() + "Z"
            self.queue.append(item)

        self.save()
        return item

    def get_pending(self):
        with self.lock:
            return [i for i in self.queue if i["status"] == "pending"]

    def update_status(self, item_id, status, error=None):
        do_save = False
        with self.lock:
            for item in self.queue:
                if item["id"] == item_id:
                    item["status"] = status
                    if error:
                        item["error"] = error
                    do_save = True
                    break
        if do_save:
            self.save()

    def update_progress(
        self,
        item_id,
        *,
        percent=None,
        speed=None,
        eta=None,
        phase=None,
        total_bytes=None,
    ):
        """Update in-flight download progress; throttles socket emits (≥2% jump or ≥300ms)."""
        emit_payload = None
        now = time.time()
        found = False
        with self.lock:
            for item in self.queue:
                if item["id"] != item_id:
                    continue
                found = True
                if percent is not None:
                    try:
                        item["progress_percent"] = float(percent)
                    except (TypeError, ValueError):
                        pass
                if speed is not None:
                    item["speed"] = speed
                if eta is not None:
                    item["eta"] = eta
                if phase is not None:
                    item["phase"] = phase
                if total_bytes is not None:
                    try:
                        item["total_bytes"] = int(total_bytes)
                    except (TypeError, ValueError):
                        pass

                last_ts = float(item.get("_progress_emit_ts") or 0)
                last_pct = item.get("_progress_emit_pct")
                cur_pct = item.get("progress_percent")
                last_phase = item.get("_last_emitted_phase")

                should_emit = False
                if last_ts == 0 and cur_pct is not None:
                    should_emit = True
                elif now - last_ts >= self._progress_emit_min_gap_sec:
                    should_emit = True
                elif (
                    last_pct is not None
                    and cur_pct is not None
                    and abs(float(cur_pct) - float(last_pct)) >= self._progress_emit_min_pct_delta
                ):
                    should_emit = True
                elif phase is not None and phase != last_phase:
                    should_emit = True

                if should_emit:
                    item["_progress_emit_ts"] = now
                    if cur_pct is not None:
                        item["_progress_emit_pct"] = cur_pct
                    if phase is not None:
                        item["_last_emitted_phase"] = phase
                    emit_payload = {
                        "id": item_id,
                        "status": "downloading",
                        "progress_percent": item.get("progress_percent"),
                        "speed": item.get("speed"),
                        "eta": item.get("eta"),
                        "phase": item.get("phase"),
                        "total_bytes": item.get("total_bytes"),
                    }
                break

        if not found:
            return

        self.save()
        if emit_payload and self.socketio:
            try:
                self.socketio.emit("downloader_update", emit_payload)
            except Exception as e:
                logger.warning("API: downloader_update emit failed: %s", e)

    def remove_item(self, item_id):
        with self.lock:
            self.queue = [i for i in self.queue if i["id"] != item_id]
        self.save()

    def clear_queue(self):
        with self.lock:
            self.queue = [i for i in self.queue if i["status"] == "downloading"]
        self.save()
