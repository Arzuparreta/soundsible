"""Compare shuffled and continuous routes on a read-only analysis cache.

python -I docs/dj/route_probe.py --cache ~/.cache/soundsible/dj/analysis.sqlite3
No provider requests, audio decoding, playback or writes to the station cache.
The output contains aggregate measurements, never track identities.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import sqlite3
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.dj_engine import ANALYSER_VERSION, order_continuous_route, plan_transition


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--samples", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("samples must be positive")
    with sqlite3.connect(args.cache.resolve().as_uri() + "?mode=ro", uri=True) as database:
        rows = database.execute(
            "SELECT payload FROM audio_analysis WHERE analyser_version = ? ORDER BY identity",
            (ANALYSER_VERSION,),
        ).fetchall()
    analyses = [analysis for row in rows if (analysis := json.loads(row[0])).get("analysed")]
    if len(analyses) < 3:
        parser.error("at least three current analyses are required")
    rng = random.Random(args.seed)
    totals = {label: {"score": [], "fallback": [], "cpu_ms": [], **{
        name: [] for name in ("note_rate", "loudness_lufs", "spectral_flatness", "pulse_bpm")
    }} for label in ("shuffle", "continuity")}
    for _ in range(args.samples):
        seed, *features = rng.sample(analyses, min(9, len(analyses)))
        pool = [({"id": str(index)}, analysis) for index, analysis in enumerate(features)]
        for label, metrics in totals.items():
            started = time.process_time()
            if label == "shuffle":
                previous = seed
                route = []
                for item, analysis in pool:
                    route.append({**item, "analysis": analysis, "transition": plan_transition(previous, analysis)})
                    previous = analysis
            else:
                route = order_continuous_route(seed, pool)
            metrics["cpu_ms"].append((time.process_time() - started) * 1000)
            previous = seed
            for row in route:
                incoming = row["analysis"]
                metrics["score"].append(row["transition"]["score"])
                metrics["fallback"].append(row["transition"]["fallback"])
                for name in ("note_rate", "loudness_lufs", "spectral_flatness"):
                    if previous.get(name) is not None and incoming.get(name) is not None:
                        metrics[name].append(abs(previous[name] - incoming[name]))
                out_bpm, in_bpm = previous.get("bpm", 0), incoming.get("bpm", 0)
                if out_bpm > 0 and in_bpm > 0:
                    pulse = in_bpm * 2 ** round(math.log2(out_bpm / in_bpm))
                    metrics["pulse_bpm"].append(abs(pulse - out_bpm))
                previous = incoming
    print(json.dumps({
        "analyses": len(analyses), "analyser_version": ANALYSER_VERSION,
        "payload_sha256": hashlib.sha256(json.dumps(analyses, sort_keys=True).encode()).hexdigest(),
        "samples": args.samples, "seed": args.seed, "route_length": min(8, len(analyses) - 1),
        "means": {label: {name: round(statistics.mean(values), 6) if values else None
                          for name, values in metrics.items()} for label, metrics in totals.items()},
    }, indent=2))


if __name__ == "__main__":
    main()
