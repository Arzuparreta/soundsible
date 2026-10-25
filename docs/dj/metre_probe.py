"""Reproducible P12 measurements, without audio in Git.

Synthetic: python -I docs/dj/metre_probe.py
Real: python -I docs/dj/metre_probe.py --ballroom /path/to/BallroomData
Or pass a JSON manifest with file/genre/annotation names.
The manifest has file/genre/annotation names. Annotations are fetched at a pinned
revision, audio stays local. This is evaluation, never detector calibration.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))

import numpy as np
from shared.dj.analysis import _compose
from shared.dj import store
from test_dj_metre import RATE, metric_signal

ANNOTATIONS = '826c2eadb7d89e8fbcc655477416f8b3d3ff1c0e'


def errors(points, reference):
    if not len(points) or not len(reference):
        return None
    distances = np.min(np.abs(np.asarray(points)[:, None] - np.asarray(reference)[None, :]), axis=1)
    return {'median_ms': round(float(np.median(distances)) * 1000, 3),
            'p90_ms': round(float(np.percentile(distances, 90)) * 1000, 3)}


def metrics(analysis, beats, bars, period, size, tolerance):
    regions = analysis.get('metric_regions', [])
    start, end = float(beats[0]), float(beats[-1])
    length = max(end - start, 1e-12)
    def span(row):
        return max(0., min(row['end'], end) - max(row['start'], start))
    covered = sum(span(row) for row in regions if row['beats_per_bar'] is not None)
    correct = sum(span(row) for row in regions if row['beats_per_bar'] == size)
    first_covered = sum(span(row) for row in regions if row['downbeats'] and row['downbeat_confidence'] > 0)
    downbeats = [t for t in analysis['downbeats'] if start <= t <= end]
    grid = [t for t in analysis['beat_grid'] if start <= t <= end]
    reference_bar = float(np.median(np.diff(bars))) if len(bars) > 1 else None
    bar_errors = [(row['bar_seconds'] / reference_bar - 1) * 100 for row in regions
                  if row['bar_seconds'] and reference_bar]
    precision = float(np.mean([min(abs(bars - t)) <= tolerance for t in downbeats])) if downbeats else None
    return {'bpm': analysis['bpm'], 'tempo_error_percent': round((analysis['bpm'] / (60 / period) - 1) * 100, 3),
            'evaluation_start': start, 'evaluation_end': end,
            'pulse_error': errors(grid, beats), 'first_error': errors(downbeats, bars),
            'first_precision': round(precision, 3) if precision is not None else None,
            'grouping_coverage': round(covered / length, 3),
            'correct_grouping_coverage': round(correct / length, 3),
            'first_coverage': round(first_covered / length, 3),
            'bar_duration_error_percent': [round(value, 3) for value in bar_errors],
            'regions': [{key: value for key, value in row.items() if key != 'downbeats'} for row in regions]}


def synthetic():
    result = []
    for size, subdivision in ((3, 2), (4, 2), (2, 3)):
        for options in ({}, {'first': .83, 'pickup': 1, 'weak_first': True}, {'syncopated': True}, {'drift': .015}):
            samples, beats, bars = metric_signal(beats_per_bar=size, subdivision=subdivision, **options)
            analysis = _compose(samples, samples, RATE, duration=len(samples) / RATE, tail_start=0)
            row = {'size': size, 'subdivision': subdivision, 'options': options,
                   **metrics(analysis, beats, bars, .5, size, .01)}
            known = [region for region in analysis['metric_regions'] if region['beats_per_bar']]
            expected_subdivision = None if subdivision == 3 and options.get('syncopated') else subdivision
            row['reference_subdivision'] = expected_subdivision
            row['subdivision_correct_regions'] = sum(region['subdivision'] == expected_subdivision for region in known)
            row['known_regions'] = len(known)
            result.append(row)
    return {'kind': 'synthetic', 'cases': result}


def ballroom(manifest):
    result = []
    with tempfile.TemporaryDirectory(prefix='dj-p12-evaluation-') as directory:
        # No reading/writing of the user's application cache.
        store._cache_path = lambda: Path(directory) / 'analysis.sqlite3'
        if manifest.is_dir():
            recorded = json.loads((Path(__file__).parent / 'p12-results.json').read_text())['real']['cases']
            items = [{'file': str(manifest / row['genre'] / row['file']), 'genre': row['genre'],
                      'annotation': Path(row['file']).stem + '.beats'} for row in recorded]
        else:
            items = json.loads(manifest.read_text())
        for item in items:
            path = Path(item['file'])
            url = f"https://raw.githubusercontent.com/CPJKU/BallroomAnnotations/{ANNOTATIONS}/{item['annotation']}"
            annotation = urllib.request.urlopen(url, timeout=30).read()
            data = np.array([[float(value) for value in line.split()] for line in annotation.decode().splitlines() if line.strip()])
            beats, bars = data[:, 0], data[data[:, 1] == 1, 0]
            analysis = store.analyse_audio(path, path.stem)
            result.append({'file': path.name, 'genre': item['genre'], 'reference': url,
                           'audio_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                           'annotation_sha256': hashlib.sha256(annotation).hexdigest(),
                           'reference_bpm': round(60 / float(np.median(np.diff(beats))), 3),
                           'reference_pulses_per_bar': int(data[:, 1].max()),
                           'reference_subdivision': None,  # Not annotated: never score it as truth.
                           **metrics(analysis, beats, bars, float(np.median(np.diff(beats))), int(data[:, 1].max()), .07)})
    return {'kind': 'real_ballroom', 'annotations_revision': ANNOTATIONS, 'cases': result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ballroom', type=Path)
    args = parser.parse_args()
    print(json.dumps(ballroom(args.ballroom) if args.ballroom else synthetic(), indent=2))


if __name__ == '__main__':
    main()
