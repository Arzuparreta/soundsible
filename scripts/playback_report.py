#!/usr/bin/env python3
"""Local playback SLO report for version-2 telemetry."""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import statistics
import time


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return ordered[index]


#: Triggers worth keeping apart from each other in the `local` bucket. A click
#: has to reach the disk from cold; a track boundary is handed over from a deck
#: that has been holding the stream for minutes. Averaging the two hides exactly
#: the regression a listener notices, which is the click.
LOCAL_TRIGGERS = {"selection", "next", "ended", "retry", "resume", "recovery"}


def _bucket(row: dict) -> str:
    source = str(row.get("source_kind") or "unknown")
    cache = str(row.get("cache_state") or "unknown")
    egress = str(row.get("egress") or "unknown")
    if source == "local":
        trigger = str(row.get("trigger") or "")
        return f"local_{trigger}" if trigger in LOCAL_TRIGGERS else "local"
    if source == "podcast":
        return "podcast"
    if cache == "disk":
        return "preview_disk"
    return f"preview_{egress}_{cache}"


def build_report(path: Path, *, days: int) -> dict:
    cutoff = time.time() - days * 86400
    starts: dict[str, dict] = {}
    server: dict[str, dict] = {}
    samples: dict[str, list[float]] = defaultdict(list)
    failures: dict[str, int] = defaultdict(int)
    stalls: dict[str, int] = defaultdict(int)
    total = 0

    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if row.get("v") != 2 or float(row.get("ts") or 0) < cutoff:
                continue
            attempt_id = row.get("attempt_id")
            if not isinstance(attempt_id, str):
                continue
            phase = row.get("phase")
            if phase == "server_stream_ready":
                server[attempt_id] = row
            elif phase == "ui_click_to_playing":
                starts[attempt_id] = row
            elif phase == "ui_attempt_failed":
                failures[_bucket(row)] += 1

    for attempt_id, row in starts.items():
        joined = {**row}
        upstream = server.get(attempt_id)
        if upstream:
            for key in ("cache_state", "egress"):
                if upstream.get(key):
                    joined[key] = upstream[key]
        value = (row.get("segments") or {}).get("click_to_playing_ms")
        if not isinstance(value, (int, float)) or not 0 <= value <= 300_000:
            continue
        bucket = _bucket(joined)
        samples[bucket].append(float(value))
        stalls[bucket] += int((row.get("segments") or {}).get("stall_count") or 0)
        total += 1

    buckets = {}
    for name in sorted(set(samples) | set(failures)):
        values = samples.get(name, [])
        buckets[name] = {
            "samples": len(values),
            "status": "measured" if len(values) >= 50 else "insufficient_data",
            "median_ms": round(statistics.median(values), 1) if values else None,
            "p95_ms": round(_percentile(values, 0.95), 1) if values else None,
            "failures": failures.get(name, 0),
            "stalls": stalls.get(name, 0),
        }
    return {"schema": 2, "window_days": days, "samples": total, "buckets": buckets}


def main() -> int:
    parser = argparse.ArgumentParser(description="Report local Soundsible playback SLOs.")
    parser.add_argument("path", type=Path, help="Path to play-timing.jsonl")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = build_report(args.path, days=max(1, args.days))
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    print(f"Playback v2 — {report['window_days']}d — {report['samples']} valid starts")
    for name, values in report["buckets"].items():
        print(
            f"{name:28} n={values['samples']:4} "
            f"p50={values['median_ms']!s:>7}ms p95={values['p95_ms']!s:>7}ms "
            f"fail={values['failures']:3} stalls={values['stalls']:3} {values['status']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
