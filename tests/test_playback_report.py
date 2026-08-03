import json

from scripts.playback_report import build_report


def test_report_joins_server_egress_and_excludes_legacy_rows(tmp_path):
    path = tmp_path / "play-timing.jsonl"
    rows = [
        {
            "v": 1,
            "event": "play_timing",
            "ts": 9_999_999_999,
            "segments": {"click_to_playing_ms": 1},
        },
        {
            "v": 2,
            "event": "play_timing",
            "ts": 9_999_999_999,
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
            "ts": 9_999_999_999,
            "attempt_id": "a",
            "phase": "ui_click_to_playing",
            "source_kind": "preview",
            "cache_state": "unknown",
            "egress": "unknown",
            "segments": {"click_to_playing_ms": 900, "stall_count": 1},
        },
    ]
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")

    report = build_report(path, days=7)

    assert report["samples"] == 1
    bucket = report["buckets"]["preview_relay_url_warm"]
    assert bucket["p95_ms"] == 900
    assert bucket["stalls"] == 1
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
            "ts": 9_999_999_999,
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
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")

    report = build_report(path, days=7)

    assert report["buckets"]["local_selection"]["median_ms"] == 1400
    assert report["buckets"]["local_ended"]["median_ms"] == 20
    # An unrecognised trigger still lands somewhere rather than being dropped.
    assert report["buckets"]["local"]["median_ms"] == 500
