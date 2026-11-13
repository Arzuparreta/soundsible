#!/usr/bin/env python3
"""Aggregates behind docs/dj/DIRECTION.md. Reads copies; prints no identities.

    .venv/bin/python docs/dj/direction_probe.py \
        --analysis ~/.cache/soundsible/dj/analysis.sqlite3 \
        --traces ~/.local/share/soundsible/users/<account>/telemetry/playback-traces.sqlite3
"""
from __future__ import annotations

import argparse
import bisect
from collections import Counter, defaultdict
import json
from pathlib import Path
import random
import sqlite3
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.dj import timing  # noqa: E402
from shared.dj.contracts import ANALYSER_VERSION  # noqa: E402
from shared.dj.transitions import plan_transition  # noqa: E402

HELD = {'bass_swap', 'filter_blend', 'long_blend'}
DEGRADED = {'mix.rate_fallback', 'mix.execution_fallback', 'mix.signal_fallback', 'mix.suspended'}


def read_only(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path.expanduser().resolve().as_uri() + '?mode=ro', uri=True)


def steady(analysis) -> bool:
    return (analysis.get('bpm') or 0) > 0 and (analysis.get('tempo_confidence') or 0) > timing.STEADY_PULSE


def straightness_ms(analysis, cue, span: float):
    """Largest distance from one straight line of the beats in [cue, cue + span]."""
    grid = analysis.get('beat_grid') or []
    if cue is None:
        return None
    points = grid[bisect.bisect_left(grid, cue - 0.01):bisect.bisect_right(grid, cue + span)]
    if len(points) < 16:
        return None
    steps = [right - left for left, right in zip(points, points[1:])]
    if max(steps) > 1.5 * statistics.median(steps):
        return None
    count = len(points)
    mean_n, mean_t = (count - 1) / 2, sum(points) / count
    slope = (sum((n - mean_n) * (t - mean_t) for n, t in enumerate(points))
             / sum((n - mean_n) ** 2 for n in range(count)))
    return max(abs(t - mean_t - slope * (n - mean_n)) for n, t in enumerate(points)) * 1000


def analysis_report(path: Path, pairs: int) -> dict:
    with read_only(path) as db:
        versions = dict(db.execute('SELECT analyser_version, COUNT(*) FROM audio_analysis GROUP BY 1'))
        rows = [json.loads(payload) for (payload,) in db.execute(
            'SELECT payload FROM audio_analysis WHERE analyser_version = ?', (ANALYSER_VERSION,))]
    rows = [row for row in rows if row.get('analysed')]
    regions = [region for row in rows for region in row.get('metric_regions') or []]
    even = [row for row in rows if steady(row)]
    uneven = [row for row in rows if not steady(row)]

    def techniques(population, seed):
        rng = random.Random(seed)
        found = Counter()
        for _ in range(pairs):
            outgoing, incoming = rng.sample(population, 2)
            plan = plan_transition(outgoing, incoming)
            found[f"{plan['technique']}/{plan['sync'].get('alignment')}"] += 1
        return dict(found.most_common())

    def straight(population, span):
        result = {}
        for side in ('intro_cue', 'outro_cue'):
            values = [value for row in population
                      if (value := straightness_ms(row, row.get(side) or (0 if side == 'intro_cue' else None), span)) is not None]
            result[side] = {'with_grid': len(values), 'within_5_ms': sum(value <= 5 for value in values),
                            'median_ms': round(statistics.median(values), 1) if values else None}
        return result

    with timing.split_rates(True):
        any_pair, steady_pair = techniques(rows, 0), techniques(even, 1)
    return {
        'rows_by_analyser_version': versions,
        'current_version': ANALYSER_VERSION,
        'current_analyses': len(rows),
        'steady_pulse': len(even),
        'regions': len(regions),
        'regions_with_confirmed_downbeat': sum((region.get('downbeat_confidence') or 0) > 0 for region in regions),
        'songs_with_confirmed_downbeat_region': sum(
            any((region.get('downbeat_confidence') or 0) > 0 for region in row.get('metric_regions') or []) for row in rows),
        'songs_with_song_level_downbeat_confidence': sum((row.get('downbeat_confidence') or 0) > 0 for row in rows),
        'songs_with_intro_section': sum(any(s.get('label') == 'intro' for s in row.get('sections') or []) for row in rows),
        'songs_with_outro_section': sum(any(s.get('label') == 'outro' for s in row.get('sections') or []) for row in rows),
        'random_pairs': pairs,
        'plans_for_random_pairs_split_clients': any_pair,
        'plans_for_random_steady_pairs_split_clients': steady_pair,
        'grid_straightness_16_s': {'steady': straight(even, 16), 'not_steady': straight(uneven, 16)},
    }


def trace_report(path: Path) -> dict:
    edges, attempts, platform = {}, defaultdict(list), {}
    with read_only(path) as db:
        for (payload,) in db.execute('SELECT payload FROM batches ORDER BY received, id'):
            if 'dj.' not in payload and 'mix.' not in payload:
                continue
            batch = json.loads(payload)
            for row in batch['events']:
                facts = row.get('facts') or {}
                if row['event'] == 'dj.committed':
                    edges[(facts.get('djSession'), facts.get('edgeId'))] = facts
                if attempt := facts.get('transitionId'):
                    attempts[attempt].append(row)
                    platform[attempt] = str(batch['capture'].get('platform'))
    automatic = [facts for facts in edges.values() if facts.get('mixing') is True and facts.get('manual') is not True]
    measured = [facts for facts in automatic if facts.get('fromAnalysed') and facts.get('toAnalysed')]
    execution, reasons = Counter(), Counter()
    for attempt, rows in attempts.items():
        commit = next((row for row in rows if row['event'] == 'dj.committed'), None)
        if not commit or commit['facts'].get('requestedTechnique') not in HELD:
            continue
        if not any(row['event'] == 'dj.outcome' and row['facts'].get('outcome') == 'completed' for row in rows):
            continue
        started = next((row for row in rows if row['event'] == 'mix.started'), None)
        failures = [row for row in rows if row['event'] in DEGRADED]
        held = bool(started and started['facts'].get('technique') in HELD and not failures)
        execution[f"{platform[attempt]}/{'held' if held else 'degraded'}"] += 1
        for name in {f"{row['event']}:{row['facts'].get('reason')}" for row in failures}:
            reasons[f'{platform[attempt]}/{name}'] += 1
    return {
        'committed_edges': len(edges),
        'automatic_mixed_edges': len(automatic),
        'both_analysed_at_commit': len(measured),
        'technique_at_commit': dict(Counter(facts.get('requestedTechnique') for facts in measured).most_common()),
        'alignment_at_commit': dict(Counter(facts.get('alignment') for facts in measured).most_common()),
        'completed_beatmatch_plans_by_platform': dict(execution),
        'degradation_reasons_by_platform': dict(reasons.most_common()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analysis', type=Path)
    parser.add_argument('--traces', type=Path)
    parser.add_argument('--pairs', type=int, default=6000)
    args = parser.parse_args()
    report = {}
    if args.analysis:
        report['analysis_cache'] = analysis_report(args.analysis, args.pairs)
    if args.traces:
        report['web_traces'] = trace_report(args.traces)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
