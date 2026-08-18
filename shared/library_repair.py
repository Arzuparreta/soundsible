"""What a stored file costs to deliver, and how to make it cost less.

A song acquired from YouTube is not always audio. When YouTube exposes no
audio-only stream, yt-dlp's fallback is a progressive format — 360p H.264 with
the AAC track muxed into it — and the engine stored what it was handed. Measured
on one real library: 95 of 95 MP4s carried a video stream, 1.4 GB of pictures
nobody can watch and every listener downloads. `--embed-thumbnail` then parks a
1280x720 PNG in the container header, where a decoder must read *all* of it
before the first audio sample: 1.32 MB of a 1.66 MB header on that track, and
587-773 KB at the median of the library.

Neither is audible. On a LAN neither is noticeable either. Away from it they are
most of the wait — at the 87 KB/s measured to one phone, a 1.66 MB header is
nineteen seconds of silence before a note.

This module names both and removes them without touching a single audio sample.
Dropping the video streams and rebuilding the header is a *remux*: `-c copy`
moves the same encoded frames into a new container, so the bytes that come out
are the bytes that went in. `repair_file` proves that on every file it touches,
by hashing the decoded audio before and after and refusing to replace anything
whose hash moved.
"""

from __future__ import annotations

import io
import json
import logging
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

logger = logging.getLogger(__name__)

#: Codecs that are a *picture*, not a video track. A cover parked in a video
#: stream is still cover art, and dropping it is the cover policy's business
#: rather than the video policy's.
STILL_IMAGE_CODECS = frozenset({"png", "mjpeg", "bmp", "gif", "webp"})

#: Longest edge and byte ceiling for the artwork that stays inside the file.
#: The player renders covers at 320px (`player/cover_manager.py`), so 600 is
#: already generous; the ceiling is what stops a badly compressed image from
#: costing a megabyte at any resolution.
DEFAULT_COVER_MAX_EDGE = 600
DEFAULT_COVER_MAX_BYTES = 150 * 1024

#: Containers whose header can be rebuilt safely. Anything else is left alone:
#: a format we cannot remux losslessly is a format we do not touch.
REMUXABLE = {".mp4": ".m4a", ".m4a": ".m4a", ".flac": ".flac", ".mp3": ".mp3"}


@dataclass(frozen=True)
class FileShape:
    """What a file will cost a listener before its first sample plays."""

    path: str
    size_bytes: int
    #: Real video, never an attached picture.
    video_codecs: tuple[str, ...]
    cover_bytes: int

    @property
    def has_video(self) -> bool:
        return bool(self.video_codecs)

    @property
    def needs_repair(self) -> bool:
        return self.has_video or self.cover_bytes > DEFAULT_COVER_MAX_BYTES


@dataclass(frozen=True)
class RepairResult:
    """One repaired file: where it went, and what it stopped costing."""

    path: str
    size_before: int
    size_after: int
    dropped_video: bool
    cover_before: int
    cover_after: int

    @property
    def saved_bytes(self) -> int:
        return max(0, self.size_before - self.size_after)


class RepairUnavailable(RuntimeError):
    """ffmpeg is missing, so nothing here can run. Never a reason to lose a file."""


def _ffmpeg() -> str:
    from shared.ffmpeg_runtime import ffmpeg_executable, resolve_ffmpeg

    if resolve_ffmpeg() is None:
        raise RepairUnavailable("ffmpeg is not available")
    return ffmpeg_executable()


def _ffprobe() -> str:
    binary = _ffmpeg()
    probe = Path(binary).with_name("ffprobe" + Path(binary).suffix)
    return str(probe) if probe.exists() else "ffprobe"


def _run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=False, **kwargs)


def extract_cover(path: str | Path) -> Optional[bytes]:
    """The artwork inside a file, or None. Delegates to the one extractor."""
    from setup_tool.audio import AudioProcessor

    try:
        return AudioProcessor.extract_cover_art(str(path))
    except Exception as exc:  # pragma: no cover — artwork is never load-bearing
        logger.debug("library_repair: could not read artwork from %s: %s", path, exc)
        return None


def inspect_file(path: str | Path) -> Optional[FileShape]:
    """What this file carries, or None when ffprobe cannot read it."""
    target = Path(path)
    if not target.is_file():
        return None
    try:
        probe = _run([
            _ffprobe(), "-v", "error", "-show_entries", "stream=codec_type,codec_name",
            "-of", "json", str(target),
        ])
    except (OSError, RepairUnavailable):
        return None
    if probe.returncode != 0:
        return None
    try:
        streams = json.loads(probe.stdout or "{}").get("streams") or []
    except json.JSONDecodeError:
        return None
    video = tuple(
        str(stream.get("codec_name"))
        for stream in streams
        if stream.get("codec_type") == "video" and stream.get("codec_name") not in STILL_IMAGE_CODECS
    )
    cover = extract_cover(target)
    return FileShape(
        path=str(target),
        size_bytes=target.stat().st_size,
        video_codecs=video,
        cover_bytes=len(cover or b""),
    )


def _audio_fingerprint(path: str | Path) -> Optional[str]:
    """MD5 of the *decoded* audio — the thing a remux must not change."""
    try:
        result = _run([_ffmpeg(), "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "md5", "-"])
    except (OSError, RepairUnavailable):
        return None
    if result.returncode != 0:
        return None
    line = (result.stdout or "").strip()
    return line.split("=", 1)[1] if "=" in line else None


def shrink_cover(
    data: bytes,
    *,
    max_edge: int = DEFAULT_COVER_MAX_EDGE,
    max_bytes: int = DEFAULT_COVER_MAX_BYTES,
) -> Optional[bytes]:
    """The same artwork, small enough to stop blocking the first note.

    Returns None when the image cannot be read, which leaves the caller free to
    keep whatever it already had rather than lose the cover to a repair.
    """
    if not data:
        return None
    try:
        from PIL import Image

        image = Image.open(io.BytesIO(data))
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        image.thumbnail((max_edge, max_edge), Image.LANCZOS)
        for quality in (85, 75, 65):
            buffer = io.BytesIO()
            image.save(buffer, "JPEG", quality=quality, optimize=True)
            if buffer.tell() <= max_bytes:
                return buffer.getvalue()
        return buffer.getvalue()
    except Exception as exc:  # pragma: no cover — artwork is never load-bearing
        logger.debug("library_repair: could not shrink artwork: %s", exc)
        return None


def embed_cover(path: str | Path, data: bytes) -> bool:
    """Put artwork back into a repaired file. JPEG bytes, every container."""
    target = Path(path)
    suffix = target.suffix.lower()
    try:
        if suffix in (".m4a", ".mp4"):
            from mutagen.mp4 import MP4, MP4Cover

            audio = MP4(str(target))
            audio["covr"] = [MP4Cover(data, imageformat=MP4Cover.FORMAT_JPEG)]
            audio.save()
            return True
        if suffix == ".flac":
            from mutagen.flac import FLAC, Picture

            audio = FLAC(str(target))
            audio.clear_pictures()
            picture = Picture()
            picture.type = 3
            picture.mime = "image/jpeg"
            picture.data = data
            audio.add_picture(picture)
            audio.save()
            return True
        if suffix == ".mp3":
            from mutagen.id3 import APIC, ID3, ID3NoHeaderError

            try:
                audio = ID3(str(target))
            except ID3NoHeaderError:
                audio = ID3()
            audio.delall("APIC")
            audio.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=data))
            audio.save(str(target), v2_version=3)
            return True
    except Exception as exc:  # pragma: no cover — artwork is never load-bearing
        logger.debug("library_repair: could not embed artwork into %s: %s", target, exc)
    return False


def repair_file(
    path: str | Path,
    *,
    destination: Optional[str | Path] = None,
    cover_max_edge: int = DEFAULT_COVER_MAX_EDGE,
    cover_max_bytes: int = DEFAULT_COVER_MAX_BYTES,
    verify: bool = True,
) -> Optional[RepairResult]:
    """Drop video streams and cap the artwork, leaving the audio untouched.

    Returns None when there was nothing to do. Raises nothing on a bad remux:
    the original file is left exactly as it was and the failure is logged, so a
    repair pass can never be the reason a library loses a song.
    """
    shape = inspect_file(path)
    if shape is None or not shape.needs_repair:
        return None

    source = Path(shape.path)
    suffix = REMUXABLE.get(source.suffix.lower())
    if suffix is None:
        return None

    cover = extract_cover(source)
    smaller = shrink_cover(cover, max_edge=cover_max_edge, max_bytes=cover_max_bytes) if cover else None
    before = _audio_fingerprint(source) if verify else None

    handle, temporary = tempfile.mkstemp(prefix=".repair-", suffix=suffix, dir=str(source.parent))
    os.close(handle)
    temp_path = Path(temporary)
    try:
        remux = _run([
            _ffmpeg(), "-y", "-i", str(source),
            # Audio only: this is what drops both the video track and the
            # attached picture. The artwork comes back below, sized.
            "-map", "0:a", "-c", "copy", "-map_metadata", "0",
            "-movflags", "+faststart", str(temp_path),
        ])
        if remux.returncode != 0 or not temp_path.exists() or temp_path.stat().st_size == 0:
            logger.warning("library_repair: remux failed for %s: %s", source, (remux.stderr or "").strip()[:200])
            return None

        if verify:
            after = _audio_fingerprint(temp_path)
            if not before or not after or before != after:
                logger.warning("library_repair: audio changed while repairing %s — leaving it alone", source)
                return None

        if smaller:
            embed_cover(temp_path, smaller)
        elif cover:
            # The image could not be re-encoded; keeping the original artwork
            # beats losing it, even at its original size.
            embed_cover(temp_path, cover)

        repaired_size = temp_path.stat().st_size
        target = Path(destination) if destination else source.with_suffix(suffix)
        if repaired_size >= shape.size_bytes and target == source:
            # Nothing gained. Not an error, just not worth rewriting a file for.
            return None
        os.replace(temp_path, target)
        if target != source and source.exists():
            source.unlink()
        return RepairResult(
            path=str(target),
            size_before=shape.size_bytes,
            size_after=repaired_size,
            dropped_video=shape.has_video,
            cover_before=shape.cover_bytes,
            cover_after=len(smaller or cover or b""),
        )
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


def repair_library(
    tracks: Iterable[Any],
    tracks_dir: str | Path,
    *,
    dry_run: bool = True,
    limit: int = 0,
    progress: Optional[Callable[[str], None]] = None,
    cover_max_edge: int = DEFAULT_COVER_MAX_EDGE,
    cover_max_bytes: int = DEFAULT_COVER_MAX_BYTES,
) -> dict[str, Any]:
    """Repair every stored file that carries video or oversized artwork.

    Returns ``{"repaired", "saved_bytes", "id_map", "tracks", "dry_run"}``.
    Repairing changes a file's bytes, and the hash of those bytes *is* the track
    id, so `id_map` is what the caller must hand to `remap_track_ids_for_all_users`
    and to the favourites manager.

    Every track comes back in `tracks`, repaired or not, built with
    `dataclasses.replace` — never rebuilt field by field, which is how
    `odst_tool/optimize_library.py` quietly drops `youtube_id`, `musicbrainz_id`
    and `added_at` from everything it touches.
    """
    from shared.path_resolver import resolve_local_track_path
    from setup_tool.audio import AudioProcessor

    def log(message: str) -> None:
        if progress:
            progress(message)
        else:
            logger.info("library_repair: %s", message)

    pool = Path(tracks_dir)
    id_map: dict[str, str] = {}
    updated: list[Any] = []
    repaired = saved = 0

    for track in tracks:
        if limit and repaired >= limit:
            updated.append(track)
            continue
        path = resolve_local_track_path(track)
        shape = inspect_file(path) if path else None
        if shape is None or not shape.needs_repair:
            updated.append(track)
            continue

        detail = []
        if shape.has_video:
            detail.append(f"video {'+'.join(shape.video_codecs)}")
        if shape.cover_bytes > cover_max_bytes:
            detail.append(f"cover {shape.cover_bytes // 1024} KB")
        log(f"{track.artist} — {track.title}: {', '.join(detail)}")
        if dry_run:
            repaired += 1
            saved += shape.size_bytes  # unknowable without doing it; report the ceiling
            updated.append(track)
            continue

        result = repair_file(
            path,
            cover_max_edge=cover_max_edge,
            cover_max_bytes=cover_max_bytes,
        )
        if result is None:
            updated.append(track)
            continue

        new_hash = AudioProcessor.calculate_hash(result.path)
        extension = Path(result.path).suffix.lstrip(".")
        final_path = pool / f"{new_hash}.{extension}"
        if str(final_path) != result.path:
            shutil.move(result.path, str(final_path))
        duration = getattr(track, "duration", 0) or 0
        bitrate = int(result.size_after * 8 / duration / 1000) if duration else getattr(track, "bitrate", 0)
        refreshed = replace(
            track,
            id=new_hash,
            file_hash=new_hash,
            file_size=result.size_after,
            format=extension,
            bitrate=bitrate,
            local_path=None,
        )
        if refreshed.id != track.id:
            id_map[track.id] = refreshed.id
        updated.append(refreshed)
        repaired += 1
        saved += result.saved_bytes
        log(f"   -> {result.size_before // 1024 // 1024} MB to {result.size_after // 1024 // 1024} MB")

    return {
        "repaired": repaired,
        "saved_bytes": saved,
        "id_map": id_map,
        "tracks": updated,
        "dry_run": dry_run,
    }
