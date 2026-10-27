"""Plan every directed pair of the frozen corpus from retained final analyses.

No inference, cache, providers or clients. This measures planner admission;
it does not establish perceptual quality or sample-accurate audio execution.

  python -I docs/dj/detector_comparison/final_pairs.py INTEGRATED.json.gz OUTPUT.json.gz
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from docs.dj.detector_comparison.integrated_probe import digest, provenance
from shared.dj.timing import BEATMATCH_TECHNIQUES, beatmatch_fits
from shared.dj.transitions import plan_transition


def audit(report):
    references = Path(__file__).parent / 'results/manifest-references.json'
    manifest = json.loads(references.read_text())
    cases = {c['id']: c for c in manifest['cases']}
    rows = report['rows']
    if set(cases) != {r['case'] for r in rows} or len(rows) != len(cases):
        raise ValueError('Pair inventory requires the complete frozen corpus')
    current = provenance(references, references)
    measured = report['provenance']
    for key in ('analyser_version', 'model_sha256'):
        if current[key] != measured[key]:
            raise ValueError(f'Analysis provenance differs: {key}')
    for name, digest_ in current['source_sha256'].items():
        if name.startswith('shared/dj/') and measured['source_sha256'].get(name) != digest_:
            raise ValueError(f'Analysis source differs: {name}')
    plans = []
    for outgoing in rows:
        for incoming in rows:
            if outgoing['case'] == incoming['case']:
                continue
            a, b = outgoing['analysis'], incoming['analysis']
            plan = plan_transition(a, b)
            matched = plan['technique'] in BEATMATCH_TECHNIQUES
            assert matched == (plan['sync']['alignment'] in ('beats', 'bars'))
            if matched:
                assert abs(plan['playback_rate'] - 1) <= .080001
                assert beatmatch_fits(plan, a, b), (outgoing['case'], incoming['case'])
            else:
                assert plan['playback_rate'] == 1
            # The annotations can check a bar promise at both actual cues;
            # beat alignment does not promise the model's first beat is right.
            bar_cues = None
            if plan['sync']['alignment'] == 'bars':
                bar_cues = {}
                for key, row in [('out', outgoing), ('in', incoming)]:
                    case = cases[row['case']]
                    firsts = case['downbeats']
                    cue = plan[key + '_cue']
                    tolerance = manifest['tolerance_seconds']['synthetic' if case['dataset'] == 'synthetic' else 'real']
                    # Unknown/outside the annotated window is not a false claim.
                    if firsts is None or (case['beats'] and not case['beats'][0] <= cue <= case['beats'][-1]):
                        bar_cues[key] = None
                    else:
                        bar_cues[key] = any(abs(t - cue) <= tolerance + 1e-9 for t in firsts)
            plans.append(dict(outgoing=outgoing['case'], incoming=incoming['case'],
                              group='/'.join([outgoing['dataset'], incoming['dataset']]),
                              bar_cue_reference_matches=bar_cues, transition=plan))
    groups = {}
    for group in sorted({r['group'] for r in plans}):
        subset = [r for r in plans if r['group'] == group]
        groups[group] = dict(pairs=len(subset), alignments=dict(Counter(r['transition']['sync']['alignment'] for r in subset)),
                             techniques=dict(Counter(r['transition']['technique'] for r in subset)),
                             false_bar_cues=sum(value is False for r in subset
                                                for value in (r['bar_cue_reference_matches'] or {}).values()))
    return dict(provenance=current, summary=groups, rows=plans,
                boundary='Production planner on retained real analyses; no audio/client execution, no provider acquisition')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('integrated', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    raw = args.integrated.read_bytes()
    report = json.loads(gzip.decompress(raw) if args.integrated.suffix == '.gz' else raw)
    result = audit(report)
    result['integrated_sha256'] = digest(args.integrated)
    args.output.write_bytes(gzip.compress((json.dumps(result, indent=2, allow_nan=False) + '\n').encode(), mtime=0))
    print(json.dumps(result['summary'], indent=2))
