"""The engine's NumPy DBN against madmom's events retained by the comparison.

Reads the activations retained by `beatthis-<checkpoint>-direct` and the
events of `beatthis-<checkpoint>-dbn` (madmom 0.16.1 decoding the same
network output) and decodes the activations with `shared.dj.dbn`. Runs in the
engine environment: no madmom, no SciPy.

  python -I docs/dj/detector_comparison/dbn_probe.py ROOT/results OUTPUT.json
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from shared.dj import dbn  # noqa: E402


def compare(results: Path, checkpoint: str):
    rows = []
    for stored in sorted((results / f'beatthis-{checkpoint}-direct').glob('*.npz')):
        reference = results / f'beatthis-{checkpoint}-dbn' / stored.with_suffix('.json').name
        if not reference.exists():
            continue
        expected = json.loads(reference.read_text())['raw']
        logits = np.load(stored)
        cpu = time.process_time()
        beats, firsts = dbn.beats_and_downbeats(logits['beat'], logits['downbeat'])
        seconds = time.process_time() - cpu
        same = (len(beats) == len(expected['beats']) and len(firsts) == len(expected['downbeats'])
                and np.allclose(beats, expected['beats'], atol=1e-9, rtol=0)
                and np.allclose(firsts, expected['downbeats'], atol=1e-9, rtol=0))
        rows.append(dict(case=stored.stem, frames=len(logits['beat']), identical=bool(same),
                         beats=len(beats), expected_beats=len(expected['beats']),
                         cpu_seconds_per_audio_minute=seconds / (len(logits['beat']) / dbn.FPS / 60)))
    return dict(cases=len(rows), identical=sum(row['identical'] for row in rows),
                median_cpu_seconds_per_audio_minute=float(np.median([row['cpu_seconds_per_audio_minute'] for row in rows])),
                rows=rows)


def main():
    results, output = Path(sys.argv[1]), Path(sys.argv[2])
    report = {checkpoint: compare(results, checkpoint) for checkpoint in ('small0', 'final0')}
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: {m: v for m, v in d.items() if m != 'rows'} for k, d in report.items()}, indent=2))


if __name__ == '__main__':
    main()
