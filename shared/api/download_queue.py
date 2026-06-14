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

from shared.time_utils import utc_now_iso_z

from watchdog.events import FileSystemEventHandler

from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME, SourceType
from shared.text_utils import sanitize_cli_message
from shared.url_utils import normalize_youtube_url, extract_youtube_video_id

logger = logging.getLogger(__name__)


def classify_download_error(error) -> tuple[str, str]:
    """Return a stable UI-facing kind and concise message for downloader failures.

    Checks run in priority order. A few branches are deliberately ordered to win
    over more generic ones whose substrings they also contain: age restriction
    before authentication ("Sign in to confirm your age" matches both), and geo
    restriction before the generic "unavailable" branch ("not available in your
    country" also contains "not available").
    """
    clean = sanitize_cli_message(str(error or ""))
    lowered = clean.lower()
    if "bytes read" in lowered and "more expected" in lowered:
        return "partial_read", "YouTube closed the connection before the file finished downloading."
    if "timed out" in lowered or "timeout" in lowered:
        return "timeout", "The connection to YouTube timed out."
    if "requested format is not available" in lowered:
        return "format_unavailable", "YouTube did not expose a compatible audio format."
    if (
        "confirm your age" in lowered
        or "age-restricted" in lowered
        or "age restricted" in lowered
        or "inappropriate for some users" in lowered
    ):
        return "age_restricted", "This video is age-restricted. Add YouTube cookies in Settings to download it."
    if "sign in to confirm" in lowered or "not a bot" in lowered:
        return "authentication_required", "YouTube requires refreshed authentication cookies."
    if "this video is private" in lowered or "private video" in lowered:
        return "private_video", "This video is private and can't be downloaded."
    if (
        "in your country" in lowered
        or "in your location" in lowered
        or "from your location" in lowered
        or "geo restriction" in lowered
        or "geo-restrict" in lowered
    ):
        return "geo_restricted", "This video isn't available in your region."
    if "members-only" in lowered or "members only" in lowered or "join this channel" in lowered:
        return "members_only", "This video is members-only and can't be downloaded."
    # Checked before the generic "unavailable" branch: copyright takedowns
    # usually also report "no longer available", but the specific reason helps.
    if "copyright" in lowered:
        return "copyright", "This video was blocked on copyright grounds and can't be downloaded."
    if (
        "video unavailable" in lowered
        or "video is unavailable" in lowered
        or "video is not available" in lowered
        or "video isn't available" in lowered
        or "no longer available" in lowered
        or "has been removed" in lowered
        or "removed by the user" in lowered
        or "account associated with this video has been terminated" in lowered
    ):
        return "video_unavailable", "This video is unavailable or has been removed from YouTube."
    if "http error 429" in lowered or "too many requests" in lowered or "rate-limit" in lowered or "rate limit" in lowered:
        return "rate_limited", "YouTube is rate-limiting downloads right now. Wait a few minutes and try again."
    if "no space left on device" in lowered:
        return "disk_full", "The Station does not have enough free disk space."
    if (
        "unable to connect" in lowered
        or "connection reset" in lowered
        or "connection refused" in lowered
        or "network is unreachable" in lowered
        or "no route to host" in lowered
        or "temporary failure in name resolution" in lowered
        or "name or service not known" in lowered
        or "failed to resolve" in lowered
        or "getaddrinfo" in lowered
    ):
        return "network_error", "The Station could not reach YouTube. Check its internet connection."

    meaningful = []
    for line in clean.splitlines():
        line = line.strip()
        if line and not line.startswith("[download]"):
            meaningful.append(line)
    message = meaningful[-1] if meaningful else clean or "The download failed."
    return "download_failed", message[:300]


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

    if source_type in ("podcast_enclosure", SourceType.PODCAST_ENCLOSURE):
        source_type = SourceType.PODCAST_ENCLOSURE
        enclosure_url = (item.get("enclosure_url") or song_str or "").strip()
        if not enclosure_url:
            return None, "Missing enclosure_url"
        try:
            from shared.podcast_rss import assert_safe_http_url

            assert_safe_http_url(enclosure_url)
        except ValueError as e:
            return None, str(e)
        feed_id = (item.get("feed_id") or item.get("podcast_feed_id") or "").strip()
        episode_guid = (item.get("episode_guid") or item.get("guid") or "").strip()
        title = (item.get("title") or item.get("display_title") or "").strip() or "Episode"
        show_title = (item.get("show_title") or item.get("display_artist") or "").strip() or "Podcast"
        album = (item.get("album") or "").strip() or show_title
        thumb = (item.get("thumbnail_url") or "").strip()
        rss_url = (item.get("podcast_rss_url") or "").strip()
        duration_int = 0
        ds = item.get("duration_sec")
        if ds is not None:
            try:
                duration_int = int(ds)
            except (TypeError, ValueError):
                pass
        base = {
            "source_type": SourceType.PODCAST_ENCLOSURE,
            "song_str": enclosure_url,
            "enclosure_url": enclosure_url,
            "output_dir": output_dir,
            "metadata_evidence": metadata_evidence,
            "podcast_feed_id": feed_id,
            "episode_guid": episode_guid,
            "podcast_title": title,
            "podcast_show_title": show_title,
            "podcast_album": album,
            "thumbnail_url": thumb or None,
            "duration_sec": duration_int,
            "podcast_rss_url": rss_url or None,
        }
        if thumb:
            base["thumbnail_url"] = thumb
        return base, None

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

        self.queue = self._load()
        for item in self.queue:
            if isinstance(item, dict) and item.get("status") == "downloading":
                item["status"] = "interrupted"

        self.lock = threading.RLock()

        evicted = self._evict_failed_and_interrupted()
        if evicted:
            logger.info(
                "API: [Queue] Evicted %d failed/interrupted item(s) on startup.",
                evicted,
            )

        if self.queue:
            self.save()

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
            item["added_at"] = utc_now_iso_z()
            self.queue.append(item)

        self.save()
        return item

    def get_pending(self):
        with self.lock:
            return [i for i in self.queue if i["status"] == "pending"]

    def update_status(self, item_id, status, error=None):
        do_save = False
        updated_item = None
        with self.lock:
            for item in self.queue:
                if item["id"] == item_id:
                    item["status"] = status
                    if error is not None:
                        clean_error = sanitize_cli_message(str(error))
                        error_kind, error_message = classify_download_error(clean_error)
                        item["error"] = clean_error
                        item["error_kind"] = error_kind
                        item["error_message"] = error_message
                    elif status != "failed":
                        item.pop("error", None)
                        item.pop("error_kind", None)
                        item.pop("error_message", None)
                    updated_item = dict(item)
                    do_save = True
                    break
        if do_save:
            self.save()
        return updated_item

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

    def _evict_failed_and_interrupted(self) -> int:
        """Remove failed/interrupted items from the in-memory queue.

        Called at startup so a server restart clears the residue of the
        previous run. The persisted JSON is rewritten afterwards by
        ``__init__``'s trailing ``self.save()``.
        """
        with self.lock:
            kept = [i for i in self.queue if i.get("status") not in ("failed", "interrupted")]
            evicted = len(self.queue) - len(kept)
            self.queue = kept
        return evicted

    def retry_failed(self, item_id):
        """Reset a failed item back to pending so the pump re-processes it.

        Returns the updated item dict, or ``None`` if the id is unknown
        or the item is not currently in ``failed`` state.
        """
        updated_item = None
        with self.lock:
            for item in self.queue:
                if item.get("id") != item_id:
                    continue
                if item.get("status") != "failed":
                    return None
                item["status"] = "pending"
                for stale_key in (
                    "error",
                    "error_kind",
                    "error_message",
                    "progress_percent",
                    "speed",
                    "eta",
                    "phase",
                    "total_bytes",
                ):
                    item.pop(stale_key, None)
                updated_item = dict(item)
                break
        if updated_item:
            self.save()
            if self.socketio:
                try:
                    self.socketio.emit(
                        "downloader_update",
                        {
                            "id": updated_item["id"],
                            "status": "pending",
                            "progress_percent": None,
                        },
                    )
                except Exception as e:
                    logger.warning("API: downloader_update emit failed: %s", e)
        return updated_item

    def clear_failed(self) -> int:
        """Remove all failed/interrupted items from the queue. Returns count."""
        with self.lock:
            kept = [i for i in self.queue if i.get("status") not in ("failed", "interrupted")]
            removed = len(self.queue) - len(kept)
            self.queue = kept
        if removed:
            self.save()
        return removed
