"""The download queue's pump: one queue for the instance, one downloader.

Downloads land in a shared pool, and a single pump keeps total concurrency
bounded no matter how many people are queueing. Each item carries `user_id`,
and the routes only ever show you your own.
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

import requests

from shared import library_intake, realtime, user_cores
from shared.constants import DEFAULT_OUTPUT_DIR_FALLBACK, SourceType
from shared.download_queue import DownloadQueueManager
from shared.downloader.service import Downloader
from shared.downloader.settings import read_settings, setting
from shared.library_lifecycle import drain as drain_audio_cleanup, reconcile as reconcile_audio_cleanup
from shared.models import Track
from shared.orchestrator import orchestrator
from shared.path_resolver import resolve_local_track_path
from shared.runtime import get_cache_dir
from shared.url_utils import normalize_youtube_url

logger = logging.getLogger(__name__)


#: Built on first use, and again when the output folder changes.
downloader_service = None


_downloader_lock = threading.Lock()  # Note: Prevent concurrent init when many discover/resolve requests hit at once


# One queue for the whole instance: downloads land in a shared pool, and a single
# pump keeps total concurrency bounded no matter how many people are queueing.
# Each item carries `user_id`, and the routes only ever show you your own.
queue_manager_dl = DownloadQueueManager(socketio=realtime.socketio)


def get_downloader(output_dir=None, open_browser=False, log_callback=None):
    global downloader_service

    def _log(msg):
        logger.info("API: %s", msg)
        if log_callback:
            log_callback(msg)

    # Note: 1. Determine the target output directory (prefer app_config set at startup)
    from shared.app_config import get_output_dir
    _app_out = get_output_dir()
    if output_dir:
        target_path = Path(output_dir).expanduser().absolute()
    elif _app_out is not None:
        target_path = _app_out
    else:
        target_dir = setting("OUTPUT_DIR") or os.getenv("OUTPUT_DIR") or DEFAULT_OUTPUT_DIR_FALLBACK
        target_path = Path(target_dir).expanduser().absolute()

    with _downloader_lock:
        should_init = False
        if not downloader_service:
            should_init = True
        elif downloader_service.output_dir != target_path:
            _log(f"Path changed to {target_path}. Re-initializing...")
            should_init = True

        if should_init:
            _log("Downloader: Entering setup...")
            _log(f"Step 1/3: Accessing storage at {target_path}...")
            try:
                target_path.mkdir(parents=True, exist_ok=True)
                _log("Step 1.1: Path is accessible.")
            except Exception as e:
                _log(f"⚠️ Step 1 Warning: NAS/Path issue: {e}")

            _log("Step 2/3: Loading Soundsible core...")
            lib_core = user_cores.get_library()

            _log("Step 3/3: Starting Engine...")
            env_vars = read_settings()
            quality = env_vars.get("DEFAULT_QUALITY", lib_core.config.quality_preference if lib_core.config else "high")
            cookie_browser = env_vars.get("COOKIE_BROWSER") or os.getenv("COOKIE_BROWSER")
            cookie_file = (
                env_vars.get("SOUNDSIBLE_YTDLP_COOKIE_FILE")
                or env_vars.get("YTDLP_COOKIE_FILE")
                or env_vars.get("COOKIE_FILE")
                or os.getenv("SOUNDSIBLE_YTDLP_COOKIE_FILE")
                or os.getenv("YTDLP_COOKIE_FILE")
                or os.getenv("COOKIE_FILE")
            )
            _log(f"Initializing Downloader (Quality: {quality})...")
            downloader_service = Downloader(
                target_path,
                cookie_browser=cookie_browser,
                cookie_file=cookie_file,
                quality=quality,
            )
            _log("✅ Downloader Engine Ready.")

    return downloader_service


def _youtube_metadata_artist_usable(artist: Optional[Any]) -> bool:
    """Flat YouTube Music search entries omit channel/uploader; empty artist must not block a peek fill."""
    if artist is None:
        return False
    s = str(artist).strip()
    if not s:
        return False
    if s.lower() in ("unknown", "unknown artist"):
        return False
    return True


def _youtube_metadata_title_usable(title: Optional[Any], song_str: str) -> bool:
    """Reject URLs and placeholders so we do not embed them as track titles."""
    if title is None:
        return False
    t = str(title).strip()
    if not t:
        return False
    s = str(song_str or "").strip()
    if t == s:
        return False
    tl = t.lower()
    if "youtube.com" in tl or "youtu.be" in tl:
        return False
    if tl.startswith("http://") or tl.startswith("https://"):
        return False
    return True


def _fill_youtube_runtime_hint(dl, song_str: str, item: dict, metadata_evidence: dict) -> dict:
    """Build metadata_hint for process_video; never prefer raw URLs over yt-dlp/peek titles.

    YouTube Music text search uses yt-dlp with extract_flat on music.youtube.com results; those
    entries often have title but no channel/uploader/artist (see shared.downloader.youtube.search.search_youtube).
    A usable title from search then skipped peek_brief previously, so artist stayed empty and
    tags fell through to Unknown Artist. We call peek_brief when title or artist is still unusable.
    """
    runtime_hint = dict(metadata_evidence or {})
    if not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str):
        runtime_hint.pop("title", None)

    if item.get("duration_sec") is not None:
        runtime_hint.setdefault("duration_sec", item["duration_sec"])

    dt = item.get("display_title")
    if _youtube_metadata_title_usable(dt, song_str):
        runtime_hint.setdefault("title", str(dt).strip())

    da = item.get("display_artist")
    if da and str(da).strip():
        dls = str(da).strip().lower()
        if dls not in ("unknown", "unknown artist", "resolving…", "resolving..."):
            runtime_hint.setdefault("artist", str(da).strip())

    need_peek = (
        not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str)
        or not _youtube_metadata_artist_usable(runtime_hint.get("artist"))
    )
    brief = None
    if need_peek:
        try:
            brief = dl.downloader.peek_brief(song_str)
        except Exception as ex:
            logger.debug("peek_brief for queue item failed: %s", ex)

    if brief:
        if not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str):
            bt = str(brief.get("title") or "").strip()
            if _youtube_metadata_title_usable(bt, song_str):
                runtime_hint["title"] = bt
        if not _youtube_metadata_artist_usable(runtime_hint.get("artist")):
            ch = brief.get("artist") or brief.get("channel") or ""
            if ch and str(ch).strip():
                runtime_hint["artist"] = str(ch).strip()
        if brief.get("duration") and not runtime_hint.get("duration_sec"):
            try:
                runtime_hint["duration_sec"] = int(brief["duration"])
            except (TypeError, ValueError):
                pass

    if not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str):
        runtime_hint.pop("title", None)

    _orient_runtime_hint(runtime_hint)
    return runtime_hint


def _orient_runtime_hint(runtime_hint: dict) -> None:
    """Settle artist/title by lookup before the pair is written to a file.

    This is the last point where the pair is still cheap to change. Past here
    it is embedded in tags, hashed into the track id, and copied into the
    manifest, the favourites entry and every playlist that references it —
    renaming it afterwards means a re-encode and a new id.
    """
    from shared.artist_title_orientation import resolve_orientation

    artist = str(runtime_hint.get("artist") or "").strip()
    title = str(runtime_hint.get("title") or "").strip()
    if not artist or not title:
        return

    decided = resolve_orientation(artist, title)
    if decided.swapped:
        runtime_hint["artist"] = decided.artist
        runtime_hint["title"] = decided.title


def process_queue_item(item, stop_event=None):
    """Worker function for A single download queue item.

    Runs bound to whoever queued the item: the pump is a background thread, so
    without that binding the finished track would have no library to land in.
    """
    from shared.user_context import user_context

    claimed = item if item.get('attempt') else queue_manager_dl.claim(item['id'])
    if not claimed:
        return
    from shared.process_runner import acquisition_scope, AcquisitionCancelled
    with user_context(claimed.get("user_id")):
        try:
            with acquisition_scope(lambda: (stop_event is not None and stop_event.is_set())
                                   or not queue_manager_dl.active(claimed['id'], claimed['attempt'])):
                _process_single_queue_item_bound(claimed)
        except AcquisitionCancelled:
            queue_manager_dl.update_status(claimed['id'], 'interrupted', attempt=claimed['attempt'])


def _process_single_queue_item_bound(item):
    item_id = item['id']
    attempt = item['attempt']
    song_str = item.get('song_str')
    output_dir = item.get('output_dir')
    source_type = item.get('source_type') or 'manual'
    item_user_id = item.get('user_id')
    metadata_evidence = item.get('metadata_evidence') if isinstance(item.get('metadata_evidence'), dict) else {}

    def _emit_item(payload):
        queue_manager_dl._emit_item_update(item, payload)

    def _schedule_artwork(track):
        # Receipt is already durable in this job's intake/checkpoint. Keep the
        # job replayable until the optional intent is durable too; no image I/O.
        token = metadata_evidence.get('artwork_selection')
        if token:
            from shared.artwork_sources import schedule_selection
            schedule_selection(track.id, track.youtube_id, token)

    queue_manager_dl.add_log(f"Preparing: {song_str or item_id}...")
    _emit_item({'id': item_id, 'status': 'downloading'})

    try:
        dl = get_downloader(output_dir, log_callback=queue_manager_dl.add_log)
        queue_manager_dl.add_log(f"Processing: {song_str or item_id}...")

        track = None
        # If the library transaction committed before a crash, a later user
        # deletion must not be undone by replaying this job.
        lib = user_cores.get_user_core(item_user_id).library
        if lib.db.has_library_operation(item_id):
            checkpoint = item.get('result') or {}
            existing = lib.db.get_library_track(checkpoint.get('id')) if checkpoint.get('id') else None
            if existing:
                _schedule_artwork(existing)
            if queue_manager_dl.complete(item_id, attempt):
                _emit_item({'id': item_id, 'status': 'completed'})
            return
        checkpoint = item.get('result')
        if checkpoint:
            restored = Track.from_dict(checkpoint)
            if resolve_local_track_path(restored):
                track = restored
        st = (source_type or "").strip()
        if track is not None:
            pass
        elif st == SourceType.PODCAST_ENCLOSURE or st == "podcast_enclosure":
            enclosure_url = (item.get("enclosure_url") or song_str or "").strip()
            if not enclosure_url:
                raise Exception("Missing podcast enclosure URL")
            lib_early = user_cores.get_library()
            fid = (item.get("podcast_feed_id") or "").strip()
            eg = (item.get("episode_guid") or "").strip()
            if lib_early.metadata and fid and eg:
                for t in lib_early.metadata.tracks:
                    if (getattr(t, "podcast_feed_id", None) or "") == fid and (
                        getattr(t, "podcast_episode_guid", None) or ""
                    ) == eg:
                        td = t.to_dict()
                        td.pop("local_path", None)
                        from shared.library_lifecycle import coordinated
                        with coordinated():
                            if not queue_manager_dl.active(item_id, attempt):
                                return
                            library_intake.add_tracks_to_user_library([t], user_id=item_user_id, operation_id=item_id)
                            queue_manager_dl.complete(item_id, attempt)
                        _emit_item(
                            {"id": item_id, "status": "completed", "track": td, "duplicate": True},
                        )
                        queue_manager_dl.add_log(f"Already in library: {t.title}")
                        return
            from shared.podcast_rss import assert_safe_http_url

            assert_safe_http_url(enclosure_url)
            queue_manager_dl.add_log(f"Downloading podcast enclosure...")
            _max_bytes = 600 * 1024 * 1024
            headers = {"User-Agent": "SoundsiblePodcast/1.0"}
            with requests.get(enclosure_url, stream=True, timeout=(15, 600), headers=headers, allow_redirects=True) as r:
                r.raise_for_status()
                ctype = (r.headers.get("Content-Type") or "").lower()
                if not (
                    ctype.startswith("audio/")
                    or "mpeg" in ctype
                    or "mp3" in ctype
                    or "mp4" in ctype
                    or "octet-stream" in ctype
                    or ctype.startswith("binary/")
                ):
                    raise Exception(f"Unexpected content type: {ctype or 'unknown'}")
                suf = ".mp3"
                if "mp4" in ctype or "m4a" in ctype or "aac" in ctype:
                    suf = ".m4a"
                elif "ogg" in ctype or "opus" in ctype:
                    suf = ".ogg"
                total = 0
                tmp_path = None
                try:
                    with tempfile.NamedTemporaryFile(delete=False, suffix=suf) as tmp:
                        tmp_path = tmp.name
                        for chunk in r.iter_content(chunk_size=65536):
                            if not chunk:
                                continue
                            total += len(chunk)
                            if total > _max_bytes:
                                raise Exception("Episode file too large")
                            tmp.write(chunk)
                    p = Path(tmp_path)
                    clean_meta = {
                        "title": (item.get("podcast_title") or "Episode").strip(),
                        "artist": (item.get("podcast_show_title") or "Podcast").strip(),
                        "album": (item.get("podcast_album") or item.get("podcast_show_title") or "Podcasts").strip(),
                        "duration_sec": int(item.get("duration_sec") or 0),
                        "track_number": 1,
                        "media_kind": "podcast_episode",
                        "podcast_feed_id": fid or None,
                        "podcast_episode_guid": eg or None,
                        "podcast_rss_url": (item.get("podcast_rss_url") or "").strip() or None,
                        "genre": "Podcast",
                    }
                    cover = (item.get("thumbnail_url") or "").strip() or None
                    track = dl.downloader.finalize_local_audio_file(
                        p,
                        clean_meta,
                        cover_art_url=cover,
                        cover_source="podcast" if cover else "none",
                    )
                finally:
                    if tmp_path and track is None:
                        try:
                            os.remove(tmp_path)
                        except OSError:
                            pass
        elif song_str:
            def _on_progress(payload):
                if not isinstance(payload, dict):
                    return
                kwargs = {}
                if payload.get("percent") is not None:
                    kwargs["percent"] = float(payload["percent"])
                for key in ("speed", "eta", "phase", "total_bytes"):
                    if payload.get(key) is not None:
                        kwargs[key] = payload[key]
                if kwargs:
                    queue_manager_dl.update_progress(item_id, attempt=attempt, **kwargs)

            if source_type in {"youtube_url", "ytmusic_search", "youtube_search"} or "youtube.com" in song_str or "youtu.be" in song_str:
                song_str = normalize_youtube_url(song_str)
                queue_manager_dl.add_log(f"Downloading direct YouTube: {song_str}...")
                track = dl.downloader.process_video(
                    song_str,
                    metadata_hint=_fill_youtube_runtime_hint(dl, song_str, item, metadata_evidence),
                    progress_callback=_on_progress,
                )
            else:
                queue_manager_dl.add_log(f"Searching YouTube: {song_str}...")
                track = dl.downloader.process_query(
                    song_str,
                    metadata_hint={k: v for k, v in metadata_evidence.items() if v is not None},
                    progress_callback=_on_progress,
                )

        if track:
            # Persist the reusable result before any personal-library work.
            if not queue_manager_dl.checkpoint(item_id, attempt, track.to_dict()):
                return
            from shared.library_lifecycle import coordinated
            with coordinated():
                if not queue_manager_dl.active(item_id, attempt):
                    return
                dl.commit_track(track)

            # Note: Pre-cache cover so first request serves it
            track_dict = track.to_dict()
            track_dict.pop("local_path", None)
            track_dict.pop("item_id", None)
            shared_track = Track.from_dict(track_dict)
            
            local_track_path = resolve_local_track_path(shared_track)
            covers_dir = os.path.join(str(get_cache_dir()), "covers")
            os.makedirs(covers_dir, exist_ok=True)
            cover_path = os.path.join(covers_dir, f"{shared_track.id}.jpg")
            if not os.path.exists(cover_path):
                try:
                    from shared.audio_files import AudioProcessor
                    cover_data = AudioProcessor.extract_cover_art(local_track_path) if local_track_path else None
                    if cover_data:
                        with open(cover_path, 'wb') as f:
                            f.write(cover_data)
                except Exception as e:
                    logger.warning("API: Pre-cache cover failed: %s", e)

            # Note: Add to the requesting user's library — and only theirs. The
            # file itself lives in the pool everyone shares.
            with coordinated():
                if not queue_manager_dl.active(item_id, attempt):
                    return
                from shared.users import get_user
                owner = get_user(item_user_id)
                if not owner or owner.get('disabled'):
                    raise RuntimeError('The download owner is unavailable')
                library_intake.add_tracks_to_user_library(
                    [shared_track],
                    user_id=item_user_id,
                    operation_id=item_id,
                    song_keys=item.get('identity_keys') or (),
                )
                _schedule_artwork(shared_track)
                if not queue_manager_dl.complete(item_id, attempt):
                    return

            # Measure it now rather than waiting for the idle sweep: a song
            # somebody just asked for is the one they are about to play, and one
            # file costs well under a second.
            try:
                from shared.loudness import get_loudness_service

                get_loudness_service().measure_now(shared_track.id)
            except Exception:
                logger.debug("API: could not measure loudness for %s", shared_track.id, exc_info=True)

            _emit_item({'id': item_id, 'status': 'completed', 'track': track_dict})
            queue_manager_dl.add_log(f"✅ Finished: {track.artist} - {track.title}")
        else:
            raise Exception("Downloader returned no track. Check logs for details.")

    except Exception as e:
        logger.warning("API Downloader Error: %s", e)
        failed_item = queue_manager_dl.update_status(item_id, 'failed', error=str(e), attempt=attempt)
        if failed_item is None:
            return
        _emit_item(
            {
                'id': item_id,
                'status': 'failed',
                'error': failed_item.get('error', str(e)),
                'error_kind': failed_item.get('error_kind', 'download_failed'),
                'error_message': failed_item.get('error_message', 'The download failed.'),
                'progress_percent': failed_item.get('progress_percent'),
            },
        )
        queue_manager_dl.add_log(f"❌ Failed: {song_str or item_id} - {e}")


def process_queue_background(stop_event: Optional[threading.Event] = None):
    """
    Downloader pump. Submits pending queue items to the orchestrator's
    background pool and sleeps between checks. Owned by JobOrchestrator
    (see start_downloader_pump) — do not start via raw threading.Thread.

    Exits early when `stop_event` is set, ensuring shutdown releases the
    `is_processing` flag.
    """
    if queue_manager_dl.is_processing:
        return

    queue_manager_dl.is_processing = True
    queue_manager_dl.add_log("Station Engine: Background orchestrator active.")

    def _stopped() -> bool:
        return stop_event is not None and stop_event.is_set()

    cleanup_at = 0.0
    try:
        while True:
            if time.monotonic() >= cleanup_at:
                cleanup_at = time.monotonic() + 30
                try:
                    provider = next((core.library.provider for core in user_cores.cached_cores()
                                     if core.library.provider), None)
                    reconcile_audio_cleanup()
                    drain_audio_cleanup(provider)
                except Exception:
                    logger.warning("Deferred audio cleanup failed", exc_info=True)
            if _stopped():
                queue_manager_dl.add_log("Station Engine: Pump stop requested; exiting.")
                break

            # Note: Only count jobs that start with "dl_"
            active_ids = [jid for jid in orchestrator.active_jobs if jid.startswith("dl_")]

            pending = queue_manager_dl.get_pending()
            # Note: Filter out those already being processed
            pending = [p for p in pending if f"dl_{p['id']}" not in active_ids]

            # Note: When idle, just sleep — the pump stays alive so new items are
            # picked up automatically without needing an explicit restart signal.
            if not pending and not active_ids:
                if stop_event is not None:
                    if stop_event.wait(timeout=2):
                        continue
                else:
                    time.sleep(2)
                continue

            # Note: Fill slots if we have capacity (max 3 concurrent downloads by default)
            # The effective concurrency can be tuned via the JobOrchestrator max_workers if needed.
            capacity = max(0, 3 - len(active_ids))
            if capacity > 0 and pending:
                for i in range(min(capacity, len(pending))):
                    item = pending[i]
                    orchestrator.submit_task(f"dl_{item['id']}", process_queue_item, item, stop_event)
                continue # Re-check immediately

            # Interruptible sleep — stop_event short-circuits the wait.
            if stop_event is not None:
                if stop_event.wait(timeout=1):
                    continue
            else:
                time.sleep(1)

    except Exception as e:
        logger.exception("CRITICAL: Downloader background thread crashed: %s", e)
    finally:
        queue_manager_dl.is_processing = False


def start_downloader_pump() -> bool:
    """Module-level entrypoint: route the pump through the orchestrator (plan 5A)."""
    return orchestrator.start_downloader_pump(process_queue_background)


def mirror_track_into_pool(track: Track) -> None:
    """
    Keep the download pool's library in sync with the main manifest.
    Otherwise the next pool commit overwrites library.json with stale titles/artists.

    Only while one account owns the music folder's ``library.json``. With
    several, that file is the instance catalog: one person's labels written
    into it would reach whoever later merges the pool.
    """
    from shared.users import instance_has_multiple_users

    if instance_has_multiple_users():
        return
    try:
        dl = get_downloader(open_browser=False)
    except Exception:
        return
    if not dl or not dl.library:
        return
    other = dl.library.get_track_by_id(track.id)
    if not other:
        return
    other.title = track.title
    other.artist = track.artist
    other.album = track.album
    other.album_artist = track.album_artist
    other.duration = track.duration
    other.original_filename = track.original_filename
    other.year = track.year
    other.track_number = track.track_number
    other.cover_source = track.cover_source
    other.metadata_modified_by_user = track.metadata_modified_by_user
    other.file_hash = track.file_hash
    other.file_size = track.file_size
    other.bitrate = track.bitrate
    other.format = track.format
    other.audio_quality = track.audio_quality
    other.media_kind = getattr(track, "media_kind", None)
    other.podcast_feed_id = getattr(track, "podcast_feed_id", None)
    other.podcast_episode_guid = getattr(track, "podcast_episode_guid", None)
    other.podcast_rss_url = getattr(track, "podcast_rss_url", None)
