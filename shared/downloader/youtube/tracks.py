"""Turning a downloaded audio file into a library `Track`."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from shared.models import Track
from shared.musicbrainz import normalize_recording_mbid

from shared.audio_files import AudioProcessor

_PLACEHOLDER_TAGS = {"title", "track", "unknown", "unknown title", "audio", "video", "untitled"}


def recording_mbid(metadata: Any) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None
    direct = normalize_recording_mbid(metadata.get("musicbrainz_id"))
    if direct:
        return direct
    external_ids = metadata.get("external_ids")
    if isinstance(external_ids, dict):
        return normalize_recording_mbid(external_ids.get("musicbrainz_id"))
    return None


def with_canonical_mbid(metadata: Dict[str, Any], source: Any = None) -> Dict[str, Any]:
    """`metadata` with its MusicBrainz id read from `source` (itself by default),
    normalized, or removed when there is no valid one."""
    mbid = recording_mbid(metadata if source is None else source)
    metadata.pop("musicbrainz_id", None)
    if mbid:
        metadata["musicbrainz_id"] = mbid
    return metadata


def is_placeholder_tag(value: Any) -> bool:
    """True if a tag is empty or a placeholder (e.g. a yt-dlp parse-metadata mistake)."""
    if value is None:
        return True
    text = str(value).strip().lower()
    return not text or text in _PLACEHOLDER_TAGS


def _hint_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _hint_positive_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def video_metadata(
    file_tags: Dict[str, Any],
    hint: Optional[Dict[str, Any]],
    duration: int,
    peek: Callable[[], Dict[str, Any]],
) -> Dict[str, Any]:
    """What a downloaded video is: its own tags, overruled by the caller's hint.

    The hint comes from where the song was chosen — a search row, a catalog
    record — and outranks the upload's tags, which name whatever release
    YouTube filed it under. `peek` asks YouTube for the video's metadata, and
    runs only when the title or artist is still a placeholder.
    """
    meta = dict(file_tags)
    if is_placeholder_tag(meta.get("title")):
        meta["title"] = ""
    if is_placeholder_tag(meta.get("artist")):
        meta["artist"] = ""
    meta.setdefault("album", "")
    meta.setdefault("duration_sec", duration or 0)
    meta.setdefault("track_number", 1)
    if isinstance(hint, dict):
        title = _hint_str(hint.get("title"))
        if title and not is_placeholder_tag(title):
            meta["title"] = title
        artist = _hint_str(hint.get("artist")) or _hint_str(hint.get("channel"))
        if artist:
            meta["artist"] = artist
        if hint.get("duration_sec") is not None:
            meta["duration_sec"] = hint["duration_sec"]
        if hint.get("album") is not None:
            album = _hint_str(hint.get("album"))
            if album and album.casefold() != _hint_str(meta.get("album")).casefold():
                # Another record: the upload's place, date and compilation
                # flag on its own one do not carry over. Records never mix.
                for key in ("album_artist", "track_number", "disc_number", "year"):
                    meta.pop(key, None)
                meta["is_compilation"] = False
            meta["album"] = album
        album_artist = _hint_str(hint.get("album_artist"))
        if album_artist:
            meta["album_artist"] = album_artist
        for key in ("track_number", "disc_number", "year"):
            position = _hint_positive_int(hint.get(key))
            if position:
                meta[key] = position
        if recording_mbid(hint):
            meta["musicbrainz_id"] = recording_mbid(hint)
    with_canonical_mbid(meta)
    if is_placeholder_tag(meta.get("title")) or is_placeholder_tag(meta.get("artist")):
        info = peek()
        if info:
            title = _hint_str(info.get("track") or info.get("title"))
            if title and not is_placeholder_tag(title):
                meta["title"] = title
            artist = _hint_str(info.get("artist") or info.get("channel") or info.get("uploader") or "")
            if artist and (is_placeholder_tag(meta.get("artist")) or not meta.get("artist")):
                meta["artist"] = artist
            if not meta.get("album") and info.get("album"):
                meta["album"] = _hint_str(info.get("album"))
    meta.setdefault("title", "Unknown Title")
    meta.setdefault("artist", "Unknown Artist")
    meta.setdefault("album", "")
    meta.setdefault("duration_sec", duration or 0)
    meta.setdefault("track_number", 1)
    return meta


def store_track(
    temp_file: Path,
    meta: Dict[str, Any],
    tracks_dir: Path,
    *,
    duration: int,
    bitrate: int,
    youtube_id: Optional[str],
    cover_source: Optional[str],
) -> Track:
    """Move a finished file into the pool under its content hash, as a `Track`.

    The hash is taken last, after every tag is written, so the file in the
    pool is the file its id names.
    """
    size = temp_file.stat().st_size
    file_hash = AudioProcessor.calculate_hash(str(temp_file))
    extension = (temp_file.suffix[1:] or "mp3").lower()
    shutil.move(str(temp_file), str(tracks_dir / f"{file_hash}.{extension}"))
    return Track(
        id=file_hash,
        title=meta["title"],
        artist=meta["artist"],
        album=meta.get("album") or "",
        album_artist=meta.get("album_artist"),
        duration=duration if duration > 0 else int(meta.get("duration_sec") or 0),
        file_hash=file_hash,
        original_filename=f"{meta['artist']} - {meta['title']}.{extension}",
        file_size=size,
        bitrate=bitrate,
        format=extension,
        year=meta.get("year"),
        genre=meta.get("genre"),
        track_number=meta.get("track_number"),
        artists=meta.get("artists"),
        disc_number=meta.get("disc_number"),
        disc_total=meta.get("disc_total"),
        is_compilation=bool(meta.get("is_compilation")),
        is_local=True,
        local_path=None,
        musicbrainz_id=meta.get("musicbrainz_id"),
        isrc=meta.get("isrc"),
        cover_source=cover_source,
        metadata_modified_by_user=False,
        youtube_id=youtube_id,
        media_kind=meta.get("media_kind"),
        podcast_feed_id=meta.get("podcast_feed_id"),
        podcast_episode_guid=meta.get("podcast_episode_guid"),
        podcast_rss_url=meta.get("podcast_rss_url"),
    )
