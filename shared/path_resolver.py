"""
Resolve local file path for a track at read time from current OUTPUT_DIR (Settings).
No storage path is persisted; resolution uses only track identity (id, file_hash, format)
and the configured output directory. Architecturally aligned with preview stream
(resolve at read via yt-dlp): single source of truth at request time.
"""

import os
from pathlib import Path
from typing import Optional, Any


def resolve_local_track_path(track: Any) -> Optional[str]:
    """
    Resolve a local audio file path for a track using current OUTPUT_DIR only.
    Does not use track.local_path or any stored path.
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
    return None
