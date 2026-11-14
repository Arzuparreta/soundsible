"""Measure shared decode/resampling separately, using fresh disposable caches.

These component costs accompany cached backend measurements; their sum is an
estimate, not a newly measured complete pipeline. No downloads are timed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import resource
import tempfile
import time

from .common import Audio, scratch, write_json


def measure(root):
    temporary = scratch(root)
    rows = []
    for manifest in ['manifest', 'aac']:
        cases = json.loads((root/'corpus'/(manifest+'.json')).read_text())['cases']
        for case in cases:
            for rate, wave in [(11025, False), (22050, False), (44100, False), (44100, True)]:
                timings = []
                for _ in range(2):
                    with tempfile.TemporaryDirectory(prefix='dj-frontend-', dir=temporary) as folder:
                        audio = Audio(case, folder)
                        start, cpu = time.perf_counter(), time.process_time()
                        child = resource.getrusage(resource.RUSAGE_CHILDREN)
                        if wave:
                            audio.wave(rate)
                        else:
                            audio.samples(rate)
                        after = resource.getrusage(resource.RUSAGE_CHILDREN)
                        timings.append(dict(wall_seconds=time.perf_counter()-start,
                            cpu_seconds=time.process_time()-cpu+after.ru_utime+after.ru_stime-child.ru_utime-child.ru_stime))
                rows.append(dict(manifest=manifest, case=case['id'], duration=case['duration'],
                                 sample_rate=rate, format='wav_float' if wave else 'numpy_float32',
                                 timings=timings))
    write_json(root/'frontend-costs.json', dict(results=rows, policy='Fresh derivative cache for each repetition; input SHA verification and downloads outside timing.'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    measure(parser.parse_args().root)
