"""
Download queue manager for the Station Engine.
"""

import json
import sqlite3
from contextlib import contextmanager
import logging
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from shared.time_utils import utc_now_iso_z

from shared.constants import SourceType
from shared.text_utils import sanitize_cli_message
from shared.url_utils import normalize_youtube_url, extract_youtube_video_id
from shared.user_context import current_user_id as _current_user_id

logger = logging.getLogger(__name__)


# Log lines produced with nobody bound (startup, admin jobs) go here and are
# visible to everyone — they never name a track.
_SHARED_LOG_KEY = "*"


def _user_room(user_id: str) -> str:
    """Local copy of the room name; importing shared.api here would be circular."""
    return f"user:{user_id}"


def _owns(item, user_id):
    """Whether ``item`` belongs to ``user_id``.

    Items queued before accounts existed carry no owner. They are shown to
    whoever asks rather than orphaned — the migration tags them, so this only
    covers rows written by an older process mid-upgrade.
    """
    if user_id is None:
        return True
    owner = item.get("user_id") if isinstance(item, dict) else None
    return owner == user_id


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

        # Auto-construct the YouTube URL from video_id when song_str is absent or invalid.
        # This keeps items from save/discovery flows from being rejected just because
        # they carry a video_id but not a full URL.
        if effective_video_id and not (normalized and ("youtube.com" in normalized or "youtu.be" in normalized)):
            normalized = f"https://www.youtube.com/watch?v={effective_video_id}"

        if not effective_video_id:
            return None, "Missing or invalid YouTube video id"

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


class DownloadQueueManager:
    """Durable jobs. Only progress is volatile; transitions commit before return."""

    def __init__(self, storage_path=None, socketio=None):
        self._legacy_path = Path(storage_path) if storage_path else None
        self.socketio = socketio
        self.lock = threading.RLock()
        self.is_processing = False
        self.accepting = True
        self.log_buffers = {}
        self.max_logs = 50
        self._progress = {}
        self._ready_path = None
        if storage_path is not None:
            self.initialize(recover=True)

    @property
    def storage_path(self):
        from shared.runtime import get_config_dir
        return self._legacy_path or get_config_dir() / 'download_queue.json'

    @property
    def db_path(self):
        return (self.storage_path.with_suffix('.db') if self._legacy_path
                else self.storage_path.parent / 'instance.db')

    @contextmanager
    def _connection(self):
        from shared.library_lifecycle import LibraryPersistenceError
        conn = None
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.db_path, timeout=5)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA synchronous=FULL')
            conn.execute("CREATE TABLE IF NOT EXISTS download_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, updated REAL NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS download_migrations (name TEXT PRIMARY KEY)")
            conn.commit()
            yield conn
            conn.commit()
        except (OSError, sqlite3.Error) as exc:
            if conn:
                conn.rollback()
            raise LibraryPersistenceError('download_storage_unavailable') from exc
        except BaseException:
            if conn:
                conn.rollback()
            raise
        finally:
            if conn:
                conn.close()

    def _write(self, conn, item):
        conn.execute('INSERT INTO download_jobs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated=excluded.updated',
                     (item['id'], item['status'], json.dumps(item), time.time()))

    def initialize(self, *, recover=False):
        from shared.library_lifecycle import coordinated, LibraryPersistenceError
        owner_id = None
        if not self._legacy_path:
            from shared.users import get_admin_user
            owner = get_admin_user()
            owner_id = owner['id'] if owner else None
        with coordinated(), self.lock, self._connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            migrated = conn.execute("SELECT 1 FROM download_migrations WHERE name='json'").fetchone()
            if not migrated:
                if self.storage_path.exists():
                    try:
                        items = json.loads(self.storage_path.read_text(encoding='utf-8'))
                        if not isinstance(items, list) or any(not isinstance(i, dict) or not i.get('id') for i in items):
                            raise ValueError('Invalid download queue')
                    except (OSError, ValueError) as exc:
                        raise LibraryPersistenceError('download_queue_invalid') from exc
                    for item in items:
                        if not item.get('user_id') and owner_id:
                            item['user_id'] = owner_id
                        self._write(conn, item)
                conn.execute("INSERT INTO download_migrations VALUES ('json')")
            if recover:
                for row in conn.execute("SELECT payload FROM download_jobs WHERE status IN ('downloading','interrupted')").fetchall():
                    item = json.loads(row['payload'])
                    item['status'] = 'pending'
                    item.pop('attempt', None)
                    self._write(conn, item)
                # Terminal work is invisible and kept briefly for crash recovery.
                expired = conn.execute("SELECT id, payload FROM download_jobs WHERE status IN ('completed','cancelled') AND updated < ?", (time.time() - 7 * 86400,)).fetchall()
                for row in expired:
                    owner = json.loads(row['payload']).get('user_id')
                    if owner:
                        from shared.user_context import user_config_dir
                        library_path = user_config_dir(owner, create=False) / 'library.db'
                        if library_path.exists():
                            with sqlite3.connect(library_path) as library_conn:
                                if library_conn.execute("SELECT 1 FROM sqlite_master WHERE name='library_operations'").fetchone():
                                    library_conn.execute('DELETE FROM library_operations WHERE id=?', (row['id'],))
                            library_conn.close()
                    conn.execute('DELETE FROM download_jobs WHERE id=?', (row['id'],))
            conn.commit()
            # The marker makes a crash before/after this rename idempotent.
            if self.storage_path.exists():
                backup = self.storage_path.with_name(self.storage_path.name + '.sqlite.bak')
                if not backup.exists():
                    self.storage_path.rename(backup)
            self._ready_path = self.db_path
            self.accepting = True

    def _ensure_ready(self):
        if self._ready_path != self.db_path or not self.db_path.exists():
            self.initialize()

    @property
    def queue(self):
        return self.list_items()

    @queue.setter
    def queue(self, items):
        # Compatibility seam for isolated test fixtures; production uses methods.
        self._ensure_ready()
        with self.lock, self._connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('DELETE FROM download_jobs')
            for item in items:
                self._write(conn, item)
        self._progress.clear()

    def add_log(self, msg, *, user_id=None):
        log_entry = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        target = user_id or _current_user_id()
        with self.lock:
            # Kept per account: these lines name tracks ("✅ Finished: Artist —
            # Title"), so one shared buffer would show everyone what everyone
            # else is downloading.
            buffer = self.log_buffers.setdefault(target or _SHARED_LOG_KEY, [])
            buffer.append(log_entry)
            if len(buffer) > self.max_logs:
                buffer.pop(0)
        logger.info("API: [Queue] %s", msg)
        if self.socketio:
            if target:
                self.socketio.emit("downloader_log", {"data": msg}, room=_user_room(target))
            else:
                # Instance-wide work (startup, admin tasks) with nobody bound.
                self.socketio.emit("downloader_log", {"data": msg})

    def logs_for(self, user_id=None):
        """Log lines this account may see: their own, plus instance-wide ones."""
        with self.lock:
            shared = list(self.log_buffers.get(_SHARED_LOG_KEY, []))
            mine = list(self.log_buffers.get(user_id, [])) if user_id else []
            return sorted(shared + mine)[-self.max_logs :]

    def add_many(self, items, *, user_id=None):
        from shared.library_lifecycle import coordinated, LibraryPersistenceError
        self._ensure_ready()
        added = []
        with coordinated(), self.lock, self._connection() as conn:
            if not self.accepting:
                raise LibraryPersistenceError('download_shutting_down')
            conn.execute('BEGIN IMMEDIATE')
            for raw in items:
                item = dict(raw) if isinstance(raw, dict) else {'song_str': str(raw)}
                item.update(id=str(uuid.uuid4()), status='pending', added_at=utc_now_iso_z(),
                            user_id=user_id or _current_user_id())
                self._write(conn, item)
                added.append(dict(item))
        return added

    def add(self, item, *, user_id=None):
        return self.add_many([item], user_id=user_id)[0]

    def get_pending(self, user_id=None):
        return [i for i in self.list_items(user_id) if i['status'] == 'pending']

    def list_items(self, user_id=None):
        self._ensure_ready()
        with self.lock, self._connection() as conn:
            rows = conn.execute("SELECT payload FROM download_jobs WHERE status NOT IN ('completed','cancelled') ORDER BY rowid").fetchall()
            result = []
            for row in rows:
                item = json.loads(row['payload'])
                if _owns(item, user_id):
                    item.update(self._progress.get(item['id'], {}))
                    # Private recovery data is never returned through HTTP.
                    result.append({k: v for k, v in item.items() if k not in ('result', 'attempt') and not k.startswith('_')})
            return result

    def _mutate(self, item_id, change, *, user_id=None, attempt=None):
        from shared.library_lifecycle import coordinated
        self._ensure_ready()
        with coordinated(), self.lock, self._connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT payload FROM download_jobs WHERE id=?', (item_id,)).fetchone()
            if row is None:
                return None
            item = json.loads(row['payload'])
            if not _owns(item, user_id) or item['status'] in ('completed', 'cancelled'):
                return None
            if attempt is not None and item.get('attempt') != attempt:
                return None
            if not change(item):
                return None
            self._write(conn, item)
            return dict(item)

    def claim(self, item_id):
        # Resolve account state before opening this store's write transaction.
        # The account manager uses a separate connection to the same database.
        candidate = next((i for i in self.list_items() if i['id'] == item_id), None)
        if candidate is None:
            return None
        available = True
        if not self._legacy_path:
            from shared.users import get_user
            user = get_user(candidate.get('user_id')) if candidate.get('user_id') else None
            available = bool(user and not user.get('disabled'))
        def change(item):
            if not self.accepting or item['status'] != 'pending':
                return False
            if not available:
                item.update(status='failed', error_kind='account_unavailable',
                            error_message='The download owner is unavailable.')
            else:
                item.update(status='downloading', attempt=uuid.uuid4().hex)
            return True
        item = self._mutate(item_id, change)
        return item if item and item['status'] == 'downloading' else None

    def active(self, item_id, attempt):
        self._ensure_ready()
        with self._connection() as conn:
            row = conn.execute('SELECT payload FROM download_jobs WHERE id=?', (item_id,)).fetchone()
            item = json.loads(row['payload']) if row else {}
            return item.get('status') == 'downloading' and item.get('attempt') == attempt

    def checkpoint(self, item_id, attempt, track):
        return self._mutate(item_id, lambda item: (item.update(result=track, phase='processing') or True), attempt=attempt)

    def complete(self, item_id, attempt):
        result = self._mutate(item_id, lambda item: (item.update(status='completed') or True), attempt=attempt)
        if result:
            self._progress.pop(item_id, None)
        return result

    def update_status(self, item_id, status, error=None, *, attempt=None):
        def change(item):
            item.update(self._progress.get(item_id, {}))
            item['status'] = status
            if error is not None:
                clean = sanitize_cli_message(str(error))
                kind, message = classify_download_error(clean)
                item.update(error=clean, error_kind=kind, error_message=message)
            elif status != 'failed':
                for key in ('error', 'error_kind', 'error_message'):
                    item.pop(key, None)
            return True
        return self._mutate(item_id, change, attempt=attempt)

    def update_progress(self, item_id, *, attempt=None, **values):
        if attempt is not None and not self.active(item_id, attempt):
            return
        values = {('progress_percent' if k == 'percent' else k): v for k, v in values.items() if v is not None}
        with self.lock:
            now = time.monotonic()
            progress = self._progress.setdefault(item_id, {})
            last = progress.get('_emitted', 0)
            previous_phase = progress.get('phase')
            progress.update(values)
            emit = now - last >= .3 or previous_phase != progress.get('phase')
            if emit:
                progress['_emitted'] = now
        if emit and self.socketio:
            item = next((i for i in self.list_items() if i['id'] == item_id), None)
            if item:
                self._emit_item_update(item, {'id': item_id, 'status': item['status'], **{k: v for k, v in progress.items() if not k.startswith('_')}})

    def remove_item(self, item_id, *, user_id=None):
        item = self._mutate(item_id, lambda item: (item.update(status='cancelled') or True), user_id=user_id)
        if item:
            self._progress.pop(item_id, None)
        return item

    def clear_queue(self, *, user_id=None):
        self._clear(user_id, {'pending', 'failed', 'interrupted'})

    def _clear(self, user_id, statuses):
        from shared.library_lifecycle import coordinated
        self._ensure_ready()
        removed = 0
        with coordinated(), self.lock, self._connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            for row in conn.execute('SELECT payload FROM download_jobs').fetchall():
                item = json.loads(row['payload'])
                if item['status'] in statuses and _owns(item, user_id):
                    item['status'] = 'cancelled'
                    self._write(conn, item)
                    self._progress.pop(item['id'], None)
                    removed += 1
        return removed

    def retry_failed(self, item_id, *, user_id=None):
        def change(item):
            if item['status'] not in ('failed', 'interrupted'):
                return False
            for key in ('error', 'error_kind', 'error_message', 'progress_percent', 'speed', 'eta', 'phase', 'total_bytes', 'attempt'):
                item.pop(key, None)
            item['status'] = 'pending'
            return True
        result = self._mutate(item_id, change, user_id=user_id)
        if result:
            self._progress.pop(item_id, None)
            self._emit_item_update(result, {'id': item_id, 'status': 'pending', 'progress_percent': None})
        return {k: v for k, v in result.items() if k not in ('result', 'attempt')} if result else None

    def clear_failed(self, *, user_id=None):
        return self._clear(user_id, {'failed', 'interrupted'})

    def _emit_item_update(self, item, payload) -> None:
        """Send a queue update to the owner of ``item`` only."""
        if not self.socketio:
            return
        owner = (item or {}).get("user_id") if isinstance(item, dict) else None
        owner = owner or _current_user_id()
        if owner:
            self.socketio.emit("downloader_update", payload, room=_user_room(owner))
        else:
            self.socketio.emit("downloader_update", payload)
