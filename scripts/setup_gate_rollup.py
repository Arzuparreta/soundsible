#!/usr/bin/env python3
"""
Read-only Phase 1 setup funnel rollups from local JSONL (see docs/LAYER_CONTRACTS.md §5 #2).

Does not connect to the network. Defaults to ``<data_dir>/telemetry/setup-events.jsonl``.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def _iter_events(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def summarize(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_event: dict[str, int] = defaultdict(int)
    sessions_started: set[str] = set()
    sessions_first_play: dict[str, dict[str, Any]] = {}

    for row in events:
        ev = row.get("event")
        if not isinstance(ev, str):
            continue
        by_event[ev] += 1
        sid = row.get("setup_session_id")
        if ev == "setup_session_started" and isinstance(sid, str) and sid:
            sessions_started.add(sid)
        if ev == "setup_first_play" and isinstance(sid, str) and sid:
            sessions_first_play[sid] = row

    ten_min_ms = 10 * 60 * 1000
    on_time = 0
    for sid, row in sessions_first_play.items():
        elapsed = row.get("elapsed_ms_since_session")
        if isinstance(elapsed, (int, float)) and elapsed <= ten_min_ms:
            on_time += 1

    started_n = len(sessions_started)
    # Success: sessions that recorded first play within cutoff among those that started
    reached = len(set(sessions_first_play) & sessions_started) if started_n else len(sessions_first_play)
    within = sum(
        1
        for sid in sessions_started
        if sid in sessions_first_play
        and isinstance(sessions_first_play[sid].get("elapsed_ms_since_session"), (int, float))
        and sessions_first_play[sid]["elapsed_ms_since_session"] <= ten_min_ms
    )
    rate = (within / started_n) if started_n else 0.0
    return {
        "counts_by_event": dict(sorted(by_event.items())),
        "sessions_with_setup_session_started": started_n,
        "sessions_first_play_within_10min": within,
        "success_rate_vs_started_sessions": round(rate, 4),
        "sessions_first_play_total_logged": len(sessions_first_play),
        "note": "Correlate setup_session_started with client-driven /api/setup/session; "
        "first play should include matching setup_session_id on POST /api/playback/play.",
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Roll up setup-events.jsonl for Phase 1 gate estimates.")
    p.add_argument(
        "--setup-events",
        type=Path,
        help="Path to setup-events.jsonl (default: <data-dir>/telemetry/setup-events.jsonl)",
    )
    p.add_argument(
        "--data-dir",
        type=Path,
        help="Runtime data directory containing telemetry/ (overrides env)",
    )
    args = p.parse_args(argv)

    path = args.setup_events
    if path is None:
        import os

        data_dir = args.data_dir
        if data_dir is None:
            raw = os.environ.get("SOUNDSIBLE_DATA_DIR") or ""
            data_dir = Path(raw).expanduser() if raw.strip() else None
        if data_dir is None:
            print(
                "Provide --setup-events or --data-dir or set SOUNDSIBLE_DATA_DIR",
                file=sys.stderr,
            )
            return 2
        path = Path(data_dir).expanduser() / "telemetry" / "setup-events.jsonl"

    events = _iter_events(path)
    out = summarize(events)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
