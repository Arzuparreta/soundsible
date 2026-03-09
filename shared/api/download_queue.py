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
            
        return {
            "source_type": source_type,
            "song_str": normalized,
            "output_dir": output_dir,
            "metadata_evidence": metadata_evidence,
            "video_id": effective_video_id,
        }, None

    if song_str:
        if "youtube.com" in song_str or "youtu.be" in song_str:
            normalized = normalize_youtube_url(song_str)
            extracted_id = extract_youtube_video_id(normalized)
            if not extracted_id:
                return None, "Playlist-only or invalid YouTube URL (missing v=)"
            return {
                "source_type": SourceType.YOUTUBE_URL,
                "song_str": normalized,
                "output_dir": output_dir,
                "metadata_evidence": metadata_evidence,
                "video_id": extracted_id,
            }, None
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

    def remove_item(self, item_id):
        with self.lock:
            self.queue = [i for i in self.queue if i["id"] != item_id]
        self.save()

    def clear_queue(self):
        with self.lock:
            self.queue = [i for i in self.queue if i["status"] == "downloading"]
        self.save()
