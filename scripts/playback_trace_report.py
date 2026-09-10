#!/usr/bin/env python3
"""Read server evidence without asking the listener to capture or export anything."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from statistics import median


def clock_comparison(rows):
    """Compare stable source/context clocks, not sound at the physical output."""
    groups = defaultdict(list)
    anchor = None
    previous_sequence = None
    for row in rows:
        program = row.get('program', {})
        source = next((m for m in row['media'] if m.get('deckIndex') == program.get('activeIndex')), None)
        key = (program.get('outputMode'), row.get('visibility'), program.get('activeIndex'))
        healthy = (row.get('declaredState') == 'playing' and program.get('contextState') == 'running'
                   and program.get('mixPhase') == 'idle' and source and not source.get('paused', True)
                   and source.get('sourceKind') == 'track' and source.get('rate') == 1
                   and isinstance(program.get('contextTime'), (int, float))
                   and isinstance(source.get('position'), (int, float)))
        continuous = previous_sequence is None or row['sequence'] == previous_sequence + 1
        previous_sequence = row['sequence']
        # Even an operation between two otherwise healthy samples invalidates
        # their interval. No averaging across seeks, suspension or deck reuse.
        if not healthy or not continuous or row['event'] != 'media.timeupdate':
            anchor = None
        if not healthy or row['event'] != 'media.timeupdate' or row['facts'].get('node') != source['id']:
            continue
        if anchor and key == anchor[0]:
            _, before, position, context = anchor
            elapsed = (row['elapsedMs'] - before) / 1000
            advance = source['position'] - position
            context_advance = program['contextTime'] - context
            if 2 <= elapsed <= 8 and abs(advance - elapsed) <= max(0.1, elapsed * 0.02) and context_advance > 0:
                groups[key[:2]].append((context_advance / elapsed, advance / elapsed))
        anchor = (key, row['elapsedMs'], source['position'], program['contextTime'])
    result = []
    for (mode, visibility), values in sorted(groups.items()):
        if len(values) < 3:
            continue
        context_ratio = median(value[0] for value in values)
        source_ratio = median(value[1] for value in values)
        result.append(f'Clocks mode={mode} visibility={visibility} intervals={len(values)} '
                      f'context/wall={context_ratio:.6f} source/wall={source_ratio:.6f} '
                      f'context-drift={(context_ratio - 1) * 100:.3f}% (not measured audible pitch)')
    return result


def report(path: Path, since: str | None = None) -> str:
    cutoff = datetime.fromisoformat(since).timestamp() if since else 0
    sessions = defaultdict(dict)
    captures = {}
    losses = defaultdict(int)
    with sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True) as db:
        for received, payload in db.execute('SELECT received, payload FROM batches ORDER BY received'):
            batch = json.loads(payload)
            capture = batch['capture']
            sid = capture['id']
            # Filter by client observation time, not delayed upload time.
            start = datetime.fromisoformat(capture['startedAt']).timestamp()
            if not any(start + row['elapsedMs'] / 1000 >= cutoff for row in batch['events']):
                continue
            captures[sid] = capture
            losses[sid] = max(losses[sid], batch.get('dropped', 0))
            for row in batch['events']:
                row['receivedAt'] = received
                sessions[sid][row['sequence']] = row
    output = ['Playback evidence: browser declarations are NOT an acknowledgement from iOS or the car.']
    for sid, by_sequence in sessions.items():
        rows = sorted(by_sequence.values(), key=lambda row: row['sequence'])
        capture = captures[sid]
        counts = Counter(row['event'] for row in rows)
        gaps = sum(max(0, b['sequence'] - a['sequence'] - 1) for a, b in zip(rows, rows[1:])) + rows[0]['sequence'] - 1
        output.append(f"\nSession {sid} started={capture['startedAt']} device={capture.get('deviceId', '?')} platform={capture.get('platform', '?')} revision={capture.get('clientRevision', '?')}")
        output.append(f"Events={len(rows)} missing-sequences={gaps} reported-loss={losses[sid]} handoffs={counts['handoff.retirement']}")
        start = datetime.fromisoformat(capture['startedAt']).timestamp()
        output.extend(clock_comparison([row for row in rows if start + row['elapsedMs'] / 1000 >= cutoff]))
        windows = [row['elapsedMs'] for row in rows if row['event'] in {'handoff.retirement', 'transport.pause', 'transport.resume', 'media_session.action'}]
        previous = None
        for row in rows:
            is_window = any(-2000 <= row['elapsedMs'] - center <= 10_000 for center in windows)
            advancing = []
            if previous:
                old = {m['id']: m for m in previous['media']}
                for media in row['media']:
                    before = old.get(media.get('id'), {})
                    if isinstance(media.get('position'), (int, float)) and isinstance(before.get('position'), (int, float)) and media['position'] > before['position'] + 0.05:
                        advancing.append(media['id'])
            mismatch = row.get('declaredState') != 'playing' and bool(advancing)
            previous = row
            if not is_window and not mismatch and row['event'] not in {'reject.play', 'media.error', 'context.statechange'}:
                continue
            timestamp = datetime.fromtimestamp(start + row['elapsedMs'] / 1000, timezone.utc).isoformat(timespec='milliseconds')
            media = ','.join(f"{m.get('id')}:{'paused' if m.get('paused') else 'playing'}:{'muted' if m.get('muted') else 'unmuted'}@{m.get('position')}" for m in row['media'])
            flag = ' DECLARED_NOT_PLAYING_WHILE_POSITION_ADVANCES' if mismatch else ''
            output.append(f"{timestamp} #{row['sequence']} +{row['elapsedMs']:.1f}ms {row['event']} declared={row.get('declaredState')} {json.dumps(row['facts'], sort_keys=True)} [{media}]{flag}")
    if not sessions:
        output.append('No captured sessions in this time range. Old play-timing logs cannot reconstruct these events.')
    return '\n'.join(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('--since', help='ISO timestamp including timezone, e.g. 2026-09-08T21:30:00+02:00')
    args = parser.parse_args()
    print(report(args.database, args.since))
