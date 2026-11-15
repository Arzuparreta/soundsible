#!/usr/bin/env python3
"""Media time lost around playbackRate changes, from the linked web capture.

Behind docs/internal/dj/VERIFICATION.md. Reads a copy read-only; prints only
aggregates per platform and page visibility, no song, session or device identity.

    .venv/bin/python docs/internal/dj/rate_stall_probe.py \
        ~/.local/share/soundsible/users/<account>/telemetry/playback-traces.sqlite3

Every captured event carries a snapshot of both decks (`currentTime`,
`playbackRate`, paused, readyState) and of the AudioContext clock, stamped with
the page's monotonic clock. Between two snapshots of a deck that keeps playing,
a healthy renderer advances its media position by the requested rate times the
elapsed time. The shortfall is media time the element did not deliver. A
shortfall that persists in later snapshots is a loss of media progress, not a
late `currentTime` reading: a stale reading is corrected by the next one.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import sqlite3
import statistics

# Events of a deck after which its position may legitimately jump or stop.
BREAKS = {
    'media.seeking', 'media.seeked', 'media.pause', 'media.play', 'media.playing', 'media.emptied',
    'media.loadstart', 'media.waiting', 'media.stalled', 'media.ended', 'call.load',
}
STARTS = {'media.play', 'media.playing', 'media.seeked'}
BEFORE_MS, AFTER_MS, REACH_MS = 1000, 3000, 12000
# P16 recorded a one-off deficit of 0.25–0.4 s about one second after a start or seek.
START_TRANSIENT_MS = 1000


def read_only(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path.expanduser().resolve().as_uri() + '?mode=ro', uri=True)


def captures(path: Path) -> list[tuple[str, list[dict]]]:
    events, platform = defaultdict(list), {}
    with read_only(path) as db:
        for (payload,) in db.execute('SELECT payload FROM batches'):
            batch = json.loads(payload)
            capture = batch['capture']['id']
            platform[capture] = str(batch['capture'].get('platform'))
            events[capture].extend(batch['events'])
    return [(platform[capture], sorted(rows, key=lambda row: row['sequence'])) for capture, rows in events.items()]


def deck(row: dict, node: str) -> dict | None:
    return next((media for media in row.get('media') or [] if media.get('id') == node), None)


def playing(media: dict | None) -> bool:
    return bool(media) and not media['paused'] and media['readyState'] >= 3


def anchor(rows: list[dict], index: int, node: str, step: int, distance: int) -> int | None:
    """Nearest snapshot at least `distance` ms away with the deck playing and no break between."""
    origin = rows[index]['elapsedMs']
    j = index + step
    while 0 <= j < len(rows):
        row = rows[j]
        gap = abs(row['elapsedMs'] - origin)
        if gap > REACH_MS or (row['event'] in BREAKS and (row.get('facts') or {}).get('node') == node):
            return None
        if gap >= distance and playing(deck(row, node)):
            return j
        j += step
    return None


def shortfall(rows: list[dict], first: int, last: int, node: str) -> tuple[float, float, float | None]:
    """(media seconds not delivered, wall seconds, AudioContext seconds minus wall seconds)."""
    expected, previous = 0.0, rows[first]
    for row in rows[first + 1:last + 1]:
        if (media := deck(previous, node)) is not None:
            expected += (row['elapsedMs'] - previous['elapsedMs']) / 1000 * media['rate']
        if deck(row, node) is not None:
            previous = row
    wall = (rows[last]['elapsedMs'] - rows[first]['elapsedMs']) / 1000
    got = deck(rows[last], node)['position'] - deck(rows[first], node)['position']
    start, end = ((rows[k].get('program') or {}).get('contextTime') for k in (first, last))
    drift = None if start is None or end is None else end - start - wall
    return expected - got, wall, drift


def summary(values: list[float]) -> dict:
    values = sorted(values)
    if not values:
        return {'count': 0}
    return {
        'count': len(values),
        'median_s': round(statistics.median(values), 3),
        'p95_s': round(values[int(0.95 * (len(values) - 1))], 3),
        'max_s': round(values[-1], 3),
        'over_0_25_s': sum(value > 0.25 for value in values),
        **({'values_s': [round(value, 3) for value in values]} if len(values) <= 10 else {}),
    }


def report(path: Path) -> dict:
    leaving, every, context = defaultdict(list), defaultdict(list), defaultdict(list)
    control = defaultdict(lambda: {'played_s': 0.0, 'losses': [], 'after_start': 0})
    alarms = defaultdict(list)
    for platform, rows in captures(path):
        last_seen: dict[str, int] = {}
        started: dict[str, int] = {}
        for i, row in enumerate(rows):
            facts = row.get('facts') or {}
            if row['event'] in STARTS and facts.get('node'):
                started[facts['node']] = row['elapsedMs']
            key = f"{platform}/{row.get('visibility')}"
            if row['event'] == 'mix.rate_fallback':
                program = row.get('program') or {}
                active = program.get('activeIndex')
                alarms[key].append({
                    'phase': facts.get('phase'), 'reason': facts.get('reason'),
                    'active_deck_signal_rms': program.get(f'signal{active}Rms'),
                })
            node = facts.get('node')
            if row['event'] == 'media.timeupdate' and node:
                media = deck(row, node)
                before = last_seen.get(node)
                if playing(media) and before is not None:
                    previous = deck(rows[before], node)
                    wall = (row['elapsedMs'] - rows[before]['elapsedMs']) / 1000
                    if previous['rate'] == media['rate'] and 0 < wall <= REACH_MS / 1000:
                        bucket = control[f"{key}/{'1x' if media['rate'] == 1 else 'other_rate'}"]
                        bucket['played_s'] += wall
                        lost = wall * previous['rate'] - (media['position'] - previous['position'])
                        bucket['losses'].append(lost)
                        since = rows[before]['elapsedMs'] - started.get(node, -REACH_MS * 1000)
                        bucket['after_start'] += lost > 0.25 and since <= START_TRANSIENT_MS
                last_seen[node] = i if playing(media) else None
                if last_seen[node] is None:
                    del last_seen[node]
            elif row['event'] in BREAKS and node:
                last_seen.pop(node, None)
            if row['event'] == 'media.ratechange' and node:
                last_seen.pop(node, None)
                media = deck(row, node)
                if not playing(media):
                    continue
                first = anchor(rows, i, node, -1, BEFORE_MS)
                last = anchor(rows, i, node, 1, AFTER_MS)
                if first is None or last is None:
                    continue
                lost, _, drift = shortfall(rows, first, last, node)
                every[key].append(lost)
                if drift is not None:
                    context[key].append(abs(drift))
                prior = deck(rows[i - 1], node) if i else None
                if media['rate'] != 1 and prior is not None and prior['rate'] == 1:
                    leaving[key].append(lost)
    return {
        'rate_changes_leaving_1x': {key: summary(values) for key, values in sorted(leaving.items())},
        'every_rate_change': {key: summary(values) for key, values in sorted(every.items())},
        'audio_context_minus_wall_s_max': {key: round(max(values), 3) for key, values in sorted(context.items())},
        'steady_rate_control': {
            key: {'played_s': round(value['played_s']), **summary(value['losses']),
                  'over_0_25_s_within_1_s_of_a_start': value['after_start']}
            for key, value in sorted(control.items())
        },
        'rate_fallback_alarms': dict(sorted(alarms.items())),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('traces', type=Path)
    print(json.dumps(report(parser.parse_args().traces), indent=2))


if __name__ == '__main__':
    main()
