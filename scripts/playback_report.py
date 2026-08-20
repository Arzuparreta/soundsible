#!/usr/bin/env python3
"""Local playback SLO report for version-2 telemetry.

Three questions, kept apart because they have different answers:

* **How long until sound.** `click_to_playing_ms`, split by what triggered the
  play *and* by which delivery regime served it. The regime split is the point:
  without it the before and after of a delivery change average into one number
  that moves for neither reason.
* **Whether the music then kept playing.** Read from `ui_play_delivery`, which is
  emitted once per audible play rather than at its start. The old `stall_count`
  on `ui_click_to_playing` could not answer this — it was emitted at the instant
  of first sound, so the only spell it could contain was the opening buffer, and
  it read 1 on 56 of 58 plays before the chunk change and 8 of 9 after. Rows that
  predate the split are reported as unanswerable rather than as zero.
* **What the delivery cost.** Bytes promised against bytes that exist, plus which
  requests the bounding policy actually reached. A request that never reaches it
  keeps the old failure shape, and that is a different finding from one that was
  reshaped and still went badly.
"""

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


#: A closed range asking for this much of what is left of the file is a whole-file
#: request spelled differently. Retained solely for historical rows emitted by
#: the removed range-rewriting policy.
WHOLE_FILE_SPAN_RATIO = 0.95


def _delivery(rows: list[dict]) -> dict:
    """How many requests and how many bytes one track costs to listen to.

    The headline is `amplification`: bytes promised divided by the size of the
    files they came from. A whole-file response that keeps dying and being
    restarted pushes this well above 1.0 — it was 1.55x when this was measured —
    and driving it back to 1.0 is the point of the change. `requests_per_track`
    is expected to go *up*, since a chunk walk is many small requests by design.

    `coverage` is the share of requests the bounding policy actually reached. It
    is reported next to the amplification because the two are read together: an
    amplification that did not improve means something different when most of the
    traffic never reached the policy at all, and the first measurement after the
    change was exactly that case — 69 of 95 requests passed straight through.
    """
    served = 0
    file_bytes: dict[str, int] = {}
    requests: dict[str, int] = defaultdict(int)
    outcomes: dict[str, int] = defaultdict(int)
    formats: dict[str, dict[str, int]] = defaultdict(lambda: {"requests": 0, "bounded": 0, "served": 0})
    bounded_requests = 0
    reshapable = 0
    instrumented = 0
    whole_remainder = {"requests": 0, "served": 0}
    for row in rows:
        segments = row.get("segments") or {}
        track = str(row.get("track_id") or "")
        length = int(segments.get("content_length") or 0)
        served += length
        requests[track] += 1
        size = int(segments.get("file_bytes") or 0)
        if size:
            file_bytes[track] = size
        # Only rows that could have been reshaped count towards coverage. A row
        # written before the policy existed carries no `bounded` key, and scoring
        # it as 0% reads as "the policy reached nothing" rather than "the policy
        # was not there yet" — two different statements about the same log.
        if "bounded" in segments:
            reshapable += 1
            if segments.get("bounded"):
                bounded_requests += 1
        outcome = segments.get("bound_outcome")
        if outcome:
            instrumented += 1
            outcomes[str(outcome)] += 1
        fmt = formats[str(segments.get("format") or "unknown")]
        fmt["requests"] += 1
        fmt["served"] += length
        if segments.get("bounded"):
            fmt["bounded"] += 1
        span = segments.get("range_span")
        # A request for essentially all of what is left, whichever header spelled
        # it. This is the traffic a policy that only narrows `bytes=N-` cannot see.
        if isinstance(span, (int, float)) and span >= WHOLE_FILE_SPAN_RATIO and not segments.get("bounded"):
            whole_remainder["requests"] += 1
            whole_remainder["served"] += length
    library_bytes = sum(file_bytes.values())
    counts = list(requests.values())
    return {
        "requests": len(rows),
        "tracks": len(requests),
        "served_mb": round(served / 1048576, 1),
        "amplification": round(served / library_bytes, 2) if library_bytes else None,
        "requests_per_track_p50": _percentile([float(c) for c in counts], 0.5),
        "requests_per_track_p90": _percentile([float(c) for c in counts], 0.9),
        "coverage": round(bounded_requests / reshapable, 3) if reshapable else None,
        # Absent on rows written before the outcome was recorded, in which case
        # the breakdown below is empty rather than misleadingly uniform.
        "outcomes": dict(sorted(outcomes.items(), key=lambda item: -item[1])) if instrumented else {},
        "formats": {
            name: {
                "requests": value["requests"],
                "bounded": value["bounded"],
                "served_mb": round(value["served"] / 1048576, 1),
            }
            for name, value in sorted(formats.items(), key=lambda item: -item[1]["requests"])
        },
        "passthrough_whole_remainder": {
            "requests": whole_remainder["requests"],
            "served_mb": round(whole_remainder["served"] / 1048576, 1),
        },
    }


def _stability(plays: list[dict]) -> dict:
    """Whether playback that started then kept going.

    Every field here comes from `ui_play_delivery`. A regime with no such rows is
    reported as `not_instrumented`, not as zero: those plays were never measured
    for this and saying they never rebuffered would be inventing a result.
    """
    if not plays:
        return {"plays": 0, "status": "not_instrumented"}
    counts = [int((p.get("segments") or {}).get("rebuffer_count") or 0) for p in plays]
    durations = [float((p.get("segments") or {}).get("rebuffer_ms") or 0) for p in plays]
    seeks = sum(int((p.get("segments") or {}).get("seek_rebuffer_count") or 0) for p in plays)
    audible = [float((p.get("segments") or {}).get("audible_ms") or 0) for p in plays]
    rebuffered = sum(1 for c in counts if c)
    minutes = sum(audible) / 60000
    return {
        "plays": len(plays),
        "status": "measured" if len(plays) >= 50 else "insufficient_data",
        "rebuffered_share": round(rebuffered / len(plays), 3),
        # The rate a delivery change actually moves: an hour of listening that
        # stops twice is worse than a short play that stops once, and a share of
        # plays cannot tell them apart.
        "rebuffers_per_hour": round(sum(counts) / (minutes / 60), 2) if minutes else None,
        "rebuffer_ms_p50": round(_percentile(durations, 0.5), 1),
        "rebuffer_ms_p90": round(_percentile(durations, 0.90), 1),
        "rebuffer_ms_p99": round(_percentile(durations, 0.99), 1),
        "audible_minutes": round(minutes, 1),
        # Kept out of the numbers above: audio stopping because the listener
        # dragged the scrubber is them getting what they asked for.
        "seek_rebuffers": seeks,
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
    fails: list[dict] = []
    deliveries: list[dict] = []
    stability: dict[str, list[dict]] = defaultdict(list)
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
            elif phase == "ui_play_delivery":
                deliveries.append(row)
            elif phase == "ui_attempt_failed":
                fails.append(row)

    def regime_of(client_row: dict) -> str:
        upstream = server.get(str(client_row.get("attempt_id") or "")) or _nearest(by_track, client_row)
        return _regime(upstream) if upstream else "unjoined"

    # Keyed the same way the successes are, or a failure invents a bucket of its
    # own with no samples in it and the two never appear on the same row.
    for row in fails:
        failures[f"{_bucket(row)} [{regime_of(row)}]"] += 1

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
        # The regime rides in the bucket name rather than in a field, so the two
        # halves of a comparison print as adjacent rows and cannot be read as one
        # population by accident.
        regime = _regime(upstream) if upstream else "unjoined"
        samples[f"{_bucket(joined)} [{regime}]"].append(float(value))
        total += 1

    for row in deliveries:
        stability[regime_of(row)].append(row)

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
        }
    regimes = sorted(set(delivery) | set(stability) | {"whole_file", "bounded"})
    return {
        "schema": 3,
        "window_days": days,
        "samples": total,
        "buckets": buckets,
        "delivery": {regime: _delivery(rows) for regime, rows in sorted(delivery.items())},
        "stability": {regime: _stability(stability.get(regime, [])) for regime in regimes},
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
    print("\nTime to first sound, by trigger and delivery regime")
    for name, values in report["buckets"].items():
        print(
            f"{name:40} n={values['samples']:4} "
            f"p50={values['median_ms']!s:>7}ms p90={values['p90_ms']!s:>7}ms "
            f"p99={values['p99_ms']!s:>8}ms "
            f"fail={values['failures']:3} {values['status']}"
        )

    print("\nDid it keep playing — rebuffers after the sound started")
    for regime, values in report["stability"].items():
        if not values["plays"]:
            print(f"{regime:28} no ui_play_delivery rows — {values['status']}, not comparable")
            continue
        print(
            f"{regime:28} plays={values['plays']:5} "
            f"rebuffered={values['rebuffered_share']:.0%} "
            f"per_hour={values['rebuffers_per_hour']!s:>6} "
            f"p90={values['rebuffer_ms_p90']:8.0f}ms p99={values['rebuffer_ms_p99']:8.0f}ms "
            f"({values['audible_minutes']:.0f} min listened, {values['seek_rebuffers']} seek-induced) "
            f"{values['status']}"
        )

    if report["delivery"]:
        print("\nDelivery of local files — whole_file is the standard HTTP range regime")
        for regime, values in report["delivery"].items():
            coverage = "-" if values["coverage"] is None else f"{values['coverage']:.0%}"
            print(
                f"{regime:28} req={values['requests']:5} tracks={values['tracks']:4} "
                f"served={values['served_mb']:9.1f}MB "
                f"amplification={values['amplification']!s:>5}x "
                f"req/track p50={values['requests_per_track_p50']:.0f} "
                f"p90={values['requests_per_track_p90']:.0f} "
                f"reached_by_policy={coverage}"
            )
            if values["outcomes"]:
                for outcome, count in values["outcomes"].items():
                    print(f"{'':30}  {count:5} {outcome}")
            whole = values["passthrough_whole_remainder"]
            if whole["requests"]:
                print(
                    f"{'':30}  of which {whole['requests']} asked for essentially the whole "
                    f"remaining file and were not reshaped — {whole['served_mb']:.1f} MB"
                )
            for fmt, counts in values["formats"].items():
                if fmt == "unknown" and len(values["formats"]) == 1:
                    continue
                print(
                    f"{'':30}  {fmt:8} req={counts['requests']:5} "
                    f"bounded={counts['bounded']:5} served={counts['served_mb']:9.1f}MB"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
