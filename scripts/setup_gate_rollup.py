#!/usr/bin/env python3
"""
Read-only Phase 1 setup funnel rollups from local JSONL (see docs/LAYER_CONTRACTS.md §5 #2).

Does not connect to the network. Defaults to ``<data_dir>/telemetry/setup-events.jsonl``.
Optional ``--since`` / ``--until`` filter on event ``ts`` (Unix seconds).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


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


def parse_ts_bound(raw: str, *, end: bool = False) -> int:
    """Parse CLI bound: Unix seconds (digits) or ISO date ``YYYY-MM-DD`` / datetime."""
    text = raw.strip()
    if text.isdigit():
        return int(text)
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        dt = datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if end:
            dt = dt.replace(hour=23, minute=59, second=59)
        return int(dt.timestamp())
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def filter_events_by_ts(
    events: list[dict[str, Any]],
    *,
    since_ts: Optional[int] = None,
    until_ts: Optional[int] = None,
) -> list[dict[str, Any]]:
    if since_ts is None and until_ts is None:
        return events
    kept: list[dict[str, Any]] = []
    for row in events:
        ts = row.get("ts")
        if not isinstance(ts, (int, float)):
            continue
        t = int(ts)
        if since_ts is not None and t < since_ts:
            continue
        if until_ts is not None and t > until_ts:
            continue
        kept.append(row)
    return kept


def _median_ms(values: list[float]) -> Optional[int]:
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2:
        return int(ordered[mid])
    return int((ordered[mid - 1] + ordered[mid]) / 2)


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
    started_n = len(sessions_started)
    within = sum(
        1
        for sid in sessions_started
        if sid in sessions_first_play
        and isinstance(sessions_first_play[sid].get("elapsed_ms_since_session"), (int, float))
        and sessions_first_play[sid]["elapsed_ms_since_session"] <= ten_min_ms
    )
    rate = (within / started_n) if started_n else 0.0

    elapsed_ms = [
        float(row["elapsed_ms_since_session"])
        for row in sessions_first_play.values()
        if isinstance(row.get("elapsed_ms_since_session"), (int, float))
    ]

    out: dict[str, Any] = {
        "counts_by_event": dict(sorted(by_event.items())),
        "sessions_with_setup_session_started": started_n,
        "sessions_first_play_within_10min": within,
        "success_rate_vs_started_sessions": round(rate, 4),
        "sessions_first_play_total_logged": len(sessions_first_play),
        "note": "Correlate setup_session_started with client-driven /api/setup/session; "
        "first play should include matching setup_session_id on POST /api/playback/play.",
    }
    median = _median_ms(elapsed_ms)
    if median is not None:
        out["median_elapsed_ms_first_play"] = median
    return out


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
    p.add_argument(
        "--since",
        metavar="TS",
        help="Include events with ts on or after this bound (Unix seconds or YYYY-MM-DD)",
    )
    p.add_argument(
        "--until",
        metavar="TS",
        help="Include events with ts on or before this bound (Unix seconds or YYYY-MM-DD)",
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

    since_ts = parse_ts_bound(args.since, end=False) if args.since else None
    until_ts = parse_ts_bound(args.until, end=True) if args.until else None
    if since_ts is not None and until_ts is not None and since_ts > until_ts:
        print("--since must be on or before --until", file=sys.stderr)
        return 2

    events = filter_events_by_ts(_iter_events(path), since_ts=since_ts, until_ts=until_ts)
    out = summarize(events)
    if since_ts is not None:
        out["filter_since_ts"] = since_ts
    if until_ts is not None:
        out["filter_until_ts"] = until_ts
    out["events_in_window"] = len(events)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
