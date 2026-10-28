"""Measure P13 phrases, sections and roles on arrangements with known answers.

Run from the repository root:

    .venv/bin/python -I docs/dj/structure_probe.py --model --library /path/to/tracks --limit 40

Four separate measurements, written to docs/dj/p13-results.json:

- `exact`: the arrangements of tests/test_dj_structure.py with the beat model's
  events given exactly on its 20 ms frames. Errors here are the structure's own.
- `wrong_bars`: the same signals with the model's bars one beat late, or in
  groups of three on four-beat music. The changes are measured on wrong bars:
  inherited errors, reported apart.
- `model` (--model): the real beat model (Beat This! final0, ONNX) on the same
  signals rendered at 22050 Hz, through the production decimation.
- `library` (--library): a description of real recordings without reference
  annotations. Counts, not accuracy; no titles or paths are written.

A change is matched only on its exact bar. Roles are compared bar by bar
against the role each bar was built with; a bar without a role is an
abstention, not an error.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(1, str(ROOT / 'tests'))
from shared.dj import beat_model, store, weights  # noqa: E402
from shared.dj.analysis import _compose  # noqa: E402
from shared.dj.analysis import decimate  # noqa: E402
from shared.dj.features import _window_features  # noqa: E402
from shared.dj.structure import measured_runs  # noqa: E402
from test_dj_metre import model_events  # noqa: E402
from test_dj_structure import LEAD, METRES, NO_BEAT, RATE, THIN, arrangement, roles, toggling  # noqa: E402

BARS = 96


def _flags(changes):
    return lambda bar: {'lead': .1 * (sum(bar >= change for change in changes) % 2)}


def cases():
    """(name, layers, beats_per_bar, subdivision, known changes, known length, role of each bar)."""
    rows = []
    for size, subdivision in METRES:
        for length, offset in ((4, 4), (8, 5), (16, 4)):
            changes = list(range(offset, BARS - 1 - 4 + 1, length))
            rows.append((f'phrases_{length}_from_{offset}_{size}x{subdivision}', toggling(length, offset),
                         size, subdivision, changes, length, None))
        layout = [(12, THIN), (20, LEAD), (12, NO_BEAT), (20, LEAD), (12, {**THIN, 'lead': 0.}), (20, LEAD)]
        role = ['intro'] * 12 + ['body'] * 20 + ['breakdown'] * 12 + ['drop'] * 20 + ['body'] * 32
        rows.append((f'roles_{size}x{subdivision}', roles(layout), size, subdivision, [12, 32, 44, 64, 76], None, role))
    rows.append(('extension_8_8_10', _flags([8, 16, 26, 34, 42, 50, 58, 66, 74, 82]), 4, 2,
                 [8, 16, 26, 34, 42, 50, 58, 66, 74, 82], 8, None))
    rows.append(('no_shared_length', _flags([8, 13, 25, 31, 45, 55, 62, 76]), 4, 2,
                 [8, 13, 25, 31, 45, 55, 62, 76], None, None))

    def build(bar):
        return {**NO_BEAT, 'riser': .2 * 10 ** (.03 * bar)}

    layout = [(16, LEAD), (8, NO_BEAT), (8, build), (32, LEAD), (16, {'lead': 0.}), (16, THIN)]
    role = ['body'] * 16 + ['breakdown'] * 8 + ['build'] * 8 + ['drop'] * 32 + ['outro'] * 32
    rows.append(('breakdown_build_drop_outro', roles(layout), 4, 2, [16, 24, 32, 64, 80], None, role))
    louder = {'kick': 2., 'bass': .6, 'hat': .3, 'chords': .16, 'lead': .2}
    quieter = {'kick': .5, 'bass': .15, 'hat': .075, 'chords': .04, 'lead': .05}
    rows.append(('everything_6db_louder', roles([(32, LEAD), (16, louder), (48, LEAD)]), 4, 2, [32, 48], None,
                 ['intro'] * 32 + ['body'] * 16 + ['outro'] * 48))
    rows.append(('everything_6db_quieter', roles([(32, LEAD), (16, quieter), (48, LEAD)]), 4, 2, [32, 48], None,
                 ['body'] * 96))
    rows.append(('steady_loop', lambda bar: LEAD, 4, 2, [], None, [None] * 96))
    rows.append(('lead_1_6db_louder', lambda bar: {'lead': .1 if bar < 48 else .12}, 4, 2, [], None, [None] * 96))
    rows.append(('lead_fades_in_32_bars', lambda bar: {'lead': .1 * 10 ** (.025 * min(max(bar - 32, 0), 32))},
                 4, 2, [], None, [None] * 96))
    return rows


def late(beats, ones):
    times, _ = model_events(beats, ones)
    return times, times[1::4]


def threes(beats, ones):
    times, _ = model_events(beats, ones)
    return times, times[::3]


def measure(analysis, lengths, ones, changes, length, role):
    """Errors of one analysis against the known arrangement."""
    ones = np.asarray(ones)
    starts = [row['start'] for row in analysis['phrases']]
    boundaries = [row['start'] for row in analysis['phrases'] if row['evidence'] == 'boundary']
    nearest = [int(np.argmin(np.abs(ones - at))) for at in boundaries]
    offsets = [at - ones[index] for at, index in zip(boundaries, nearest)]
    exact = [index for index, offset in zip(nearest, offsets) if abs(offset) < .01]
    hits = len(set(exact) & set(changes))
    result = {
        'known_changes': len(changes),
        'measured_changes': len(boundaries),
        'exact_bar_hits': hits,
        'precision': round(hits / len(boundaries), 3) if boundaries else None,
        'recall': round(hits / len(changes), 3) if changes else None,
        'median_offset_ms': round(1000 * statistics.median(offsets), 1) if offsets else None,
        'phrase_length_known': length,
        'phrase_length_measured': lengths,
        'evidence': dict(Counter(row['evidence'] for row in analysis['phrases'])),
    }
    if length and starts:
        result['phase_bar'] = int(np.argmin(np.abs(ones - starts[0]))) % length
        result['phase_known'] = changes[0] % length if changes else None
    if role is not None:
        compared = labelled = right = 0
        for section in analysis['sections']:
            first = int(np.argmin(np.abs(ones - section['start'])))
            for bar in range(first, min(first + section['bars'], len(role))):
                compared += 1
                if section['label'] is not None:
                    labelled += 1
                    right += section['label'] == role[bar]
        result.update(role_bars=compared, role_abstentions=compared - labelled,
                      role_accuracy=round(right / labelled, 3) if labelled else None,
                      labels=[[section['label'], int(np.argmin(np.abs(ones - section['start'])))]
                              for section in analysis['sections']])
    return result


def compose(samples, events):
    """The stored analysis and each run's measured phrase length (None: assumed)."""
    features = _window_features(samples, RATE, events)
    runs = measured_runs(features, features, tail_start=0.) if features else []
    analysis = _compose(samples, samples, RATE, duration=len(samples) / RATE, tail_start=0, events=(events, events))
    return analysis, [run['length'] for run in runs], runs


def synthetic(with_model: bool) -> dict:
    report = {'exact': {}, 'wrong_bars': {}, 'model': {}}
    session = weights.session(store._off_loop) if with_model else None
    for name, layers, size, subdivision, changes, length, role in cases():
        samples, beats, ones = arrangement(layers, bars=BARS, beats_per_bar=size, subdivision=subdivision)
        analysis, lengths, _ = compose(samples, model_events(beats, ones))
        report['exact'][name] = measure(analysis, lengths, ones, changes, length, role)
        if name in ('phrases_8_from_5_4x2', 'roles_4x2'):
            for label, model in (('one_beat_late', late), ('three_beat_bars', threes)):
                analysis, lengths, _ = compose(samples, model(beats, ones))
                report['wrong_bars'][f'{name}/{label}'] = measure(analysis, lengths, ones, changes, length, role)
        if session is not None:
            rendered, _, _ = arrangement(layers, bars=BARS, beats_per_bar=size, subdivision=subdivision, rate=22050)
            found = beat_model.events(session, rendered)
            analysis, lengths, _ = compose(decimate(rendered), found)
            report['model'][name] = {**measure(analysis, lengths, ones, changes, length, role),
                                     'model_ones': len(found[1])}
    return report


def library(directory: Path, limit: int) -> dict:
    """Aggregates over real recordings up to eight minutes; nothing identifies a track."""
    session = weights.session(store._off_loop)
    paths = sorted(path for path in directory.iterdir()
                   if path.suffix.lower() in {'.flac', '.m4a', '.mp3', '.opus', '.ogg'})
    counts = Counter()
    evidence = Counter()
    lengths = Counter()
    labels = Counter()
    with_label = Counter()
    intervals = []
    per_100 = []
    for path in paths:
        if counts['analysed'] >= limit:
            break
        samples, _ = store._decode_measured(path, beat_model.SAMPLE_RATE)
        if samples is None or not 30 * beat_model.SAMPLE_RATE <= samples.size <= store.WINDOWED_ABOVE_SECONDS * beat_model.SAMPLE_RATE:
            counts['skipped'] += 1
            continue
        analysis, run_lengths, runs = compose(decimate(samples), beat_model.events(session, samples))
        counts['analysed'] += 1
        bars = sum(len(run['levels']) for run in runs)
        changes = [[bar for bar, _, _ in run['changes']] for run in runs]
        if bars:
            per_100.append(100 * sum(map(len, changes)) / bars)
        for marks in changes:
            intervals += [b - a for a, b in zip(marks, marks[1:])]
        lengths.update(str(value) for value in run_lengths)
        evidence.update(row['evidence'] for row in analysis['phrases'])
        for row in analysis['sections']:
            labels[str(row['label'])] += row['bars']
        with_label.update({str(row['label']) for row in analysis['sections']})
    return {
        **counts,
        'changes_per_100_bars_median': round(statistics.median(per_100), 1) if per_100 else None,
        'intervals_between_changes': len(intervals),
        'share_of_intervals_multiple_of': {str(size): round(sum(i % size == 0 for i in intervals) / len(intervals), 3)
                                           for size in (4, 8, 16)} if intervals else None,
        'chance_share_multiple_of': {'4': .25, '8': .125, '16': .0625},
        'runs_by_measured_phrase_length': dict(lengths),
        'phrase_evidence': dict(evidence),
        'bars_by_label': dict(labels),
        'tracks_with_label': dict(with_label),
        'scope': 'No reference annotations: agreement with dance-music phrasing, not accuracy.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--model', action='store_true', help='also run the real beat model')
    parser.add_argument('--library', type=Path, help='directory of real recordings (aggregates only)')
    parser.add_argument('--limit', type=int, default=40)
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/dj/p13-results.json')
    args = parser.parse_args()
    report = synthetic(args.model)
    if args.library:
        report['library'] = library(args.library, args.limit)
    from shared.dj.contracts import ANALYSER_VERSION
    report['analyser_version'] = ANALYSER_VERSION
    args.output.write_text(json.dumps(report, indent=1, sort_keys=True) + '\n')
    for part in ('exact', 'wrong_bars', 'model'):
        for name, row in report[part].items():
            print(part, name, {key: row.get(key) for key in (
                'exact_bar_hits', 'known_changes', 'measured_changes', 'phrase_length_known',
                'phrase_length_measured', 'role_accuracy', 'role_abstentions', 'median_offset_ms')})
    if 'library' in report:
        print(json.dumps(report['library'], indent=1))


if __name__ == '__main__':
    main()
