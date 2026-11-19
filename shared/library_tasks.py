"""Library work the API starts: label edits, pool sync and repair."""

from __future__ import annotations

import logging
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from typing import Optional

from shared import download_pump, library_intake, realtime, user_cores
from shared.library_lifecycle import coordinated, drain as drain_audio_cleanup
from shared.models import LibraryMetadata
from shared.orchestrator import orchestrator

logger = logging.getLogger(__name__)


def _sync_pool_to_main_core():
    """Merge the whole download pool into the bound user's library.

    Only correct for whole-catalog operations the admin runs, never for a single
    download — see :func:`shared.library_intake.add_tracks_to_user_library`.
    """
    dl = download_pump.get_downloader()
    user_cores.loaded_library()
    return library_intake.add_tracks_to_user_library(dl.library.tracks, keep_source_dates=True)


def run_library_repair_task(dry_run: bool = True, limit: int = 0):
    """Strip video streams and cap artwork on the files this account holds.

    Acquisition kept whatever yt-dlp handed over, and when YouTube offered no
    audio-only stream that was a progressive 360p video with the music muxed in.
    The repair is a remux — the audio is moved, never re-encoded — but it does
    change the bytes, and the hash of those bytes is the track id, so the id map
    it returns updates file manifests and the persisted source bindings through
    `replace_library`. Musical playlist references keep their stable identity.

    Songs from YouTube stored as FLAC are downloaded again as the stream they
    were decoded from, which re-keys them the same way.
    """
    from shared.user_context import current_user_id, user_context

    requester_id = current_user_id()

    def _task():
        with user_context(requester_id):
            try:
                from shared.library_repair import repair_library

                core = user_cores.get_user_core(requester_id)
                library = core.library
                if not library.metadata:
                    user_cores.loaded_library()
                library.refresh_if_stale()
                metadata = library.metadata
                revision = library._library_revision
                mode = "DRY RUN" if dry_run else "LIVE"
                download_pump.queue_manager_dl.add_log(f"--- Starting library repair ({mode}) ---")

                summary = repair_library(
                    list(metadata.tracks),
                    get_output_dir_for_repair(),
                    dry_run=dry_run,
                    limit=limit,
                    progress=lambda message: download_pump.queue_manager_dl.add_log(f"🔧 {message}"),
                    fetch_original=_fetch_youtube_original,
                )

                if not dry_run and summary["id_map"]:
                    with coordinated():
                        candidate = replace(metadata, tracks=summary["tracks"], version=metadata.version + 1,
                                            playlists=metadata.playlists.copy(), settings=deepcopy(metadata.settings))
                        saved = (library.metadata is metadata and library._library_revision == revision
                                 and library._save_metadata(metadata=candidate, id_replacements=summary["id_map"]))
                    if not saved:
                        # The repaired copies are already in the pool under ids
                        # nothing will reference. Cleanup deletes only what no
                        # library points at, so a shared hash is safe.
                        try:
                            from shared.library_lifecycle import retire
                            new_ids = set(summary["id_map"].values())
                            for track in summary["tracks"]:
                                if track.id in new_ids:
                                    retire(track)
                            drain_audio_cleanup(library.provider)
                        except Exception:
                            logger.warning("Library repair: could not discard unused repaired copies", exc_info=True)
                        raise RuntimeError("could not persist repaired track ids")
                    for old_id, new_id in summary["id_map"].items():
                        core.favourites.remap_library_id(old_id, new_id)
                    library_intake.remap_track_ids_for_all_users(summary["id_map"], {t.id: t for t in summary["tracks"]})
                    realtime.emit_to_user("library_updated", user_id=requester_id)
                    realtime.emit_to_user("favourites_updated", user_id=requester_id)

                saved = summary["saved_bytes"] / 1024 / 1024
                download_pump.queue_manager_dl.add_log(
                    f"--- Library repair finished: {summary['repaired']} file(s), "
                    f"{saved:.0f} MB {'recoverable' if dry_run else 'saved'} ---"
                )
            except Exception as exc:
                download_pump.queue_manager_dl.add_log(f"❌ Library repair error: {exc}")

    orchestrator.submit_task("library_repair", _task)


def _fetch_youtube_original(video_id: str) -> Optional[Path]:
    """The video's own audio stream, downloaded without converting it."""
    service = download_pump.get_downloader()
    return service.downloader._download_audio(f"https://www.youtube.com/watch?v={video_id}")


def get_output_dir_for_repair() -> Path:
    """The content-addressed pool a repaired file goes back into."""
    from shared.downloader.config import TRACKS_DIR
    from shared.app_config import get_output_dir

    return Path(get_output_dir()) / TRACKS_DIR


def run_sync_task():
    # Cloud sync is an instance-level action and runs on a background thread, so
    # capture who asked for it while we still have a request context. The tracks
    # it pulls back land in that person's library.
    from shared.user_context import current_user_id, user_context

    requester_id = current_user_id()

    def _task():
        with user_context(requester_id):
            _run_sync_task_bound()

    orchestrator.submit_task("sync", _task)


def _run_sync_task_bound():
    def _task():
        try:
            dl = download_pump.get_downloader(log_callback=download_pump.queue_manager_dl.add_log)
            if not dl.cloud.is_configured():
                download_pump.queue_manager_dl.add_log("❌ Cloud Sync not configured. Add R2/S3 keys in Settings.")
                return
            download_pump.queue_manager_dl.add_log("--- Starting Cloud Sync ---")
            def cb(msg): download_pump.queue_manager_dl.add_log(f"☁️ {msg}")
            
            # Note: Refresh library from disk before sync to ensure we have latest local changes
            snapshot, snapshot_revision = dl.read_snapshot()
            result = dl.cloud.sync_library(snapshot, progress_callback=cb)
            
            if 'error' in result:
                download_pump.queue_manager_dl.add_log(f"❌ Sync Error: {result['error']}")
            else:
                synced_library = result.get("synced_library")
                if isinstance(synced_library, LibraryMetadata):
                    dl.replace_snapshot(synced_library, snapshot_revision)

                download_pump.queue_manager_dl.add_log("✅ Sync Complete!")
                download_pump.queue_manager_dl.add_log(f"   Uploaded: {result.get('uploaded', 0)}, Merged: {result.get('merged', 0)}")
                download_pump.queue_manager_dl.add_log(f"   Total Remote: {result.get('total_remote', 0)}")
                _sync_pool_to_main_core()
        except Exception as e:
            download_pump.queue_manager_dl.add_log(f"❌ Critical Sync Error: {e}")
            logger.exception("API: cloud sync failed")

    _task()


def mark_track_metadata_updated(lib, track_id: str, cover_source: Optional[str] = None, *, changes=None) -> bool:
    """Set track metadata flags, save, and emit library_updated. Returns True if track was found."""
    track = user_cores.get_track_by_id(lib, track_id)
    if not track:
        return False
    changes = {**(changes or {}), "metadata_modified_by_user": True}
    if cover_source is not None:
        changes["cover_source"] = cover_source
    if not lib.patch_track_metadata(track_id, changes):
        from shared.library_lifecycle import LibraryPersistenceError
        raise LibraryPersistenceError("library_conflict")
    if cover_source == "none":
        from shared.artwork import artwork_store
        artwork_store().bind_override(track_id, None, "none")
    download_pump.mirror_track_into_pool(user_cores.get_track_by_id(lib, track_id))
    realtime.emit_to_user('library_updated', payload={'cover_changed': cover_source is not None})
    return True
