"""
Resolve managed and approved scan-backed local audio paths at read time.
"""

import os
import threading
from pathlib import Path
from typing import Optional, Any, Iterable


_registered_scan_roots: set[Path] = set()
_scan_roots_lock = threading.RLock()


def register_scan_roots(roots: Iterable[str | Path]) -> None:
    """Remember configured roots for safe scan-backed playback in this process."""
    resolved: set[Path] = set()
    for root in roots:
        try:
            resolved.add(Path(root).expanduser().resolve())
        except (OSError, RuntimeError):
            continue
    with _scan_roots_lock:
        _registered_scan_roots.clear()
        _registered_scan_roots.update(resolved)


def configured_scan_roots(config: Any = None) -> list[Path]:
    """Return the current runtime root plus configured watcher roots."""
    from shared.runtime import get_music_dir

    with _scan_roots_lock:
        roots = set(_registered_scan_roots)
    try:
        roots.add(Path(get_music_dir()).expanduser().resolve())
    except (OSError, RuntimeError):
        pass
    for raw in getattr(config, "watch_folders", None) or []:
        try:
            roots.add(Path(raw).expanduser().resolve())
        except (OSError, RuntimeError):
            continue
    return sorted(roots, key=str)


def path_within_roots(path: str | Path, roots: Iterable[str | Path]) -> bool:
    try:
        candidate = Path(path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return False
    for root in roots:
        try:
            candidate.relative_to(Path(root).expanduser().resolve(strict=True))
            return True
        except (OSError, RuntimeError, ValueError):
            continue
    return False


def track_storage_key(track: Any) -> str:
    """Return the canonical pool/cloud object key for a track's current audio."""
    identity = getattr(track, "id", None) or getattr(track, "file_hash", None)
    track_format = (getattr(track, "format", None) or "mp3").strip(".")
    return f"tracks/{identity}.{track_format}"


def resolve_local_track_path(track: Any) -> Optional[str]:
    """
    Resolve the managed content-addressed path first, then an approved scanned
    source path stored only in this machine's SQLite database.
    Returns the first path that exists, or None.
    """
    from shared.app_config import get_output_dir
    from shared.constants import DEFAULT_OUTPUT_DIR_FALLBACK

    track_id = getattr(track, "id", None)
    file_hash = getattr(track, "file_hash", None)
    track_format = (getattr(track, "format", None) or "mp3").strip(".")

    output_dir = get_output_dir()
    if output_dir is None:
        output_dir = os.getenv("OUTPUT_DIR") or DEFAULT_OUTPUT_DIR_FALLBACK
    if not output_dir:
        return None
    tracks_dir = Path(output_dir).expanduser().resolve() / "tracks"

    candidates = []
    if track_id:
        candidates.append(str(tracks_dir / f"{track_id}.{track_format}"))
    if file_hash and file_hash != track_id:
        candidates.append(str(tracks_dir / f"{file_hash}.{track_format}"))

    for candidate in candidates:
        try:
            if candidate and os.path.exists(candidate):
                return candidate
        except OSError:
            continue
    scanned = getattr(track, "local_path", None)
    if scanned and path_within_roots(scanned, configured_scan_roots()):
        return str(Path(scanned).expanduser().resolve())
    return None


def is_scanned_track_path(track: Any, resolved_path: str | Path) -> bool:
    scanned = getattr(track, "local_path", None)
    if not scanned:
        return False
    try:
        return Path(scanned).expanduser().resolve() == Path(resolved_path).expanduser().resolve()
    except (OSError, RuntimeError):
        return False
