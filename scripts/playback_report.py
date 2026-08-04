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


#: How far apart a server row and the client row for the same track may be and
#: still describe one play. Generous: the client stamps when the sound started,
#: the server when it opened the file, and a slow start is the whole point.
JOIN_WINDOW_SEC = 60


def _nearest(by_track: dict[str, list[dict]], client_row: dict) -> dict | None:
    """The server row most likely to describe this client row's play."""
    candidates = by_track.get(str(client_row.get("track_id") or ""))
    if not candidates:
        return None
    when = float(client_row.get("ts") or 0)
    best = min(candidates, key=lambda row: abs(float(row.get("ts") or 0) - when))
    return best if abs(float(best.get("ts") or 0) - when) <= JOIN_WINDOW_SEC else None


#: Server rows written before bounded ranges existed carry no `bounded` key at
#: all, and that absence is the regime marker. It means the before/after can be
#: read out of one log the station was already keeping, with no experiment flag
#: to set and nothing to correlate by hand.
def _regime(row: dict) -> str:
    return "bounded" if "bounded" in (row.get("segments") or {}) else "whole_file"


def _delivery(rows: list[dict]) -> dict:
    """How many requests and how many bytes one track costs to listen to.

    The headline is `amplification`: bytes promised divided by the size of the
    files they came from. A whole-file response that keeps dying and being
    restarted pushes this well above 1.0 — it was 3.6x when this was measured —
    and driving it back to 1.0 is the point of the change. `requests_per_track`
    is expected to go *up*, since a chunk walk is many small requests by design.
    """
    served = 0
    file_bytes: dict[str, int] = {}
    requests: dict[str, int] = defaultdict(int)
    for row in rows:
        segments = row.get("segments") or {}
        track = str(row.get("track_id") or "")
        served += int(segments.get("content_length") or 0)
        requests[track] += 1
        size = int(segments.get("file_bytes") or 0)
        if size:
            file_bytes[track] = size
    library_bytes = sum(file_bytes.values())
    counts = list(requests.values())
    return {
        "requests": len(rows),
        "tracks": len(requests),
        "served_mb": round(served / 1048576, 1),
        "amplification": round(served / library_bytes, 2) if library_bytes else None,
        "requests_per_track_p50": _percentile([float(c) for c in counts], 0.5),
        "requests_per_track_p90": _percentile([float(c) for c in counts], 0.9),
    }


def build_report(path: Path, *, days: int) -> dict:
    cutoff = time.time() - days * 86400
    starts: dict[str, dict] = {}
    server: dict[str, dict] = {}
    #: Local server rows kept whole, by regime, for the delivery section.
    delivery: dict[str, list[dict]] = defaultdict(list)
    #: Server rows with no attempt id, by track. The stream URL no longer
    #: carries one — that made every play a fresh cache key — so these are
    #: matched on the track and the clock instead.
    by_track: dict[str, list[dict]] = defaultdict(list)
    samples: dict[str, list[float]] = defaultdict(list)
    failures: dict[str, int] = defaultdict(int)
    stalls: dict[str, int] = defaultdict(int)
    stalled_plays: dict[str, int] = defaultdict(int)
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
                if row.get("source_kind") == "local":
                    delivery[_regime(row)].append(row)
                if attempt_id:
                    server[attempt_id] = row
                else:
                    by_track[str(row.get("track_id") or "")].append(row)
            elif phase == "ui_click_to_playing":
                starts[attempt_id] = row
            elif phase == "ui_attempt_failed":
                failures[_bucket(row)] += 1

    for attempt_id, row in starts.items():
        joined = {**row}
        upstream = server.get(attempt_id) or _nearest(by_track, row)
        if upstream:
            for key in ("cache_state", "egress"):
                if upstream.get(key):
                    joined[key] = upstream[key]
        value = (row.get("segments") or {}).get("click_to_playing_ms")
        if not isinstance(value, (int, float)) or not 0 <= value <= 300_000:
            continue
        bucket = _bucket(joined)
        samples[bucket].append(float(value))
        stalled = int((row.get("segments") or {}).get("stall_count") or 0)
        stalls[bucket] += stalled
        if stalled:
            stalled_plays[bucket] += 1
        total += 1

    buckets = {}
    for name in sorted(set(samples) | set(failures)):
        values = samples.get(name, [])
        buckets[name] = {
            "samples": len(values),
            "status": "measured" if len(values) >= 50 else "insufficient_data",
            "median_ms": round(statistics.median(values), 1) if values else None,
            # p90 and p99 sit either side of p95 on purpose: a stall shows up in
            # the far tail long before it moves the middle, and the tail is what
            # a listener calls "it doesn't start".
            "p90_ms": round(_percentile(values, 0.90), 1) if values else None,
            "p95_ms": round(_percentile(values, 0.95), 1) if values else None,
            "p99_ms": round(_percentile(values, 0.99), 1) if values else None,
            "failures": failures.get(name, 0),
            "stalls": stalls.get(name, 0),
            # The share of plays that stalled at all, which is the number worth
            # watching: a raw count says nothing without knowing how many plays
            # it is spread across.
            "stall_rate": round(stalled_plays.get(name, 0) / len(values), 3) if values else None,
        }
    return {
        "schema": 2,
        "window_days": days,
        "samples": total,
        "buckets": buckets,
        "delivery": {regime: _delivery(rows) for regime, rows in sorted(delivery.items())},
    }


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
        rate = values["stall_rate"]
        print(
            f"{name:28} n={values['samples']:4} "
            f"p50={values['median_ms']!s:>7}ms p90={values['p90_ms']!s:>7}ms "
            f"p99={values['p99_ms']!s:>8}ms "
            f"fail={values['failures']:3} stalled={('-' if rate is None else f'{rate:.0%}'):>4} "
            f"{values['status']}"
        )
    if report["delivery"]:
        print("\nDelivery of local files — whole_file is the regime before bounded ranges")
        for regime, values in report["delivery"].items():
            print(
                f"{regime:28} req={values['requests']:5} tracks={values['tracks']:4} "
                f"served={values['served_mb']:9.1f}MB "
                f"amplification={values['amplification']!s:>5}x "
                f"req/track p50={values['requests_per_track_p50']:.0f} "
                f"p90={values['requests_per_track_p90']:.0f}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
