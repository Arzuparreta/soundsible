"""Common 2/3/4/6-pulse DBN over RETAINED network observations.

No neural inference is repeated. Decoder CPU is measured independently; the
source pipeline's measured cost is retained separately, never called a new
measured end-to-end latency. This is a variant, not another network family.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import resource
import time

import numpy as np

from .common import Audio, digest, result, write_json
from .metrics import evaluate
from .run import refine


def decode(root, source, manifest_path=None):
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor
    manifest_path = manifest_path or root/'corpus/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    base = root/'results' if manifest_path.name == 'manifest.json' else root/'results'/manifest_path.stem
    input_directory = base/source
    method = source+'-common'
    output = base/method
    output.mkdir(parents=True, exist_ok=True)
    fps = 50 if source.startswith(('beatthis-', 'beatnet-', 'beatnetplus-')) else 44100/1024 if source.startswith('transformer-') else 100
    decoder = DBNDownBeatTrackingProcessor(beats_per_bar=[2, 3, 4, 6], fps=fps, num_threads=1)
    write_json(output/'metadata.json', dict(method=method, shared_inference_source=source,
        manifest_sha256=digest(manifest_path), fps=fps, beats_per_bar=[2, 3, 4, 6],
        parameters='madmom defaults, only allowed grouping expanded; 1 thread',
        runtime_measurement='decoder only; original model pipeline cost retained separately'))
    for case in manifest['cases']:
        prediction_path = input_directory/(case['id']+'.json')
        activation_path = prediction_path.with_suffix('.npz')
        target = output/prediction_path.name
        if target.exists() or not activation_path.exists() or not prediction_path.exists():
            continue
        previous = json.loads(prediction_path.read_text())
        if previous.get('failure'):
            continue
        native = np.load(activation_path)
        if 'beat' in native:
            beat, first = np.asarray(native['beat'], dtype=float), np.asarray(native['downbeat'], dtype=float)
            if previous['raw']['activation_kind'].startswith('logits'):
                import torch
                torch.set_num_threads(1)
                # Preserve Beat This!'s exact observation transformation; only
                # the allowed grouping changes relative to its native DBN.
                epsilon = 1e-5
                beat = torch.from_numpy(native['beat']).double().sigmoid().numpy()*(1-epsilon)+epsilon/2
                first = torch.from_numpy(native['downbeat']).double().sigmoid().numpy()*(1-epsilon)+epsilon/2
                activation = np.column_stack([np.maximum(beat-first, epsilon/2), first])
            else:
                activation = np.column_stack([np.maximum(beat-first, 0), first])
        else:
            activation = np.array(native['activation'], dtype=float)
            if source.startswith('transformer-'):
                activation[:, 0] = np.maximum(activation[:, 0]-activation[:, 1], 0)
        activation = np.clip(activation, 1e-8, 1-1e-8)
        timings = []
        for _ in range(2):
            start, cpu = time.perf_counter(), time.process_time()
            points = decoder(activation)
            timings.append(dict(wall_seconds=time.perf_counter()-start, cpu_seconds=time.process_time()-cpu,
                                child_cpu_seconds=0., process_peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                                child_peak_rss_kib=0.))
        raw = result(points[:, 0], points[points[:, 1] == 1, 0], duration=case['duration'], shared_inference_source=source)
        tolerance = manifest['tolerance_seconds']['synthetic' if case['dataset'] == 'synthetic' else 'real']
        aligned = refine(raw, Audio(case, root/'derivatives'), root)
        write_json(target, dict(case=case['id'], dataset=case['dataset'], genre=case['genre'], split=case['split'],
                    duration=case['duration'], raw=raw, refined=aligned, timings=timings,
                    metrics=evaluate(raw, case, tolerance), refined_metrics=evaluate(aligned, case, tolerance),
                    shared_source_timings=previous['timings'],
                    source_prediction_sha256=digest(prediction_path), source_activation_sha256=digest(activation_path),
                    shared_inference_source=source))
        print(method, case['id'], flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('source')
    parser.add_argument('--manifest', type=Path)
    args = parser.parse_args()
    decode(args.root, args.source, args.manifest)
