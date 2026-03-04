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
    track_id = getattr(track, "id", None)
    file_hash = getattr(track, "file_hash", None)
    track_format = (getattr(track, "format", None) or "mp3").strip(".")

    try:
        from dotenv import dotenv_values
        env_path = Path("odst_tool/.env")
        env_vars = dotenv_values(env_path) if env_path.exists() else {}
        output_dir = env_vars.get("OUTPUT_DIR") or os.getenv("OUTPUT_DIR")
        if not output_dir:
            return None
        tracks_dir = Path(output_dir).expanduser().absolute() / "tracks"
    except Exception:
        return None

    candidates = []
    if track_id:
        candidates.append(str(tracks_dir / f"{track_id}.{track_format}"))
    if file_hash and file_hash != track_id:
        candidates.append(str(tracks_dir / f"{file_hash}.{track_format}"))

    for candidate in candidates:
        try:
            if candidate and os.path.exists(candidate):
                return candidate
        except Exception:
            continue
    return None
