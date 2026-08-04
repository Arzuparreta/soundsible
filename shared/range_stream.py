"""Bounded range responses for the routes that hand a file to a media element.

A browser opens a track by asking for `Range: bytes=0-`, and the engine used to
answer with the whole thing: one HTTP response carrying the entire file. For a
library of 24-bit FLAC that is a p50 of 36 MB and a p90 of 124 MB riding a single
connection that has to survive for minutes. It frequently does not. Measured over
265 local streams on a real station: 89% of plays stalled at least once, one track
was requested 82 times, and 40 distinct tracks cost 2.3 GB — 3.6x their own size,
re-fetched by a player restarting responses that died in flight.

The engine itself was never slow; `open_ms` was 0.2 ms at the median. What costs
the listener is the *shape* of the response, so that is what this module changes:
answer an open-ended range with a bounded slice and let the player come back for
the next one. A dropped connection then costs one chunk instead of one song.

The bytes are untouched. This is a slicing policy, not a transcoder — the same
file is served, and walking the chunks back-to-back reassembles it byte for byte.

Only *open-ended* ranges (`bytes=N-`) are bounded. An explicit `bytes=100-200` or
a suffix `bytes=-1024` is answered exactly as asked: those are how an MP4 demuxer
hunts for a `moov` atom at the end of the file, and shrinking one breaks playback.
A request with no `Range` at all still gets the complete file under a 200, because
an unsolicited 206 violates RFC 7233 and would break plain downloads.

Nothing here parses or emits a range response. The caller rewrites `HTTP_RANGE` in
the WSGI environ and hands off to `send_file(..., conditional=True)` exactly as
before; Werkzeug reads the range from that environ and keeps producing the 206,
the `Content-Range` against the file's true total length, `Content-Length`,
`Accept-Ranges`, and the validators.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

#: How much audio the first chunk should carry. Small, because it is the only one
#: standing between a click and a sound.
DEFAULT_FIRST_CHUNK_SEC = 3.0
#: And every chunk after it. Large enough that a track is a handful of requests
#: rather than a stream of them, short enough that losing one is not felt.
DEFAULT_CHUNK_SEC = 20.0

#: Floors, and they are different on purpose. The first chunk is allowed to be
#: small because it is the one the listener is waiting on. Every chunk after it
#: has a much higher floor, because seconds-of-audio sizing turns a 155 kbps file
#: into a stream of 380 KB requests — seventeen of them for a six-megabyte track,
#: which is chatter with nothing to show for it. The fragility this module exists
#: to fix belongs to responses of tens or hundreds of megabytes; a small file was
#: never the problem and should not be chopped up as if it were.
DEFAULT_MIN_FIRST_CHUNK_BYTES = 256 * 1024
DEFAULT_MIN_CHUNK_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024

#: Used when a track has no trustworthy duration. Sized for the middle of the
#: library rather than for any particular file.
FALLBACK_FIRST_CHUNK_BYTES = 512 * 1024
FALLBACK_CHUNK_BYTES = 4 * 1024 * 1024

#: One open-ended range and nothing else. A multi-range request (`bytes=0-1,8-9`)
#: deliberately fails this: those get a multipart response from Werkzeug and are
#: not ours to reshape.
_OPEN_RANGE_RE = re.compile(r"^\s*bytes\s*=\s*(\d+)\s*-\s*$")

#: Any range that names a first byte, open-ended or not. Only used for reporting.
_RANGE_START_RE = re.compile(r"^\s*bytes\s*=\s*(\d+)\s*-")


def requested_start(range_header: str | None) -> int:
    """The byte offset a request asked to start at, for telemetry.

    Zero for no range and for a suffix range, neither of which names a first
    byte. Reading a chunk walk back from the log needs this: without it every
    request for one track is indistinguishable from a retry of the first.
    """
    match = _RANGE_START_RE.match(range_header or "")
    return int(match.group(1)) if match else 0


def is_enabled() -> bool:
    """Whether open-ended ranges get bounded at all.

    A kill switch rather than a feature flag: turning it off restores the previous
    behaviour byte for byte, which is what makes a before/after comparison on the
    same telemetry possible without a rollback.
    """
    raw = os.environ.get("SOUNDSIBLE_STREAM_BOUNDED")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _env_number(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw.strip())
    except ValueError:
        return default
    return value if value > 0 else default


def chunk_bytes(*, total_bytes: int, duration_sec: float | None, is_first: bool) -> int:
    """How many bytes to serve for one chunk of this particular file.

    Sized in seconds of audio, not in bytes, so that a 128 kbps AAC and a 1.7 Mbps
    24-bit FLAC cost a comparable number of requests per minute played. A fixed
    byte size would make the FLAC ten times chattier than the AAC for no reason.
    """
    seconds = _env_number(
        "SOUNDSIBLE_STREAM_FIRST_CHUNK_SEC" if is_first else "SOUNDSIBLE_STREAM_CHUNK_SEC",
        DEFAULT_FIRST_CHUNK_SEC if is_first else DEFAULT_CHUNK_SEC,
    )
    if duration_sec and duration_sec > 0 and total_bytes > 0:
        size = int(total_bytes / duration_sec * seconds)
    else:
        size = FALLBACK_FIRST_CHUNK_BYTES if is_first else FALLBACK_CHUNK_BYTES
    floor = int(
        _env_number(
            "SOUNDSIBLE_STREAM_FIRST_CHUNK_MIN_BYTES" if is_first else "SOUNDSIBLE_STREAM_CHUNK_MIN_BYTES",
            DEFAULT_MIN_FIRST_CHUNK_BYTES if is_first else DEFAULT_MIN_CHUNK_BYTES,
        )
    )
    ceiling = int(_env_number("SOUNDSIBLE_STREAM_CHUNK_MAX_BYTES", DEFAULT_MAX_CHUNK_BYTES))
    return max(floor, min(size, max(floor, ceiling)))


@dataclass(frozen=True)
class BoundedRange:
    """The slice an open-ended range was narrowed to. `end` is inclusive."""

    start: int
    end: int
    total_bytes: int

    @property
    def served_bytes(self) -> int:
        return self.end - self.start + 1


def bound_open_range(
    environ: dict,
    *,
    total_bytes: int,
    duration_sec: float | None = None,
) -> BoundedRange | None:
    """Narrow an open-ended `Range` in `environ`, in place.

    Returns the slice that was applied, or None when the request was left exactly
    as it arrived — which covers a disabled kill switch, a missing or explicit or
    suffix or multi range, a start past the end of the file (Werkzeug owns that
    416), and the last chunk of a file, where what remains already fits.
    """
    if not is_enabled() or total_bytes <= 0:
        return None
    match = _OPEN_RANGE_RE.match(environ.get("HTTP_RANGE") or "")
    if not match:
        return None
    start = int(match.group(1))
    if start >= total_bytes:
        return None
    size = chunk_bytes(total_bytes=total_bytes, duration_sec=duration_sec, is_first=start == 0)
    end = start + size - 1
    if end >= total_bytes - 1:
        # The tail already fits in one chunk. Rewriting `bytes=N-` into an explicit
        # range that means the same thing would only cost the reader a header it
        # cannot act on.
        return None
    environ["HTTP_RANGE"] = f"bytes={start}-{end}"
    return BoundedRange(start=start, end=end, total_bytes=total_bytes)
