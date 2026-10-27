"""P13 preparation: content-change boundaries; no invented musical labels."""
import argparse
import json
from pathlib import Path

from .common import write_json
from .metrics import events


def measure(root):
    cases = [c for c in json.loads((root/'corpus/manifest.json').read_text())['cases']
             if 'structure_boundaries' in c]
    rows = []
    for method in ['allin1-fold0', 'allin1-all']:
        for case in cases:
            file = root/'results'/method/(case['id']+'.json')
            if not file.exists():
                continue
            prediction = json.loads(file.read_text())
            if prediction.get('failure'):
                continue
            segments = prediction['raw'].get('structure_segments', [])
            estimated = sorted({s['start'] for s in segments if .5 < s['start'] < case['duration']-.5})
            reference = [t for t in case['structure_boundaries'] if .5 < t < case['duration']-.5]
            rows.append(dict(method=method, case=case['id'], segments=segments,
                             content_boundaries_100ms=events(estimated, reference, .1),
                             content_boundaries_500ms=events(estimated, reference, .5),
                             phrase_or_label_accuracy=None))
    write_json(root/'structure-results.json', dict(results=rows,
        scope='Known content changes in three 4/4 signals; not reference musical section labels or real-song phrase accuracy.',
        p13_status='Fixtures prepared and model output retained; P13 remains pending.'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    measure(parser.parse_args().root)
