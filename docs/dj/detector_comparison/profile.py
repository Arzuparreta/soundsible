"""Memory of the backend alone, without the metric evaluator in the process.

One fixed 30-second input, cold separated frontend, then a warm pass. Linux
RSS/PSS tree sampling accompanies exact process ru_maxrss. CPU ranking uses
the uninstrumented complete-corpus run, not this sampled memory process.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import resource
import sys
import threading
import time

from .adapters import Backend
from .common import Audio, scratch, write_json


def process_tree(pid):
    children = []
    try:
        children = [int(p) for p in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
    except (OSError, ValueError):
        pass
    result = [pid]
    for child in children:
        result.extend(process_tree(child))
    return result


def memory(pid):
    rss = pss = 0
    try:
        for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
            if line.startswith('Rss:'):
                rss = int(line.split()[1])
            if line.startswith('Pss:'):
                pss = int(line.split()[1])
    except OSError:
        pass
    return rss, pss


def profile(root, method):
    scratch(root)
    workspace = root/'memory-workspaces'/method
    workspace.mkdir(parents=True, exist_ok=True)
    for name in ['sources', 'snapshots', 'checkpoints', 'allin1-hf-metadata.json', 'spleeter232-venv', 'pretrained_models']:
        target = workspace/name
        if not target.exists():
            target.symlink_to(root/name)
    case = json.loads((root/'corpus/manifest.json').read_text())['cases'][0]
    peaks = dict(rss_tree_kib=0, pss_tree_kib=0, samples=0)
    stop = threading.Event()
    def sample():
        while not stop.is_set():
            values = [memory(pid) for pid in process_tree(os.getpid())]
            peaks['rss_tree_kib'] = max(peaks['rss_tree_kib'], sum(v[0] for v in values))
            peaks['pss_tree_kib'] = max(peaks['pss_tree_kib'], sum(v[1] for v in values))
            peaks['samples'] += 1
            stop.wait(.02)
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    started = time.perf_counter()
    try:
        if method.startswith(('beatthis-', 'beatnet-', 'beatnetplus-', 'allin1-', 'transformer-')):
            import torch
            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
        backend = Backend(method, workspace)
        load = time.perf_counter()-started
        audio = Audio(case, workspace/'derivatives')
        counts = []
        for _ in range(2):
            start = time.perf_counter()
            raw = backend(audio)
            counts.append(dict(beats=len(raw['beats']), downbeats=len(raw['downbeats']),
                               wall_seconds=time.perf_counter()-start))
            del raw
        output = dict(method=method, case=case['id'], duration=case['duration'],
                      load_wall_seconds=load, passes=counts,
                      exact_parent_peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                      largest_child_peak_rss_kib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                      sampled_tree=peaks, evaluation_imported='docs.dj.detector_comparison.metrics' in sys.modules,
                      caveat='RSS tree counts shared pages in each process; PSS distributes them. Sampling interval 20 ms.')
    except Exception as error:
        output = dict(method=method, error=repr(error), sampled_tree=peaks)
    finally:
        stop.set()
        sampler.join()
    write_json(root/'memory-results'/(method+'.json'), output)
    print(method, output, flush=True)
    return 1 if 'error' in output else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('method')
    args = parser.parse_args()
    raise SystemExit(profile(args.root, args.method))
