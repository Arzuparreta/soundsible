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
