#!/usr/bin/env python3
"""Read linked DJ evidence locally; never infer sessions from receipt timestamps."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from statistics import mean

HELD = {'bass_swap', 'filter_blend', 'long_blend'}
FALLBACKS = {'mix.rate_fallback', 'mix.execution_fallback', 'mix.signal_fallback', 'mix.suspended'}


def numeric(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def average(values):
    values = [value for value in values if value is not None]
    return round(mean(values), 6) if values else None


def both(facts):
    values = [facts.get('fromAnalysed'), facts.get('toAnalysed')]
    return float(all(values)) if all(type(value) is bool for value in values) else None


def summary(edges):
    keys = ('selected_ready_fraction', 'committed_ready_fraction', 'planner_score', 'notes_delta',
            'lufs_delta', 'flatness_delta', 'executed_beatmatch_fraction', 'execution_fallback_fraction',
            'executed_overlap_seconds', 'executed_rate_change_percent')
    return {key: average(edge[key] for edge in edges) if edges and all(edge.get(key) is not None for edge in edges) else None for key in keys}


def report(path: Path):
    captures = {}
    rows = defaultdict(dict)
    losses = defaultdict(int)
    digest = hashlib.sha256()
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        for (payload,) in db.execute('SELECT payload FROM batches ORDER BY received, id'):
            digest.update(payload.encode() + b'\n')
            batch = json.loads(payload)
            capture = batch['capture']
            cid = capture['id']
            captures[cid] = capture
            losses[cid] = max(losses[cid], batch.get('dropped', 0))
            for row in batch['events']:
                rows[cid][row['sequence']] = row
    results = []
    for cid, by_sequence in rows.items():
        ordered = sorted(by_sequence.values(), key=lambda row: row['sequence'])
        sessions = defaultdict(list)
        for row in ordered:
            if sid := row.get('facts', {}).get('djSession'):
                sessions[sid].append(row)
        for session_rows in sessions.values():
            reasons = set()
            start = next((row for row in session_rows if row['event'] == 'dj.session_started'), None)
            if not start or start['facts'].get('startKnown') is not True:
                reasons.add('opening_not_observed')
            lower = session_rows[0]['sequence']
            upper = session_rows[-1]['sequence']
            window = [row for row in ordered if lower <= row['sequence'] <= upper]
            if losses[cid] or any(b['sequence'] != a['sequence'] + 1 for a, b in zip(window, window[1:])):
                reasons.add('trace_loss')
            first_selection = next((row['sequence'] for row in session_rows if row['event'] == 'dj.selected'), float('inf'))
            for row in session_rows:
                event, facts = row['event'], row['facts']
                if event == 'dj.capture_unavailable':
                    reasons.add('capture_unavailable')
                if event == 'dj.direction_changed' and row['sequence'] > first_selection:
                    reasons.add('interaction_or_interruption')
                if event in {'dj.interaction', 'media_session.action', 'transport.pause', 'transport.resume', 'media.seeking'}:
                    reasons.add('interaction_or_interruption')
                if event == 'connection.state' and facts.get('state') in {'offline', 'failed'}:
                    reasons.add('connection_interrupted')
            selected = {}
            attempts = defaultdict(list)
            for row in session_rows:
                facts = row['facts']
                if row['event'] == 'dj.selected':
                    selected.setdefault(facts.get('edgeId'), row)
                if tid := facts.get('transitionId'):
                    attempts[tid].append(row)
            completed = {}
            for attempt in attempts.values():
                commit = next((row for row in attempt if row['event'] == 'dj.committed'), None)
                done = next((row for row in attempt if row['event'] == 'dj.outcome' and row['facts'].get('outcome') == 'completed'), None)
                if not commit:
                    continue
                facts = commit['facts']
                if facts.get('manual') is True or facts.get('mixing') is not True:
                    reasons.add('manual_or_unmixed')
                if not done:
                    continue
                ordinal = facts.get('ordinal')
                if type(ordinal) is not int or ordinal < 1 or ordinal in completed:
                    reasons.add('ambiguous_ordinal')
                    continue
                execution = next((row['facts'] for row in attempt if row['event'] == 'mix.started'), None)
                selection = selected.get(facts.get('edgeId'))
                if not selection or selection['sequence'] > commit['sequence'] or facts.get('selectionKnown') is not True:
                    reasons.add('selection_missing')
                if not execution or not execution.get('technique'):
                    reasons.add('execution_missing')
                execution = execution or {}
                completed[ordinal] = {
                    'ordinal': ordinal,
                    'selected_ready_fraction': both(selection['facts']) if selection else None,
                    'committed_ready_fraction': both(facts),
                    'planner_score': numeric(facts.get('score')), 'notes_delta': numeric(facts.get('notesDelta')),
                    'lufs_delta': numeric(facts.get('lufsDelta')), 'flatness_delta': numeric(facts.get('flatnessDelta')),
                    'executed_beatmatch_fraction': float(execution['technique'] in HELD and not any(row['event'] in FALLBACKS for row in attempt)) if 'technique' in execution else None,
                    'execution_fallback_fraction': float(any(row['event'] in FALLBACKS for row in attempt)),
                    'executed_overlap_seconds': numeric(execution.get('overlap')),
                    'executed_rate_change_percent': abs(execution['rate'] - 1) * 100 if numeric(execution.get('rate')) is not None else None,
                }
            ordinals = sorted(completed)
            if len(ordinals) < 4:
                reasons.add('fewer_than_four_completed_transitions')
            if ordinals and ordinals != list(range(1, max(ordinals) + 1)):
                reasons.add('transition_gap')
            edges = [completed[key] for key in ordinals]
            routes = [row['facts'] for row in session_rows if row['event'] == 'dj.route']
            opening_ready = edges[0]['selected_ready_fraction'] if edges else None
            results.append({
                'session': len(results) + 1, 'platform': captures[cid]['platform'],
                'client_revision': captures[cid]['clientRevision'], 'eligible': not reasons,
                'opening_analysis': 'ready' if opening_ready == 1 else 'not_ready' if opening_ready == 0 else 'unknown',
                'exclusions': sorted(reasons), 'completed_transitions': len(edges),
                'closed': any(row['event'] == 'dj.session_ended' for row in session_rows),
                'early': summary(edges[:2]), 'late': summary(edges[-2:]), 'transitions': edges,
                'candidate_count_first_last': [routes[0].get('candidateCount'), routes[-1].get('candidateCount')] if routes else None,
            })
    groups = defaultdict(list)
    for row in results:
        if row['eligible']:
            groups[(row['platform'], row['client_revision'], row['opening_analysis'])].append(row)
    comparisons = []
    for (platform, revision, opening), sessions in groups.items():
        comparisons.append({'platform': platform, 'client_revision': revision, 'opening_analysis': opening, 'sessions': len(sessions),
                            'paired_means': {key: {
                                'sessions': sum(row['early'][key] is not None and row['late'][key] is not None for row in sessions),
                                'early': average(row['early'][key] for row in sessions if row['late'][key] is not None),
                                'late': average(row['late'][key] for row in sessions if row['early'][key] is not None),
                            } for key in sessions[0]['early']}})
    return {'payload_sha256': digest.hexdigest(), 'linked_sessions': len(results),
            'eligible_sessions': sum(row['eligible'] for row in results),
            'exclusions': dict(Counter(reason for row in results for reason in row['exclusions'])),
            'sessions': results, 'comparisons_by_client': comparisons,
            'limits': 'Completed observed prefixes; first two vs last two, equally weighted by session. Unknowns remain null. Physical sound and listener preference are not measured. Native Android sessions are not captured by this browser recorder.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    args = parser.parse_args()
    print(json.dumps(report(args.database), indent=2, allow_nan=False))
