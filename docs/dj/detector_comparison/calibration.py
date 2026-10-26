"""Descriptive reliability of native activation scores; no threshold fitting."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .common import write_json
from .metrics import events


def measure(root):
    manifest = json.loads((root/'corpus/manifest.json').read_text())
    cases = {c['id']: c for c in manifest['cases']}
    results = {}
    for directory in sorted((root/'results').iterdir()):
        if not (directory/'metadata.json').exists():
            continue
        values = []
        for prediction in directory.glob('*.json'):
            if prediction.name == 'metadata.json':
                continue
            row = json.loads(prediction.read_text())
            if row.get('failure'):
                continue
            file = prediction.with_suffix('.npz')
            kind = row['raw'].get('activation_kind', '')
            source = row.get('shared_inference_source')
            if source:
                file = directory.parent/source/file.name
                source_row = json.loads(file.with_suffix('.json').read_text())
                kind = source_row['raw'].get('activation_kind', '')
            if not file.exists():
                continue
            case = cases[row['case']]
            if case['downbeats'] is None:
                continue
            if kind.startswith('empirical_rank'):
                continue  # Not probability; don't score it as one.
            data = np.load(file)
            if 'downbeat' in data:
                first = np.asarray(data['downbeat'], dtype=float)
                fps = 50 if directory.name.startswith('beatthis') else 100
                if kind.startswith('logits'):
                    first = 1/(1+np.exp(-np.clip(first, -700, 700)))
            else:
                first = np.asarray(data['activation'], dtype=float)[:, 1]
                fps = 44100/1024 if directory.name.startswith('transformer') else 50 if directory.name.startswith('beatnet') else 100
            tolerance = .01 if case['dataset'] == 'synthetic' else .07
            start, end = (case['beats'][0], case['beats'][-1]) if case['beats'] else (0, case['duration'])
            points = [t for t in row['raw']['downbeats'] if start-tolerance-1e-9 <= t <= end+tolerance+1e-9]
            matched = {i for i, _ in events(points, case['downbeats'], tolerance, include_matches=True)['matches']}
            for index, at in enumerate(points):
                lo = max(0, int(np.ceil((at-tolerance-1e-9)*fps)))
                hi = min(len(first), int(np.floor((at+tolerance+1e-9)*fps))+1)
                if hi > lo:
                    values.append(dict(case=case['id'], split=case['split'],
                                       score=float(np.max(first[lo:hi])), correct=index in matched))
        if not values:
            continue
        output = {}
        for split in sorted({v['split'] for v in values}):
            sample = [v for v in values if v['split'] == split]
            bins = []
            for a, b in zip(np.linspace(0, 1, 6)[:-1], np.linspace(0, 1, 6)[1:]):
                selected = [v for v in sample if a <= v['score'] < b or b == 1 and v['score'] == 1]
                bins.append(dict(low=float(a), high=float(b), events=len(selected),
                                 mean_score=float(np.mean([v['score'] for v in selected])) if selected else None,
                                 observed_precision=float(np.mean([v['correct'] for v in selected])) if selected else None))
            output[split] = dict(events=len(sample), bins=bins,
                                 brier_on_emitted_events=float(np.mean([(v['score']-v['correct'])**2 for v in sample])))
        results[directory.name] = output
    write_json(root/'calibration-results.json', dict(methods=results,
        interpretation='Native downbeat activation maximum within matching tolerance of each emitted event; not all-frame calibration.',
        fitting='No threshold/calibrator fitted; descriptive development/test reliability separately.'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    measure(parser.parse_args().root)
