#!/usr/bin/env python3
"""Read server evidence without asking the listener to capture or export anything."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


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
