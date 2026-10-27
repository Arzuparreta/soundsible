"""Score retained final events with the lab's optional mir_eval dependency.

No audio, inference or production dependencies are installed or run here.
Uses the existing evaluator and verifies its F1 against the retained scores.

  LAB/venv/bin/python -I docs/dj/detector_comparison/final_continuity.py INPUT.json.gz OUTPUT.json [--aac]
"""
from __future__ import annotations

import argparse
import gzip
import importlib.metadata
import json
from pathlib import Path
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from docs.dj.detector_comparison.common import digest, write_json
from docs.dj.detector_comparison.metrics import evaluate


def score(path, reference):
    packages = {name: importlib.metadata.version(name) for name in ('numpy', 'scipy', 'mir_eval')}
    report = json.loads(gzip.decompress(path.read_bytes()))
    manifest = json.loads(reference.read_text())
    cases = {c['id']: c for c in manifest['cases']}
    if (report['provenance']['frozen_reference_sha256'] != digest(reference)
            or set(cases) != {r['case'] for r in report['rows']} or len(cases) != len(report['rows'])):
        raise ValueError('Continuity evaluation requires the same complete frozen cohort')
    rows = []
    for row in report['rows']:
        analysis = row['analysis']
        grid = dict(beats=analysis['beat_grid'], downbeats=analysis['downbeats'],
                    regions=analysis['metric_regions'], bpm=analysis['bpm'] or None)
        values = dict(case=row['case'], dataset=row['dataset'], split=row['split'])
        for name, events in [('model', row['model_events']), ('grid', grid)]:
            result = evaluate(events, cases[row['case']], row['tolerance_seconds'])
            for field in ('beat', 'downbeat'):
                actual, previous = result[field]['f1'], row[name][field]['f1']
                assert (actual is None and previous is None) or abs(actual - previous) < 1e-12
            values[name + '_beat'] = result['beat_continuity']
            values[name + '_first'] = result['downbeat_continuity']
        rows.append(values)
    summary = {}
    for group in sorted({r['dataset'] + '/' + r['split'] for r in rows}):
        subset = [r for r in rows if r['dataset'] + '/' + r['split'] == group]
        summary[group] = {}
        for field in ('model_beat', 'model_first', 'grid_beat', 'grid_first'):
            known = [r[field] for r in subset if r[field] is not None]
            summary[group][field] = dict(cases=len(known), **{
                metric: statistics.mean(r[metric] for r in known) if known else None
                for metric in ('cmlc', 'cmlt', 'amlc', 'amlt')})
    sources = [Path(__file__), Path(__file__).with_name('metrics.py'), Path(__file__).with_name('matching.py')]
    return dict(provenance=dict(git_head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                                packages=packages, python=sys.version, integrated_sha256=digest(path),
                                frozen_reference_sha256=digest(reference),
                                source_sha256={str(p.relative_to(ROOT)): digest(p) for p in sources}),
                summary=summary, rows=rows,
                boundary='Offline evaluation of retained events; no inference or audio decoding')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('integrated', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--aac', action='store_true')
    args = parser.parse_args()
    reference = Path(__file__).parent / 'results' / ('aac-references.json' if args.aac else 'manifest-references.json')
    write_json(args.output, score(args.integrated, reference))
