"""Measure session progress from frozen local evidence, without changing playback.

Inputs stay private. Output has aggregates and numbered sessions, no song,
account, device or session identities. See SESSION_PROGRESS.md for definitions.
Run with the repository Python environment; no decoding or provider requests.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import random
import re
import sqlite3
from statistics import mean
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.dj.contracts import ANALYSER_VERSION, fallback_analysis
from shared.dj.transitions import plan_transition


def average(values):
    values = [value for value in values if value is not None]
    return round(mean(values), 6) if values else None


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def paired_summary(rows, metrics):
    """Each session contributes equally; no pooling of unrelated early/late songs."""
    result = {}
    for metric in metrics:
        pairs = [(row['early'].get(metric), row['late'].get(metric)) for row in rows]
        pairs = [(a, b) for a, b in pairs if a is not None and b is not None]
        result[metric] = {
            'sessions': len(pairs), 'early_mean': average(a for a, _ in pairs),
            'late_mean': average(b for _, b in pairs),
            'late_minus_early': average(b - a for a, b in pairs),
            'increased': sum(b > a + 1e-9 for a, b in pairs),
            'decreased': sum(b < a - 1e-9 for a, b in pairs),
        }
    return result


def plan_report(path, zone, since):
    sessions = defaultdict(list)
    for line in path.read_text().splitlines():
        if 'dj-plan session=' not in line:
            continue
        stamp = datetime.strptime(line[:23], '%Y-%m-%d %H:%M:%S,%f').replace(tzinfo=ZoneInfo(zone))
        if stamp.timestamp() < since:
            continue
        fields = dict(re.findall(r'(\w+)=([^\s]+)', line))
        if fields.get('session') in {None, '-'} or 'analysis_cohort_ready' not in fields:
            continue
        fields['time'] = stamp.timestamp()
        sessions[fields['session']].append(fields)
    paired = []
    for rows in sessions.values():
        # Retries at one segment are not independent refills. Retain the first
        # nonempty response per segment, and require an observed opening.
        segments = {}
        for row in sorted(rows, key=lambda item: item['time']):
            if int(row['route']) > 0:
                segments.setdefault(int(row['segment']), row)
        if 0 not in segments or len(segments) < 2:
            continue
        first, last = segments[0], segments[max(segments)]

        def metrics(row):
            size = int(row['analysis_cohort'])
            return {'cohort_ready_fraction': int(row['analysis_cohort_ready']) / size if size else None,
                    'candidates': int(row['analysis_candidates']),
                    'cohort_ready': int(row['analysis_cohort_ready']),
                    'related_cache_hit_fraction': int(row['cache_hit']) / max(1, int(row['cache_hit']) + int(row['cache_miss']))}

        paired.append({'session': len(paired) + 1,
                       'opening_timestamp': first['time'],
                       'opening_local': datetime.fromtimestamp(first['time'], ZoneInfo(zone)).isoformat(),
                       'segments_observed': sorted(segments),
                       'minutes_between_plans': round((last['time'] - first['time']) / 60, 3),
                       'sources_first_last': [int(first['sources']), int(last['sources'])],
                       'early': metrics(first), 'late': metrics(last)})
    return {'logged_sessions': len(sessions), 'paired_sessions': paired,
            'paired_summary': paired_summary(paired, ['cohort_ready_fraction', 'candidates',
                                                       'cohort_ready', 'related_cache_hit_fraction'])}


def read_timing(paths, since):
    attempts = {}
    for path in paths:
        opener = gzip.open if path.suffix == '.gz' else open
        with opener(path, 'rt') as stream:
            for line in stream:
                row = json.loads(line)
                if row.get('phase') != 'ui_play_delivery' or row.get('ts', 0) < since:
                    continue
                if not row.get('attempt_id') or not row.get('device_id'):
                    continue
                # Reuploads of the same attempt must not create extra songs.
                key = (row['device_id'], row['attempt_id'])
                if key not in attempts or row['ts'] > attempts[key]['ts']:
                    attempts[key] = row
    return list(attempts.values())


def delivery_runs(rows, max_gap=5):
    devices = defaultdict(list)
    for row in rows:
        elapsed = row.get('segments', {}).get('audible_ms')
        if not isinstance(elapsed, (int, float)) or elapsed < 0:
            continue
        devices[row['device_id']].append({**row, 'start': row['ts'] - elapsed / 1000})
    runs = []
    for rows in devices.values():
        current = []
        for row in sorted(rows, key=lambda item: (item['start'], item['ts'])):
            continuous = (current and row.get('trigger') == 'handoff'
                          and current[-1].get('terminal_state') == 'handoff'
                          and abs(row['start'] - current[-1]['ts']) <= max_gap)
            if not continuous:
                if len(current) >= 5:
                    runs.append(current)
                current = []
            current.append(row)
        if len(current) >= 5:
            runs.append(current)
    return sorted(runs, key=lambda run: run[0]['start'])


def pair_metrics(outgoing, incoming):
    plan = plan_transition(outgoing, incoming)
    result = {'planner_score': plan['score'], 'fallback_fraction': float(plan['fallback']),
              'overlap_seconds': plan['overlap_seconds'],
              'rate_change_percent': abs(plan['playback_rate'] - 1) * 100}
    for field in ('note_rate', 'loudness_lufs', 'spectral_flatness'):
        a, b = outgoing.get(field), incoming.get(field)
        result[f'{field}_absolute_change'] = abs(b - a) if a is not None and b is not None else None
    return result


def edge_means(edges):
    return {key: average(row.get(key) for row in edges) for key in edges[0]} if edges else {}


def replay_report(runs, cache, shuffles, opening_times=()):
    with sqlite3.connect(cache.resolve().as_uri() + '?mode=ro', uri=True) as db:
        rows = db.execute('SELECT identity, payload FROM audio_analysis WHERE analyser_version=? ORDER BY identity',
                          (ANALYSER_VERSION,)).fetchall()
    analyses = {identity: json.loads(payload) for identity, payload in rows}
    output, excluded = [], Counter()
    rng = random.Random(0)
    warm_cold = []
    coverage = []
    for run_index, run in enumerate(runs, 1):
        known = [analyses.get(hashlib.sha256(row['track_id'].encode()).hexdigest()) for row in run]
        coverage.append({'delivery_run': run_index, 'tracks': len(run),
                         'current_analyses': sum(bool(item and item.get('analysed')) for item in known)})
        if not all(item and item.get('analysed') for item in known):
            excluded['missing_current_analysis'] += 1
            continue
        edges = [pair_metrics(a, b) for a, b in zip(known, known[1:])]
        shuffled_deltas = defaultdict(list)
        # Same opening and membership. This controls song mix but is not a
        # reconstruction of the candidate pool or an alternative live session.
        for _ in range(shuffles):
            rest = known[1:].copy()
            rng.shuffle(rest)
            order = [known[0], *rest]
            shuffled = [pair_metrics(a, b) for a, b in zip(order, order[1:])]
            early, late = edge_means(shuffled[:2]), edge_means(shuffled[-2:])
            for key in early:
                if early[key] is not None and late[key] is not None:
                    shuffled_deltas[key].append(late[key] - early[key])
        item = {'delivery_run': run_index, 'tracks': len(run),
                'matches_logged_session_opening': any(abs(run[0]['start'] - value) <= 5 for value in opening_times),
                'opening_utc': datetime.fromtimestamp(run[0]['start'], timezone.utc).isoformat(),
                'early': edge_means(edges[:2]), 'late': edge_means(edges[-2:]),
                'whole_run': edge_means(edges),
                'shuffle_mean_late_minus_early': {key: average(values) for key, values in shuffled_deltas.items()}}
        output.append(item)
        for a, b in zip(known, known[1:]):
            warm_cold.append({'warm': pair_metrics(a, b),
                              'cold': pair_metrics(fallback_analysis(a['duration']), fallback_analysis(b['duration']))})
    metrics = list(output[0]['early']) if output else []
    return {'analyser_version': ANALYSER_VERSION, 'current_cached_analyses': len(analyses),
            'excluded_runs': dict(excluded), 'runs': output,
            'analysis_coverage_by_run': coverage,
            'paired_summary': paired_summary(output, metrics),
            'opening_matched_summary': paired_summary([row for row in output if row['matches_logged_session_opening']], metrics),
            'shuffles_per_run': shuffles,
            'same_pair_cold_warm': {
                'pairs': len(warm_cold),
                **{state: {key: average(row[state].get(key) for row in warm_cold) for key in metrics}
                   for state in ('cold', 'warm')},
            }}


def delivery_report(runs):
    result = []
    for run in runs:
        # Only incoming handoff attempts; the opening can have a selection stall.
        incoming = run[1:]

        def metrics(rows):
            return {'rebuffer_ms_per_track': average(row['segments'].get('rebuffer_ms') for row in rows),
                    'rebuffered_fraction': average(float(row['segments']['rebuffer_count'] > 0)
                                                  for row in rows if 'rebuffer_count' in row['segments']),
                    'recovery_fraction': average(float(row['segments']['recovery_count'] > 0)
                                                for row in rows if 'recovery_count' in row['segments'])}

        result.append({'run': len(result) + 1, 'tracks': len(run),
                       'opening_utc': datetime.fromtimestamp(run[0]['start'], timezone.utc).isoformat(),
                       'minutes': round((run[-1]['ts'] - run[0]['start']) / 60, 3),
                       'early': metrics(incoming[:2]), 'late': metrics(incoming[-2:])})
    return {'runs': result, 'paired_summary': paired_summary(result, ['rebuffer_ms_per_track', 'rebuffered_fraction', 'recovery_fraction'])}


def trace_report(path, since):
    captures, events = {}, defaultdict(dict)
    losses = defaultdict(int)
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        for (payload,) in db.execute('SELECT payload FROM batches ORDER BY received, id'):
            batch = json.loads(payload)
            capture = batch['capture']
            key = capture['id']
            captures[key] = capture
            losses[key] = max(losses[key], batch.get('dropped', 0))
            for row in batch['events']:
                events[key][row['sequence']] = row
    result = []
    for key, by_sequence in events.items():
        capture = captures[key]
        start = datetime.fromisoformat(capture['startedAt']).timestamp()
        rows = sorted(by_sequence.values(), key=lambda row: row['sequence'])
        if not rows or start + rows[-1]['elapsedMs'] / 1000 < since:
            continue
        counts = Counter(row['event'] for row in rows if start + row['elapsedMs'] / 1000 >= since)
        gaps = rows[0]['sequence'] - 1 + sum(max(0, b['sequence'] - a['sequence'] - 1) for a, b in zip(rows, rows[1:]))
        result.append({'capture': len(result) + 1, 'started_utc': capture['startedAt'],
                       'client_revision': capture['clientRevision'], 'platform': capture['platform'],
                       'events': sum(counts.values()), 'sequence_gaps': gaps, 'reported_loss': losses[key],
                       'retirements': counts['handoff.retirement'], 'mix_starts': counts['mix.started'],
                       'mix_starts_with_technique': sum(row['event'] == 'mix.started' and bool(row['facts'].get('technique')) for row in rows),
                       'execution_fallbacks': sum(counts[name] for name in ('mix.rate_fallback', 'mix.execution_fallback', 'mix.signal_fallback'))})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--since', default='2026-10-26T00:00:00+01:00')
    parser.add_argument('--timezone', default='Europe/Madrid', help='Timezone used in the engine journal')
    parser.add_argument('--shuffles', type=int, default=256)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    cutoff = datetime.fromisoformat(args.since)
    if cutoff.tzinfo is None or args.shuffles < 1:
        parser.error('since needs a timezone; shuffles must be positive')
    root = args.snapshot
    timing = sorted(root.glob('play-timing.jsonl*'))
    rows = read_timing(timing, cutoff.timestamp())
    runs = delivery_runs(rows)
    plans = plan_report(root / 'plans.log', args.timezone, cutoff.timestamp())
    files = [root / name for name in ('plans.log', 'analysis.sqlite3', 'traces.sqlite3', 'snapshot.json')] + timing
    result = {
        'method': 'First two versus last two edges, at least four handoffs; session-weighted means.',
        'since': args.since, 'journal_timezone': args.timezone,
        'snapshot': json.loads((root / 'snapshot.json').read_text()),
        'input_sha256': {path.name: file_hash(path) for path in files},
        'plans': plans,
        'delivery_attempts': len(rows), 'delivery': delivery_report(runs),
        'delivery_gap_sensitivity': {str(gap): len(delivery_runs(rows, gap)) for gap in (2, 5, 10)},
        'replay': replay_report(runs, root / 'analysis.sqlite3', args.shuffles,
                                [row['opening_timestamp'] for row in plans['paired_sessions']]),
        'captures': trace_report(root / 'traces.sqlite3', cutoff.timestamp()),
    }
    result['source_sha256'] = {str(path.relative_to(Path(__file__).resolve().parents[2])):
                               hashlib.sha256(path.read_bytes()).hexdigest()
                               for path in [Path(__file__).resolve(), *sorted((Path(__file__).resolve().parents[2] / 'shared/dj').glob('*.py'))]}
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    print(f'Wrote {args.output}; {len(runs)} delivery runs, {len(result["plans"]["paired_sessions"])} paired planner sessions')


if __name__ == '__main__':
    main()
