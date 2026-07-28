from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from shared.migration.match import AUTO_ACCEPT_THRESHOLD, LibraryMatcher
from shared.migration.models import MigrationManifest, SourceTrack
from shared.migration.store import MigrationStore
from shared.resolution_confidence import classify_confidence
from shared.user_context import user_context

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="migration")
_active: set[tuple[str, str]] = set()
_active_lock = threading.Lock()


def start_migration_job(job_id: str, user_id: str) -> bool:
    """Start a job once; duplicate resume clicks join the already-running work."""
    key = (user_id, job_id)
    with _active_lock:
        if key in _active:
            return False
        _active.add(key)
    _executor.submit(_run_bound, job_id, user_id)
    return True


def _run_bound(job_id: str, user_id: str) -> None:
    try:
        with user_context(user_id):
            MigrationRunner(MigrationStore(), job_id, user_id).run()
    except Exception as exc:
        logger.exception("Migration job %s failed", job_id)
        try:
            with user_context(user_id):
                MigrationStore().set_job_state(job_id, "failed", str(exc))
        except Exception:
            logger.exception("Could not persist migration job %s failure", job_id)
    finally:
        with _active_lock:
            _active.discard((user_id, job_id))


def _candidate_payload(candidate: dict[str, Any]) -> dict[str, Any]:
    video_id = str(candidate.get("video_id") or candidate.get("id") or "").strip()
    return {
        "kind": "catalog",
        "video_id": video_id,
        "title": candidate.get("title") or "",
        "artist": candidate.get("artist") or candidate.get("channel") or candidate.get("uploader") or "",
        "album": candidate.get("album") or "",
        "duration": int(candidate.get("duration") or 0),
        "thumbnail": candidate.get("thumbnail") or "",
        "confidence": float(candidate.get("confidence") or 0),
        "confidence_level": candidate.get("confidence_level")
        or classify_confidence(float(candidate.get("confidence") or 0)),
    }


class MigrationRunner:
    def __init__(self, store: MigrationStore, job_id: str, user_id: str):
        self.store = store
        self.job_id = job_id
        self.user_id = user_id
        self.manifest = store.get_manifest(job_id)

    def run(self) -> None:
        if self.store.job_state(self.job_id) in {"cancelled", "completed"}:
            return
        self.store.set_job_state(self.job_id, "running")
        job = self.store.get_job(self.job_id)
        selected_keys = self.store.selected_track_keys(self.manifest, job["selection"])
        self._ensure_target_playlists(job)

        for source_key, source in self.manifest.tracks.items():
            if source_key not in selected_keys:
                continue
            state = self.store.job_state(self.job_id)
            if state in {"paused", "cancelled"}:
                self._sync_playlists()
                return
            row = self.store.get_track(self.job_id, source_key)
            if row["state"] in {"existing", "completed", "skipped", "unavailable"}:
                if row["matched_track_id"]:
                    self._apply_track(source_key, row["matched_track_id"])
                continue
            if row["state"] == "needs_review":
                continue
            try:
                self._process_track(source_key, source, row)
            except Exception as exc:
                logger.warning("Migration track %s failed: %s", source_key, exc)
                self.store.update_track(self.job_id, source_key, state="failed", error=str(exc))
            self._sync_playlists()

        self._sync_playlists()
        self._finish()

    def _library(self):
        from shared.api import get_user_core

        core = get_user_core(self.user_id)
        lib = core.library
        if not lib.metadata:
            lib._load_from_cache(lib.manifest_path)
        return lib

    def _ensure_target_playlists(self, job: dict[str, Any]) -> None:
        lib = self._library()
        metadata = lib.metadata
        if not metadata:
            raise RuntimeError("Library metadata is unavailable")
        selected_ids = set(job["selection"].get("playlist_ids") or [])
        names = dict(job.get("playlist_names") or {})
        existing_names = set(metadata.playlists)
        changed = False
        for playlist in self.manifest.playlists:
            if playlist.source_id not in selected_ids or playlist.is_favourites:
                continue
            if playlist.source_id in names and names[playlist.source_id] in metadata.playlists:
                continue
            base = names.get(playlist.source_id) or playlist.name
            target = base
            if target in existing_names:
                suffix = "Spotify" if self.manifest.provider == "spotify" else "Apple Music"
                target = f"{base} ({suffix})"
                index = 2
                while target in existing_names:
                    target = f"{base} ({suffix} {index})"
                    index += 1
            metadata.create_playlist(target, [])
            existing_names.add(target)
            names[playlist.source_id] = target
            changed = True
        self.store.set_playlist_names(self.job_id, names)
        if changed:
            lib._save_metadata()
            self._emit_library_updated()

    def _process_track(self, source_key: str, source: SourceTrack, row: dict[str, Any]) -> None:
        selected = row.get("selected") or {}
        if selected.get("kind") == "catalog":
            candidate = selected
        else:
            shared_track = self._match_shared_pool(source)
            if shared_track is not None:
                from shared.api import add_tracks_to_user_library

                add_tracks_to_user_library([shared_track], user_id=self.user_id)
                self.store.update_track(
                    self.job_id,
                    source_key,
                    state="completed",
                    matched_track_id=shared_track.id,
                    confidence=1.0,
                )
                self._apply_track(source_key, shared_track.id)
                return
            self.store.update_track(self.job_id, source_key, state="resolving")
            candidate, alternatives = self._resolve(source)
            if not candidate:
                self.store.update_track(
                    self.job_id,
                    source_key,
                    state="unavailable",
                    candidates=alternatives,
                    error="No playable match was found",
                )
                return
            if classify_confidence(float(candidate.get("confidence") or 0)) != "high":
                self.store.update_track(
                    self.job_id,
                    source_key,
                    state="needs_review",
                    candidates=alternatives,
                    selected=candidate,
                )
                return

        self.store.update_track(
            self.job_id,
            source_key,
            state="downloading",
            selected=candidate,
        )
        track_id, error = self._download(candidate, source)
        if not track_id:
            self.store.update_track(self.job_id, source_key, state="failed", error=error or "Download failed")
            return
        self.store.update_track(
            self.job_id,
            source_key,
            state="completed",
            matched_track_id=track_id,
            confidence=float(candidate.get("confidence") or 1.0),
        )
        self._apply_track(source_key, track_id)

    def _match_shared_pool(self, source: SourceTrack):
        try:
            from shared.api import get_downloader

            pool = get_downloader(open_browser=False).library.tracks
            result = LibraryMatcher(pool).match(source)
            if result.matched_track_id and result.confidence >= AUTO_ACCEPT_THRESHOLD:
                return next((track for track in pool if track.id == result.matched_track_id), None)
        except Exception as exc:
            logger.debug("Shared-pool migration match failed: %s", exc)
        return None

    @staticmethod
    def _resolve(source: SourceTrack) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        from shared.api.routes.catalog import _resolve_candidates

        best, raw_alternatives = _resolve_candidates(source.artist, source.title, source.duration or None)
        alternatives = [_candidate_payload(value) for value in raw_alternatives if value.get("id") or value.get("video_id")]
        candidate = _candidate_payload(best) if best and (best.get("id") or best.get("video_id")) else None
        if candidate and not any(row["video_id"] == candidate["video_id"] for row in alternatives):
            alternatives.insert(0, candidate)
        return candidate, alternatives[:5]

    def _download(self, candidate: dict[str, Any], source: SourceTrack) -> tuple[str | None, str | None]:
        import shared.api as api

        video_id = str(candidate.get("video_id") or "").strip()
        raw = {
            "source_type": "ytmusic_search",
            "song_str": f"https://www.youtube.com/watch?v={video_id}",
            "video_id": video_id,
            "display_title": source.title,
            "display_artist": source.artist,
            "thumbnail_url": candidate.get("thumbnail"),
            "duration_sec": source.duration or candidate.get("duration"),
            "metadata_evidence": {
                "title": source.title,
                "artist": source.artist,
                "album": source.album,
                "duration_sec": source.duration or candidate.get("duration"),
                "migration_job_id": self.job_id,
                "migration_provider": self.manifest.provider,
            },
        }
        item, error = api.parse_intake_item(raw)
        if error or not item:
            return None, error or "Invalid download candidate"
        item = api.queue_manager_dl.add(item, user_id=self.user_id)
        api.queue_manager_dl.update_status(item["id"], "downloading")
        api._process_single_queue_item(item)

        lib = self._library()
        if lib.metadata:
            by_video = next(
                (track for track in lib.metadata.tracks if getattr(track, "youtube_id", None) == video_id),
                None,
            )
            if by_video:
                return by_video.id, None
            match = LibraryMatcher(lib.metadata.tracks).match(source)
            if match.matched_track_id and match.confidence >= AUTO_ACCEPT_THRESHOLD:
                return match.matched_track_id, None
        failed = next(
            (row for row in api.queue_manager_dl.list_items(self.user_id) if row.get("id") == item["id"]),
            {},
        )
        return None, failed.get("error_message") or failed.get("error") or "The downloaded track was not added"

    def _apply_track(self, source_key: str, track_id: str) -> None:
        if source_key in set(self.manifest.favourite_keys):
            try:
                from shared.api import get_favourites_manager

                get_favourites_manager(self.user_id).add(track_id)
            except Exception as exc:
                logger.warning("Could not favourite migrated track %s: %s", track_id, exc)

    def _sync_playlists(self) -> None:
        job = self.store.get_job(self.job_id)
        names = job.get("playlist_names") or {}
        selected_ids = set(job["selection"].get("playlist_ids") or [])
        resolved = {
            track["source_key"]: track["matched_track_id"]
            for track in job["tracks"]
            if track["matched_track_id"] and track["state"] in {"existing", "completed"}
        }
        lib = self._library()
        if not lib.metadata:
            return
        changed = False
        for playlist in self.manifest.playlists:
            target = names.get(playlist.source_id)
            if playlist.source_id not in selected_ids or not target or target not in lib.metadata.playlists:
                continue
            ordered = [resolved[key] for key in playlist.track_keys if key in resolved]
            if lib.metadata.playlists[target] != ordered:
                lib.metadata.set_playlist_tracks(target, ordered)
                changed = True
        if changed:
            lib._save_metadata()
            self._emit_library_updated()

    def _emit_library_updated(self) -> None:
        try:
            from shared.api import emit_to_user

            emit_to_user("library_updated", user_id=self.user_id)
        except Exception:
            logger.debug("Could not emit migration library update", exc_info=True)

    def _finish(self) -> None:
        if self.store.job_state(self.job_id) == "cancelled":
            return
        job = self.store.get_job(self.job_id)
        counts = job["selected_counts"]
        if counts.get("resolving") or counts.get("downloading") or counts.get("pending"):
            self.store.set_job_state(self.job_id, "partial", "Some tracks remain pending")
        elif counts.get("needs_review"):
            self.store.set_job_state(self.job_id, "needs_review")
        elif counts.get("failed") or counts.get("unavailable"):
            self.store.set_job_state(self.job_id, "partial")
        else:
            self.store.set_job_state(self.job_id, "completed")

