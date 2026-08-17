"""Per-user background scans of approved existing music folders."""

from __future__ import annotations

import logging
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from setup_tool.scanner import LibraryScanner, ScanResult
from shared.api.orchestrator import orchestrator
from shared.models import LibraryMetadata, Track
from shared.path_resolver import configured_scan_roots, path_within_roots, register_scan_roots
from shared.user_context import user_context

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _earliest(*dates: Optional[str]) -> Optional[str]:
    """The oldest library date among these, ignoring the ones that are missing."""
    known = [date for date in dates if date]
    return min(known) if known else None


def _file_instant(track: Track, path: str) -> Optional[str]:
    """A scanned file's mtime as a library date, or None when it has none."""
    nanos = getattr(track, "local_mtime_ns", None)
    try:
        seconds = nanos / 1_000_000_000 if nanos else Path(path).stat().st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(seconds, timezone.utc).replace(tzinfo=None).isoformat()


def _blank_status(state: str = "idle") -> dict[str, Any]:
    return {
        "scan_id": None,
        "state": state,
        "discovered": 0,
        "processed": 0,
        "added": 0,
        "updated": 0,
        "unchanged": 0,
        "failed": 0,
        "started_at": None,
        "finished_at": None,
        "error": None,
    }


class LibraryScanService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._status: dict[str, dict[str, Any]] = {}

    def status(self, user_id: str) -> dict[str, Any]:
        with self._lock:
            return dict(self._status.get(user_id) or _blank_status())

    def approved_roots(self, library: Any) -> list[Path]:
        configured = configured_scan_roots(getattr(library, "config", None))
        watch = getattr(getattr(library, "config", None), "watch_folders", None) or []
        if watch:
            requested = []
            for raw in watch:
                try:
                    requested.append(Path(raw).expanduser().resolve(strict=True))
                except (OSError, RuntimeError):
                    continue
        else:
            from shared.runtime import get_music_dir

            requested = [Path(get_music_dir()).expanduser().resolve()]
        roots = [root for root in requested if root.is_dir()]
        register_scan_roots(configured)
        return roots

    def resolve_roots(self, library: Any, requested_path: Optional[str] = None) -> list[Path]:
        roots = self.approved_roots(library)
        if not roots:
            raise ValueError("No configured music folder is available")
        if requested_path is None:
            return roots
        candidate = Path(requested_path).expanduser()
        try:
            candidate = candidate.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ValueError("The requested folder does not exist") from exc
        if not candidate.is_dir():
            raise ValueError("The requested path is not a folder")
        if not path_within_roots(candidate, roots):
            raise ValueError("The requested folder is outside the configured music roots")
        return [candidate]

    def start(self, user_id: str, roots: list[Path]) -> dict[str, Any]:
        with self._lock:
            current = self._status.get(user_id)
            if current and current["state"] in {"queued", "scanning"}:
                return dict(current)
            status = _blank_status("queued")
            status["scan_id"] = uuid.uuid4().hex
            self._status[user_id] = status

        orchestrator.submit_background(
            f"library_scan_{user_id}_{status['scan_id']}",
            self._run,
            user_id,
            list(roots),
            status["scan_id"],
        )
        return self.status(user_id)

    def _update(self, user_id: str, scan_id: str, **values: Any) -> None:
        with self._lock:
            current = self._status.get(user_id)
            if current and current.get("scan_id") == scan_id:
                current.update(values)

    def _run(self, user_id: str, roots: list[Path], scan_id: str) -> None:
        self._update(user_id, scan_id, state="scanning", started_at=_now())
        try:
            with user_context(user_id):
                from shared.api import emit_to_user, get_user_core

                core = get_user_core(user_id)
                library = core.library
                library.refresh_if_stale()
                if library.metadata is None:
                    library.sync_library(silent=True)
                snapshot = list((library.metadata or LibraryMetadata(1, [], {}, {})).tracks)
                scanner = LibraryScanner()

                def progress(result: ScanResult) -> None:
                    self._update(
                        user_id,
                        scan_id,
                        discovered=result.discovered,
                        processed=result.processed,
                        failed=len(result.errors),
                    )

                result = scanner.scan_paths(roots, snapshot, progress=progress)
                summary, prewarm_tracks = orchestrator.run_serialized(
                    self._merge_result, core, result
                )
                self._update(
                    user_id,
                    scan_id,
                    state="completed",
                    finished_at=_now(),
                    failed=len(result.errors),
                    **summary,
                )
                if summary["added"] or summary["updated"]:
                    emit_to_user("library_updated", user_id=user_id)
                    # Fire-and-forget: extract covers for what just landed so
                    # they're already cached by the time the library is opened,
                    # instead of the first row's own request paying for it.
                    # Reuses CoverFetchManager's existing bounded thread pool —
                    # no new concurrency, and a per-track failure here can't
                    # affect the scan result already recorded above.
                    self._prewarm_covers(library, prewarm_tracks)
        except Exception as exc:
            logger.exception("Library scan failed for user %s", user_id)
            self._update(
                user_id,
                scan_id,
                state="failed",
                finished_at=_now(),
                error=f"Scan failed: {type(exc).__name__}",
            )

    @staticmethod
    def _prewarm_covers(library: Any, tracks: list[Track]) -> None:
        from player.cover_manager import CoverFetchManager

        manager = CoverFetchManager.get_instance()
        for track in tracks:
            try:
                path = library.get_track_url(track)
                if path and not str(path).startswith("http"):
                    manager.request_cover(track, embedded_cache_info=path)
                else:
                    manager.request_cover(track)
            except Exception:
                continue

    @staticmethod
    def _preserve_user_metadata(old: Track, new: Track) -> None:
        if not old.metadata_modified_by_user:
            return
        for name in (
            "title", "artist", "artists", "album", "album_artist", "year", "genre",
            "track_number", "disc_number", "disc_total", "is_compilation", "cover_art_key",
            "cover_source",
        ):
            setattr(new, name, deepcopy(getattr(old, name)))
        new.metadata_modified_by_user = True

    @classmethod
    def _merge_result(cls, core: Any, result: ScanResult) -> tuple[dict[str, int], list[Track]]:
        library = core.library
        latest = library.db.load_library_metadata()
        if latest is None:
            latest = library.metadata or LibraryMetadata(version=1, tracks=[], playlists={}, settings={})

        tracks = list(latest.tracks)
        by_id = {track.id: track for track in tracks}
        by_path = {track.local_path: track for track in tracks if track.local_path}
        added = updated = unchanged = 0
        replacements: dict[str, str] = {}
        prewarm: list[Track] = []

        for scanned in result.files:
            incoming = scanned.track
            current = by_id.get(incoming.id)
            same_path = by_path.get(scanned.path)

            if scanned.unchanged and current is not None:
                unchanged += 1
                continue

            if current is not None:
                if same_path is not None and same_path.id != current.id:
                    cls._preserve_user_metadata(same_path, current)
                    # Two rows, one song: it has been in the library since the
                    # earlier of them, whichever row survives.
                    current.added_at = _earliest(current.added_at, same_path.added_at)
                    tracks.remove(same_path)
                    replacements[same_path.id] = current.id
                    by_id.pop(same_path.id, None)
                changed = (
                    current.local_path != scanned.path
                    or current.local_mtime_ns != incoming.local_mtime_ns
                    or current.file_size != incoming.file_size
                )
                current.local_path = scanned.path
                current.local_mtime_ns = incoming.local_mtime_ns
                current.file_size = incoming.file_size
                current.is_local = True
                if changed:
                    updated += 1
                    prewarm.append(current)
                else:
                    unchanged += 1
                by_path[scanned.path] = current
                continue

            if same_path is not None and same_path.id != incoming.id:
                cls._preserve_user_metadata(same_path, incoming)
                # Re-keyed, not re-acquired: the file at this path was already
                # yours, and the new id inherits the day it became so.
                incoming.added_at = same_path.added_at or _file_instant(incoming, scanned.path)
                position = tracks.index(same_path)
                tracks[position] = incoming
                replacements[same_path.id] = incoming.id
                by_id.pop(same_path.id, None)
                by_id[incoming.id] = incoming
                by_path[scanned.path] = incoming
                updated += 1
                prewarm.append(incoming)
                continue

            # A folder you already own is not music you acquired just now. The
            # file's own mtime is the closest thing to when each song joined
            # you, and it keeps a scanned collection in a believable order
            # instead of landing 5,000 songs on one instant.
            incoming.added_at = incoming.added_at or _file_instant(incoming, scanned.path)
            tracks.append(incoming)
            by_id[incoming.id] = incoming
            by_path[scanned.path] = incoming
            added += 1
            prewarm.append(incoming)

        if replacements:
            for name, ids in list(latest.playlists.items()):
                latest.playlists[name] = [replacements.get(track_id, track_id) for track_id in ids]
            covers = (latest.settings or {}).get("playlist_covers")
            if isinstance(covers, dict):
                for name, track_id in list(covers.items()):
                    covers[name] = replacements.get(track_id, track_id)

        if added or updated:
            latest.tracks = tracks
            latest.version += 1
            library.metadata = latest
            library._library_revision = library.db.replace_library(
                latest, id_replacements=replacements
            )
            library._export_metadata(latest.to_json())
            for old_id, new_id in replacements.items():
                core.favourites.remap_library_id(old_id, new_id)

        return {"added": added, "updated": updated, "unchanged": unchanged}, prewarm


library_scan_service = LibraryScanService()
