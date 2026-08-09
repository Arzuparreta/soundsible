"""On-the-fly transcoding for the Subsonic ``stream`` endpoint.

Most requests do not come here. A client at home asks for the file and gets the
file, byte ranges and all — that path is worth protecting, so the decision to
transcode is made narrowly and everything else falls through to ``send_file``.

When a client on mobile data does ask for a smaller stream, ffmpeg encodes into
a pipe and the bytes are forwarded as they appear. Such a response has no
length and no byte ranges, which is not a regression: Subsonic seeks inside a
transcoded stream by re-requesting with ``timeOffset``, and that works here.

Two things this must not do. It must not leave ffmpeg running when the listener
skips the track — a phone on a bad line reconnects often, and every abandoned
encode would otherwise keep a core busy. And it must not let a handful of
clients start unbounded work: past the concurrency limit a request is served
the original file instead of queueing behind an encoder.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from typing import Iterator, Optional

from shared.ffmpeg_runtime import ffmpeg_executable, resolve_ffmpeg

logger = logging.getLogger(__name__)

#: Formats we will encode into, and what to tell the client they are.
TARGET_FORMATS = {
    "mp3": ("audio/mpeg", ["-f", "mp3", "-codec:a", "libmp3lame"]),
    "opus": ("audio/ogg", ["-f", "ogg", "-codec:a", "libopus"]),
    "ogg": ("audio/ogg", ["-f", "ogg", "-codec:a", "libvorbis"]),
}

DEFAULT_FORMAT = "mp3"
CHUNK_BYTES = 64 * 1024

#: How many encodes may run at once. Small on purpose: this is a home server,
#: and the honest answer to "everyone at once" is to serve the original.
MAX_CONCURRENT = int(os.getenv("SOUNDSIBLE_SUBSONIC_MAX_TRANSCODES", "2") or 2)

_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


def normalize_format(requested: Optional[str]) -> Optional[str]:
    """The target format, or ``None`` when the client asked for the file itself."""
    value = (requested or "").strip().lower()
    if not value or value == "raw":
        return None
    return value if value in TARGET_FORMATS else DEFAULT_FORMAT


def should_transcode(
    *,
    source_format: Optional[str],
    source_bitrate: Optional[int],
    requested_format: Optional[str],
    max_bitrate: Optional[int],
) -> bool:
    """Whether this request genuinely needs re-encoding.

    ``format=raw`` never does. Neither does a bitrate ceiling the file already
    sits under, nor a format request that names what the file already is.
    """
    if (requested_format or "").strip().lower() == "raw":
        return False
    if not resolve_ffmpeg():
        return False

    source = (source_format or "").strip().lower()
    target = normalize_format(requested_format)

    if max_bitrate and source_bitrate and int(source_bitrate) > int(max_bitrate):
        return True
    if target and target != source:
        # An explicit format request for something else is a real request; the
        # aliases exist because clients disagree on how to spell the same file.
        return not (target == "ogg" and source in ("ogg", "oga", "opus"))
    return False


def transcode_command(
    path: str,
    *,
    target_format: str,
    bitrate_kbps: int,
    time_offset: int = 0,
) -> list[str]:
    """The ffmpeg argv for one encode. Split out so tests can read it."""
    _, codec_args = TARGET_FORMATS.get(target_format, TARGET_FORMATS[DEFAULT_FORMAT])
    command = [ffmpeg_executable(), "-hide_banner", "-loglevel", "error", "-nostdin"]
    if time_offset > 0:
        # Before -i, so ffmpeg seeks the input instead of decoding and dropping.
        command += ["-ss", str(int(time_offset))]
    command += ["-i", path, "-map", "0:a:0", "-vn", "-b:a", f"{int(bitrate_kbps)}k"]
    command += codec_args
    command += ["-"]
    return command


def estimated_length(duration_sec: Optional[int], bitrate_kbps: int, time_offset: int = 0) -> Optional[int]:
    """Bytes this encode will roughly produce, for ``estimateContentLength``."""
    if not duration_sec or duration_sec <= 0:
        return None
    remaining = max(0, int(duration_sec) - max(0, int(time_offset)))
    return int(remaining * int(bitrate_kbps) * 1000 / 8)


def stream_transcoded(
    path: str,
    *,
    target_format: str,
    bitrate_kbps: int,
    time_offset: int = 0,
) -> Optional[tuple[Iterator[bytes], str]]:
    """Start an encode and return ``(chunks, content type)``, or ``None``.

    ``None`` means "serve the original": no ffmpeg, no free slot, or the
    process refused to start. Every one of those is better answered with the
    file than with an error a listener would read as a broken library.
    """
    if not resolve_ffmpeg():
        return None
    if not _slots.acquire(blocking=False):
        logger.info("Subsonic: %d transcodes already running, serving the original file", MAX_CONCURRENT)
        return None

    mimetype, _ = TARGET_FORMATS.get(target_format, TARGET_FORMATS[DEFAULT_FORMAT])
    command = transcode_command(
        path, target_format=target_format, bitrate_kbps=bitrate_kbps, time_offset=time_offset
    )
    try:
        process = subprocess.Popen(  # noqa: S603 — argv built here, never a shell
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )
    except OSError as exc:
        _slots.release()
        logger.warning("Subsonic: could not start ffmpeg (%s); serving the original file", exc)
        return None

    return _pump(process), mimetype


def _pump(process: subprocess.Popen) -> Iterator[bytes]:
    """Forward ffmpeg's output, and make sure it dies when the client leaves."""
    try:
        assert process.stdout is not None
        while True:
            chunk = process.stdout.read(CHUNK_BYTES)
            if not chunk:
                break
            yield chunk
    finally:
        # GeneratorExit lands here when the listener skips the track. Without
        # this the encoder keeps going until it fills the pipe buffer and then
        # blocks forever, holding a slot nobody is listening to.
        try:
            if process.poll() is None:
                process.kill()
            if process.stdout is not None:
                process.stdout.close()
            process.wait(timeout=5)
        except Exception:  # pragma: no cover — teardown must not raise
            logger.debug("Subsonic: ffmpeg teardown was not clean", exc_info=True)
        finally:
            _slots.release()
