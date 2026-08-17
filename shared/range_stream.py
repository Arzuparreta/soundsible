"""Bounded range responses for the routes that hand a file to a media element.

A browser opens a track by asking for `Range: bytes=0-`, and the engine used to
answer with the whole thing: one HTTP response carrying the entire file. For a
library of 24-bit FLAC that is a p50 of 36 MB and a p90 of 124 MB riding a single
connection that has to survive for minutes. It frequently does not. Measured over
265 local streams on a real station, 40 distinct tracks cost 2.3 GB — 1.55x their
own size, re-fetched by a player restarting responses that died in flight, and one
track was requested 82 times.

The engine itself was never slow; `open_ms` was 0.2 ms at the median. What costs
the listener is the *shape* of the response, so that is what this module changes:
answer an open-ended range with a bounded slice and let the player come back for
the next one. A dropped connection then costs one chunk instead of one song.

The bytes are untouched. This is a slicing policy, not a transcoder — the same
file is served, and walking the chunks back-to-back reassembles it byte for byte.

A request is narrowed when it asks for *everything from here on*, however it spells
that: `bytes=N-`, or a closed `bytes=N-<end of file>`. The second spelling is not a
detail. Every request in the captured iPhone sessions was the closed one — WebKit
asks for everything from an offset to the last byte, and never `bytes=N-` — so for
those listeners this module used to do nothing at all. Measured on one station's
log: 1459 such requests promising 9.3 GB, not one of them reached. What that costs
is visible in a single startup, an 11 MB track over a relayed link: 24 requests in
28 seconds, each promising ten megabytes, each abandoned after a few tens of
kilobytes, and because an abandoned response cannot be kept alive, each paying for
a fresh connection. Bounded, the same track is six complete responses.

A *small* closed range is still answered exactly as asked: those are how an MP4
demuxer hunts for a `moov` atom, and shrinking one breaks playback. The line between
the two is `WHOLE_FILE_SPAN_RATIO` plus the size of the chunk we would serve — a
request has to want essentially all of what is left *and* comfortably more than one
chunk of it before anything is narrowed. A suffix `bytes=-1024` is never touched: it
is measured from the end of the file, so a shorter answer would be a different one.
A request with no `Range` at all still gets the complete file under a 200, because
an unsolicited 206 violates RFC 7233 and would break plain downloads.

Nothing here parses or emits a range response. The caller rewrites `HTTP_RANGE` in
the WSGI environ and hands off to `send_file(..., conditional=True)` exactly as
before; Werkzeug reads the range from that environ and keeps producing the 206,
the `Content-Range` against the file's true total length, `Content-Length`,
`Accept-Ranges`, and the validators.

Every decision is returned as a `RangeDecision` rather than as a bare slice-or-None,
because "this response was not narrowed" turned out to cover several very different
situations and the log could not tell them apart. Post-merge measurement of the first
16 minutes of real traffic: 69 of 95 requests went through untouched, and reading
*why* took an afternoon of picking through raw rows by hand. Fifty-three of them were
explicit ranges that asked for essentially the whole remaining file — an MP4 demuxer,
which never sends `bytes=N-` at all and so never reaches the narrowing path. Nine were
the small explicit ranges of a `moov` hunt, which must keep passing through untouched.
Those two look identical under a boolean. They are not the same finding, and the one
that matters is worth being able to read off a report.
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

#: Both ends named: `bytes=100-200`. What an MP4 demuxer sends, for everything.
_CLOSED_RANGE_RE = re.compile(r"^\s*bytes\s*=\s*(\d+)\s*-\s*(\d+)\s*$")

#: The last N bytes: `bytes=-1024`. How a `moov` atom parked at the end is found.
_SUFFIX_RANGE_RE = re.compile(r"^\s*bytes\s*=\s*-\s*(\d+)\s*$")

#: A closed range asking for at least this much of what is left of the file is a
#: whole-file request wearing a different header, whatever the client believes it
#: is doing. Below it, the request is a demuxer reading a specific structure and
#: the size it asked for is the size it needs.
WHOLE_FILE_SPAN_RATIO = 0.95

#: How many chunks a closed range must be worth before it is narrowed. A request
#: that already fits in about one chunk is answered as asked: shortening it would
#: buy nothing and would turn one response into two.
CLOSED_RANGE_CHUNK_MARGIN = 2

#: What kind of `Range` header arrived. Recorded for every request.
KIND_NONE = "none"
KIND_OPEN = "open"
KIND_CLOSED = "closed"
KIND_SUFFIX = "suffix"
KIND_OTHER = "other"

#: What was done about it. `bounded` is the only one that reshapes a response;
#: every `passthrough_*` answers the request exactly as it arrived, and they are
#: kept apart because they are not one finding.
OUTCOME_BOUNDED = "bounded"
#: The same narrowing, applied to a closed range that wanted the whole remainder.
#: Kept apart from `bounded` so the report can still tell what a client asked for
#: — the two shapes come from different media stacks and fail differently.
OUTCOME_BOUNDED_CLOSED = "bounded_closed"
OUTCOME_DISABLED = "passthrough_disabled"
OUTCOME_NO_RANGE = "passthrough_no_range"
OUTCOME_CLOSED = "passthrough_closed"
OUTCOME_SUFFIX = "passthrough_suffix"
OUTCOME_OTHER = "passthrough_other"
OUTCOME_TAIL_FITS = "passthrough_tail_fits"
OUTCOME_PAST_END = "passthrough_past_end"
OUTCOME_EMPTY = "passthrough_empty_file"


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


@dataclass(frozen=True)
class RangeDecision:
    """What arrived, what was done about it, and how much of the file it wanted.

    `applied` is the only field that describes a change to the response. The rest
    exists so the log can answer "which requests does this policy never reach, and
    how much traffic is that" without anyone re-deriving it from raw offsets.
    """

    kind: str
    outcome: str
    applied: BoundedRange | None = None
    #: How much of what remains of the file this request asked for, where that is
    #: knowable — 1.0 for an open-ended range, the measured share for a closed one,
    #: None for a suffix range or no range at all. The share is what separates an
    #: MP4 demuxer asking for everything from the same demuxer reading an atom.
    span_ratio: float | None = None

    @property
    def bounded(self) -> bool:
        return self.applied is not None

    @property
    def wants_whole_remainder(self) -> bool:
        """A request for essentially all of what is left, however it was spelled."""
        return self.span_ratio is not None and self.span_ratio >= WHOLE_FILE_SPAN_RATIO


def classify_range(range_header: str | None, *, total_bytes: int = 0) -> tuple[str, float | None]:
    """The shape of a `Range` header, and the share of the remaining file it wants.

    Split out from the narrowing decision because it has to run even when nothing
    is narrowed: a request that never reaches the policy is exactly the one worth
    counting.
    """
    raw = (range_header or "").strip()
    if not raw:
        return KIND_NONE, None
    if _OPEN_RANGE_RE.match(raw):
        return KIND_OPEN, 1.0
    closed = _CLOSED_RANGE_RE.match(raw)
    if closed:
        start, end = int(closed.group(1)), int(closed.group(2))
        remaining = total_bytes - start
        if remaining <= 0 or end < start:
            return KIND_CLOSED, None
        return KIND_CLOSED, min(1.0, (end - start + 1) / remaining)
    if _SUFFIX_RANGE_RE.match(raw):
        return KIND_SUFFIX, None
    return KIND_OTHER, None


def bound_open_range(
    environ: dict,
    *,
    total_bytes: int,
    duration_sec: float | None = None,
) -> RangeDecision:
    """Narrow a `Range` that asks for the whole remainder, in `environ`, in place.

    Always returns a decision; `decision.applied` is the slice that was written, or
    None when the request was left exactly as it arrived. What is left alone: a
    disabled kill switch, a missing or suffix or multi range, a closed range that
    wants a specific part rather than the rest, a start past the end of the file
    (Werkzeug owns that 416), and the last chunk of a file, where what remains
    already fits.
    """
    raw = environ.get("HTTP_RANGE")
    kind, span = classify_range(raw, total_bytes=total_bytes)
    if total_bytes <= 0:
        return RangeDecision(kind, OUTCOME_EMPTY, span_ratio=span)
    if not is_enabled():
        return RangeDecision(kind, OUTCOME_DISABLED, span_ratio=span)
    if kind not in {KIND_OPEN, KIND_CLOSED}:
        outcome = {KIND_NONE: OUTCOME_NO_RANGE, KIND_SUFFIX: OUTCOME_SUFFIX}.get(kind, OUTCOME_OTHER)
        return RangeDecision(kind, outcome, span_ratio=span)

    start = requested_start(raw)
    if start >= total_bytes:
        return RangeDecision(kind, OUTCOME_PAST_END, span_ratio=span)
    size = chunk_bytes(total_bytes=total_bytes, duration_sec=duration_sec, is_first=start == 0)

    if kind == KIND_CLOSED:
        closed = _CLOSED_RANGE_RE.match(raw)
        requested = int(closed.group(2)) - start + 1
        # Everything from here on, and enough of it to be worth splitting. Below
        # either line this is a demuxer reading a structure it named exactly.
        if span is None or span < WHOLE_FILE_SPAN_RATIO or requested <= size * CLOSED_RANGE_CHUNK_MARGIN:
            return RangeDecision(kind, OUTCOME_CLOSED, span_ratio=span)

    end = start + size - 1
    if end >= total_bytes - 1:
        # The tail already fits in one chunk. Rewriting the header into a range
        # that means the same thing would only cost the reader one it cannot act on.
        return RangeDecision(kind, OUTCOME_TAIL_FITS, span_ratio=span)
    environ["HTTP_RANGE"] = f"bytes={start}-{end}"
    return RangeDecision(
        kind,
        OUTCOME_BOUNDED if kind == KIND_OPEN else OUTCOME_BOUNDED_CLOSED,
        applied=BoundedRange(start=start, end=end, total_bytes=total_bytes),
        span_ratio=span,
    )
