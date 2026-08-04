"""The chunk-sizing policy, away from Flask.

`tests/test_stream_range_bounding.py` proves the route behaves; this proves the
decisions behind it, including the ones a route test cannot reach cheaply — a
1.4 GB file, a track with no duration, a malformed header.
"""

from __future__ import annotations

import pytest

from shared.range_stream import (
    DEFAULT_MAX_CHUNK_BYTES,
    DEFAULT_MIN_CHUNK_BYTES,
    DEFAULT_MIN_FIRST_CHUNK_BYTES,
    KIND_CLOSED,
    KIND_NONE,
    KIND_OPEN,
    KIND_SUFFIX,
    OUTCOME_BOUNDED,
    OUTCOME_CLOSED,
    OUTCOME_DISABLED,
    OUTCOME_PAST_END,
    OUTCOME_TAIL_FITS,
    bound_open_range,
    chunk_bytes,
    classify_range,
    requested_start,
)

MINUTE = 60


def test_chunks_are_sized_in_seconds_of_audio_not_in_bytes():
    """Two tracks of the same length cost the same number of requests.

    Sizing in bytes would make a 24-bit FLAC twice as chatty as a 16-bit one for
    no reason at all, since they are the same music for the same duration. Both
    files here are well clear of the floor and the ceiling, so what is under test
    is the sizing and not the clamps.
    """
    sixteen = 35 * 1024 * 1024
    twentyfour = 70 * 1024 * 1024

    lighter = chunk_bytes(total_bytes=sixteen, duration_sec=4 * MINUTE, is_first=False)
    heavier = chunk_bytes(total_bytes=twentyfour, duration_sec=4 * MINUTE, is_first=False)

    # Same 20 seconds of audio either way, so the byte sizes track the bitrates
    # and the request counts come out equal.
    assert heavier == pytest.approx(lighter * 2, rel=0.01)
    assert sixteen / lighter == pytest.approx(twentyfour / heavier, rel=0.01)


def test_the_first_chunk_is_smaller_than_the_rest():
    """It is the only one standing between a click and a sound."""
    first = chunk_bytes(total_bytes=50 * 1024 * 1024, duration_sec=4 * MINUTE, is_first=True)
    rest = chunk_bytes(total_bytes=50 * 1024 * 1024, duration_sec=4 * MINUTE, is_first=False)

    assert first < rest


def test_chunk_sizes_stay_within_their_clamps():
    """A 727 MB DJ set is in this library, and so are three-second stingers."""
    huge = chunk_bytes(total_bytes=727 * 1024 * 1024, duration_sec=65 * MINUTE, is_first=False)
    sliver = chunk_bytes(total_bytes=8 * 1024, duration_sec=3, is_first=True)

    assert huge <= DEFAULT_MAX_CHUNK_BYTES
    assert sliver >= DEFAULT_MIN_FIRST_CHUNK_BYTES


def test_a_small_low_bitrate_file_is_not_chopped_into_chatter():
    """Seconds-of-audio sizing alone would ask for a 6 MB track seventeen times.

    A response of a few megabytes was never the failure this module is about, so
    the floor keeps it to a handful of requests. Only the first chunk is allowed
    below that, because it is the one a listener is waiting on.
    """
    total = 6 * 1024 * 1024  # a 155 kbps track, the shape of the .mp4 half of the library

    first = chunk_bytes(total_bytes=total, duration_sec=5 * MINUTE, is_first=True)
    rest = chunk_bytes(total_bytes=total, duration_sec=5 * MINUTE, is_first=False)

    assert first == DEFAULT_MIN_FIRST_CHUNK_BYTES
    assert (total - first) / rest < 4


@pytest.mark.parametrize("duration", [None, 0, -1])
def test_a_track_without_a_usable_duration_falls_back_to_byte_sizes(duration):
    size = chunk_bytes(total_bytes=40 * 1024 * 1024, duration_sec=duration, is_first=False)

    assert DEFAULT_MIN_CHUNK_BYTES <= size <= DEFAULT_MAX_CHUNK_BYTES


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "bytes=100-200",  # explicit: the caller named both ends
        "bytes=-1024",  # suffix: an MP4 demuxer hunting for `moov`
        "bytes=0-1,8-9",  # multi-range: Werkzeug answers this multipart
        "chunks=0-",  # not a byte range at all
        "garbage",
    ],
)
def test_only_open_ended_byte_ranges_are_narrowed(header):
    environ = {"HTTP_RANGE": header} if header is not None else {}
    before = dict(environ)

    decision = bound_open_range(environ, total_bytes=40 * 1024 * 1024, duration_sec=240)

    assert not decision.bounded
    assert decision.applied is None
    assert environ == before


def test_an_open_range_rewrites_the_environ_in_place():
    environ = {"HTTP_RANGE": "bytes=0-"}

    decision = bound_open_range(environ, total_bytes=40 * 1024 * 1024, duration_sec=240)

    assert decision.bounded
    assert decision.outcome == OUTCOME_BOUNDED
    assert decision.applied.start == 0
    assert decision.applied.served_bytes == decision.applied.end + 1
    assert environ["HTTP_RANGE"] == f"bytes=0-{decision.applied.end}"


def test_a_tail_that_already_fits_is_left_alone():
    """Rewriting `bytes=N-` into a range meaning the same thing helps nobody."""
    total = 40 * 1024 * 1024
    environ = {"HTTP_RANGE": f"bytes={total - 1024}-"}

    decision = bound_open_range(environ, total_bytes=total, duration_sec=240)

    assert not decision.bounded
    assert decision.outcome == OUTCOME_TAIL_FITS
    assert environ["HTTP_RANGE"] == f"bytes={total - 1024}-"


def test_a_start_past_the_end_is_left_for_werkzeug_to_refuse():
    """That 416 is not ours to invent."""
    environ = {"HTTP_RANGE": "bytes=999999999-"}

    decision = bound_open_range(environ, total_bytes=1024, duration_sec=10)

    assert not decision.bounded
    assert decision.outcome == OUTCOME_PAST_END


def test_the_kill_switch_stops_the_rewrite(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_STREAM_BOUNDED", "0")
    environ = {"HTTP_RANGE": "bytes=0-"}

    decision = bound_open_range(environ, total_bytes=40 * 1024 * 1024, duration_sec=240)

    assert not decision.bounded
    assert decision.outcome == OUTCOME_DISABLED
    assert environ["HTTP_RANGE"] == "bytes=0-"


def test_a_passthrough_says_which_kind_of_passthrough_it_was():
    """`bounded: false` covered several unrelated situations and hid the one that
    mattered. Post-merge, 69 of 95 requests went through untouched and separating
    "an MP4 demuxer never reaches this policy" from "the tail already fitted" took
    an afternoon of raw rows. It is one field now."""
    total = 40 * 1024 * 1024

    closed = bound_open_range({"HTTP_RANGE": "bytes=0-41943039"}, total_bytes=total)
    suffix = bound_open_range({"HTTP_RANGE": "bytes=-1024"}, total_bytes=total)
    absent = bound_open_range({}, total_bytes=total)

    assert (closed.kind, closed.outcome) == (KIND_CLOSED, OUTCOME_CLOSED)
    assert suffix.kind == KIND_SUFFIX
    assert absent.kind == KIND_NONE
    # Three different reasons, three different outcomes, none of them each other.
    assert len({closed.outcome, suffix.outcome, absent.outcome}) == 3


def test_a_closed_range_reports_how_much_of_the_file_it_wanted():
    """The number that sizes the gap the policy cannot reach.

    An MP4 demuxer asking for everything and the same demuxer reading an atom both
    send closed ranges, and under a boolean they are the same row. The share of the
    remaining file is what tells them apart: 53 of the 69 untouched requests in the
    first measurement wanted essentially all of it.
    """
    total = 20 * 1024 * 1024

    everything = bound_open_range({"HTTP_RANGE": f"bytes=65536-{total - 1}"}, total_bytes=total)
    an_atom = bound_open_range({"HTTP_RANGE": "bytes=16375-65535"}, total_bytes=total)

    assert everything.wants_whole_remainder
    assert not an_atom.wants_whole_remainder
    assert an_atom.span_ratio < 0.01


def test_an_open_range_always_wants_the_whole_remainder():
    """It is the same request as a closed range to the end, spelled shorter."""
    kind, span = classify_range("bytes=0-", total_bytes=40 * 1024 * 1024)

    assert kind == KIND_OPEN
    assert span == 1.0


def test_chunk_seconds_are_tunable(monkeypatch):
    # Sized to stay clear of the clamps, or this would only prove they hold.
    total = 30 * 1024 * 1024
    monkeypatch.setenv("SOUNDSIBLE_STREAM_CHUNK_SEC", "40")

    doubled = chunk_bytes(total_bytes=total, duration_sec=4 * MINUTE, is_first=False)
    monkeypatch.delenv("SOUNDSIBLE_STREAM_CHUNK_SEC")
    default = chunk_bytes(total_bytes=total, duration_sec=4 * MINUTE, is_first=False)

    assert doubled == pytest.approx(default * 2, rel=0.01)


@pytest.mark.parametrize(
    "header,expected",
    [
        (None, 0),
        ("bytes=0-", 0),
        ("bytes=1048576-", 1048576),
        ("bytes=100-200", 100),
        ("bytes=-1024", 0),  # a suffix range names no first byte
        ("nonsense", 0),
    ],
)
def test_requested_start_reads_the_offset_for_the_report(header, expected):
    assert requested_start(header) == expected
