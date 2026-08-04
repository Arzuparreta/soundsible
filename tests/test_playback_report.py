import json

from scripts.playback_report import build_report

NOW = 9_999_999_999


def write(path, rows):
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    return path


def test_report_joins_server_egress_and_excludes_legacy_rows(tmp_path):
    path = tmp_path / "play-timing.jsonl"
    rows = [
        {
            "v": 1,
            "event": "play_timing",
            "ts": NOW,
            "segments": {"click_to_playing_ms": 1},
        },
        {
            "v": 2,
            "event": "play_timing",
            "ts": NOW,
            "attempt_id": "a",
            "phase": "server_stream_ready",
            "source_kind": "preview",
            "cache_state": "url_warm",
            "egress": "relay",
            "segments": {"resolve_ms": 0},
        },
        {
            "v": 2,
            "event": "play_timing",
            "ts": NOW,
            "attempt_id": "a",
            "phase": "ui_click_to_playing",
            "source_kind": "preview",
            "cache_state": "unknown",
            "egress": "unknown",
            "segments": {"click_to_playing_ms": 900},
        },
    ]

    report = build_report(write(path, rows), days=7)

    assert report["samples"] == 1
    # The server row carries no `bounded` key, so this play was served by the
    # regime that predates the change and says so in its own bucket name.
    bucket = report["buckets"]["preview_relay_url_warm [whole_file]"]
    assert bucket["p95_ms"] == 900
    assert bucket["status"] == "insufficient_data"


def test_local_starts_are_split_by_what_triggered_them(tmp_path):
    """A click and a track boundary are not the same measurement.

    Starting a downloaded song from cold is what a listener feels as slow;
    crossing into the next one is handed over from a deck that has been holding
    the stream for minutes. Averaged together, a regression in the first is
    hidden by the second.
    """
    path = tmp_path / "play-timing.jsonl"
    rows = [
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": attempt,
            "phase": "ui_click_to_playing",
            "source_kind": "local",
            "trigger": trigger,
            "segments": {"click_to_playing_ms": ms},
        }
        for attempt, trigger, ms in (
            ("a", "selection", 1400),
            ("b", "ended", 20),
            ("c", "", 500),
        )
    ]

    report = build_report(write(path, rows), days=7)

    # No server row to join to, so none of these can be attributed to a regime —
    # said out loud rather than folded into whichever one is being defended.
    assert report["buckets"]["local_selection [unjoined]"]["median_ms"] == 1400
    assert report["buckets"]["local_ended [unjoined]"]["median_ms"] == 20
    # An unrecognised trigger still lands somewhere rather than being dropped.
    assert report["buckets"]["local [unjoined]"]["median_ms"] == 500


def test_the_same_trigger_is_reported_once_per_delivery_regime(tmp_path):
    """The whole point of the split.

    Two clicks on the same kind of track, one served whole and one served in
    chunks, are two populations. Averaged into one bucket the comparison the log
    exists to support cannot be made at all — which is what the report did before,
    while the delivery section beside it was already splitting them.
    """
    path = tmp_path / "play-timing.jsonl"
    rows = []
    for attempt, track, ms, segments in (
        ("old", "t1", 8000, {"open_ms": 0.2}),
        ("new", "t2", 700, {"open_ms": 0.2, "bounded": True}),
    ):
        rows.append(
            {
                "v": 2,
                "ts": NOW,
                "attempt_id": attempt,
                "track_id": track,
                "phase": "server_stream_ready",
                "source_kind": "local",
                "segments": segments,
            }
        )
        rows.append(
            {
                "v": 2,
                "ts": NOW,
                "attempt_id": attempt,
                "track_id": track,
                "phase": "ui_click_to_playing",
                "source_kind": "local",
                "trigger": "selection",
                "segments": {"click_to_playing_ms": ms},
            }
        )

    report = build_report(write(path, rows), days=7)

    assert report["buckets"]["local_selection [whole_file]"]["median_ms"] == 8000
    assert report["buckets"]["local_selection [bounded]"]["median_ms"] == 700


def test_a_regime_with_no_delivery_rows_is_unanswerable_not_perfect(tmp_path):
    """Rows written before `ui_play_delivery` existed cannot say whether the music
    kept playing, and reporting them as zero rebuffers would invent a result that
    happens to flatter the old regime."""
    path = tmp_path / "play-timing.jsonl"
    rows = [
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": "a",
            "track_id": "t1",
            "phase": "server_stream_ready",
            "source_kind": "local",
            "segments": {"open_ms": 0.2},
        },
    ]

    report = build_report(write(path, rows), days=7)

    assert report["stability"]["whole_file"]["plays"] == 0
    assert report["stability"]["whole_file"]["status"] == "not_instrumented"
    assert "rebuffered_share" not in report["stability"]["whole_file"]


def test_rebuffers_are_counted_per_hour_listened_not_per_play(tmp_path):
    """An hour that stops twice is worse than a short play that stops once."""
    path = tmp_path / "play-timing.jsonl"
    rows = [
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": "a",
            "track_id": "t1",
            "phase": "server_stream_ready",
            "source_kind": "local",
            "segments": {"open_ms": 0.2, "bounded": True},
        },
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": "a",
            "track_id": "t1",
            "phase": "ui_play_delivery",
            "source_kind": "local",
            "trigger": "selection",
            "segments": {
                "audible_ms": 1_800_000,  # half an hour
                "rebuffer_count": 3,
                "rebuffer_ms": 4200,
                "seek_rebuffer_count": 5,
            },
        },
    ]

    report = build_report(write(path, rows), days=7)
    stability = report["stability"]["bounded"]

    assert stability["plays"] == 1
    assert stability["rebuffered_share"] == 1.0
    assert stability["rebuffers_per_hour"] == 6.0
    # Seeks are reported but never folded into the rate: the listener asked for
    # those, and a day of heavy scrubbing must not read as a delivery regression.
    assert stability["seek_rebuffers"] == 5


def test_delivery_reports_which_requests_the_policy_never_reached(tmp_path):
    """The finding the first post-merge measurement had to be dug out by hand.

    A closed range for essentially the whole remaining file is a whole-file fetch
    with a different header, and the policy only narrows `bytes=N-`. Counting it
    is what turns "the change did not help" into "the change never ran here".
    """
    path = tmp_path / "play-timing.jsonl"
    rows = [
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": "",
            "track_id": "flac1",
            "phase": "server_stream_ready",
            "source_kind": "local",
            "segments": {
                "content_length": 4_000_000,
                "file_bytes": 40_000_000,
                "bounded": True,
                "range_kind": "open",
                "bound_outcome": "bounded",
                "range_span": 1.0,
                "format": "flac",
            },
        },
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": "",
            "track_id": "mp4a",
            "phase": "server_stream_ready",
            "source_kind": "local",
            "segments": {
                "content_length": 17_000_000,
                "file_bytes": 17_000_000,
                "bounded": False,
                "range_kind": "closed",
                "bound_outcome": "passthrough_closed",
                "range_span": 1.0,
                "format": "mp4",
            },
        },
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": "",
            "track_id": "mp4a",
            "phase": "server_stream_ready",
            "source_kind": "local",
            "segments": {
                "content_length": 49_161,
                "file_bytes": 17_000_000,
                "bounded": False,
                "range_kind": "closed",
                "bound_outcome": "passthrough_closed",
                "range_span": 0.003,
                "format": "mp4",
            },
        },
    ]

    report = build_report(write(path, rows), days=7)
    delivery = report["delivery"]["bounded"]

    assert delivery["coverage"] == round(1 / 3, 3)
    assert delivery["outcomes"] == {"passthrough_closed": 2, "bounded": 1}
    assert delivery["formats"]["mp4"]["bounded"] == 0
    assert delivery["formats"]["flac"]["bounded"] == 1
    # The `moov` hunt is a closed range too, and it is not the one to go after.
    assert delivery["passthrough_whole_remainder"]["requests"] == 1
    assert delivery["passthrough_whole_remainder"]["served_mb"] == round(17_000_000 / 1048576, 1)


def test_coverage_is_unanswerable_for_rows_that_predate_the_policy(tmp_path):
    """Scoring them 0% reads as "the policy reached nothing" rather than "the
    policy was not there yet"."""
    path = tmp_path / "play-timing.jsonl"
    rows = [
        {
            "v": 2,
            "ts": NOW,
            "attempt_id": "",
            "track_id": "t1",
            "phase": "server_stream_ready",
            "source_kind": "local",
            "segments": {"content_length": 40_000_000, "file_bytes": 40_000_000},
        },
    ]

    report = build_report(write(path, rows), days=7)

    assert report["delivery"]["whole_file"]["coverage"] is None
    assert report["delivery"]["whole_file"]["outcomes"] == {}
