"""Run one backend at a time and retain predictions, activations and failures.

python -m docs.dj.detector_comparison.run ROOT METHOD --repeats 2
"""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import signal
import sys
import time
import traceback

import numpy as np

from .adapters import Backend
from .common import Audio, digest, load_snapshot, result, scratch, write_json
from .metrics import evaluate


def timeout_handler(signum, frame):
    raise TimeoutError('Backend exceeded the frozen per-case timeout')


def refine(raw, audio, root):
    """Same P1 attack alignment for all backends; no pulse/octave correction."""
    if len(raw['beats']) < 4:
        return raw
    name = '_p12_refinement_snapshot'
    if name not in sys.modules:
        load_snapshot(Path(root)/'snapshots/2ca8ccf2', name)
    rhythm = importlib.import_module(name+'.rhythm')
    samples = audio.samples(11025)
    old = np.asarray(raw['beats'])
    # Local mode avoids falsely straightening real tempo changes. No backend
    # gets phase settlement, octave changes, or different search tolerances.
    grid = rhythm._align_attacks(samples, 11025, old,
                                 rhythm._attack_floor(samples, rhythm._ATTACK_PREEMPHASIS), constant=False)
    valid = (grid >= 0) & (grid <= audio.case['duration'])
    bars = [float(grid[int(np.argmin(abs(old-t)))]) for t in raw['downbeats']]
    bars = sorted(set(t for t in bars if 0 <= t <= audio.case['duration']))
    return result(grid[valid], bars, duration=audio.case['duration'], regions=raw['regions'])


def run(args):
    root = args.root
    scratch(root)
    manifest_path = args.manifest or root/'corpus/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    output = root/'results'/args.method if not args.manifest else root/'results'/manifest_path.stem/args.method
    output.mkdir(parents=True, exist_ok=True)
    versions = {d.metadata['Name']: d.version for d in importlib.metadata.distributions()}
    metadata = dict(method=args.method, manifest_sha256=digest(manifest_path), python=sys.version,
                    packages=versions, threads=1, repeats=args.repeats,
                    load_average=os.getloadavg(), memory_available=Path('/proc/meminfo').read_text(),
                    adapter_sha256=digest(Path(__file__).with_name('adapters.py')),
                    timeout_seconds=args.timeout)
    metadata['harness_files'] = {p.name: digest(p) for p in sorted(Path(__file__).parent.glob('*.py'))}
    if (output/'metadata.json').exists():
        previous = json.loads((output/'metadata.json').read_text())
        if previous.get('manifest_sha256') != metadata['manifest_sha256']:
            raise ValueError('Existing results belong to a different frozen manifest; use a new experiment directory')
        metadata['previous_runs'] = previous.get('previous_runs', [])+[
            {k: v for k, v in previous.items() if k != 'previous_runs'}]
    metadata['resumed_existing_cases'] = len([p for p in output.glob('*.json') if p.name != 'metadata.json'])
    wall, cpu = time.perf_counter(), time.process_time()
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(args.timeout)
    try:
        if args.method.startswith(('beatthis-', 'beatnet-', 'beatnetplus-', 'allin1-', 'transformer-')):
            import torch
            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
        backend = Backend(args.method, root)
    except Exception:
        signal.alarm(0)
        metadata['admission_failure'] = traceback.format_exc()
        write_json(output/'metadata.json', metadata)
        print(metadata['admission_failure'], flush=True)
        return 2
    signal.alarm(0)
    metadata.update(load_wall_seconds=time.perf_counter()-wall,
                    load_cpu_seconds=time.process_time()-cpu+getattr(backend.call, 'load_child_cpu_seconds', 0.))
    write_json(output/'metadata.json', metadata)
    selected = manifest['cases'][:args.limit] if args.limit else manifest['cases']
    failures = 0
    for case in selected:
        target = output/(case['id']+'.json')
        if target.exists() and not args.overwrite:
            continue
        scratch(root)
        if digest(case['file']) != case['file_sha256']:
            raise ValueError('Input changed after freeze: '+case['id'])
        audio = Audio(case, root/'derivatives')
        row = dict(case=case['id'], manifest_sha256=digest(manifest_path), dataset=case['dataset'], genre=case['genre'], split=case['split'],
                   duration=case['duration'], timings=[])
        try:
            for repetition in range(args.repeats):
                signal.alarm(args.timeout)
                wall, cpu, child = time.perf_counter(), time.process_time(), resource.getrusage(resource.RUSAGE_CHILDREN)
                raw = backend(audio)
                elapsed, consumed = time.perf_counter()-wall, time.process_time()-cpu
                signal.alarm(0)
                child_after = resource.getrusage(resource.RUSAGE_CHILDREN)
                row['timings'].append(dict(wall_seconds=elapsed, cpu_seconds=consumed,
                                           child_cpu_seconds=child_after.ru_utime+child_after.ru_stime-child.ru_utime-child.ru_stime+raw.get('active_child_cpu_seconds', 0.),
                                           process_peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                                           child_peak_rss_kib=child_after.ru_maxrss))
                activation = raw.pop('activations', None)
                if repetition == 0:
                    if activation is not None:
                        np.savez_compressed(output/(case['id']+'.npz'), **activation if isinstance(activation, dict) else dict(activation=activation))
                    row['raw'] = raw
                    tolerance = manifest['tolerance_seconds']['synthetic' if case['dataset'] == 'synthetic' else 'real']
                    row['metrics'] = evaluate(raw, case, tolerance)
                    start = time.perf_counter()
                    aligned = refine(raw, audio, root)
                    row['refinement_wall_seconds'] = time.perf_counter()-start
                    row['refined'] = aligned
                    row['refined_metrics'] = evaluate(aligned, case, tolerance)
                else:
                    row['repeat_event_max_delta_seconds'] = max(
                        [float(np.max(np.abs(np.asarray(raw[k])-np.asarray(row['raw'][k]))))
                         if len(raw[k]) == len(row['raw'][k]) and len(raw[k]) else
                         (0. if len(raw[k]) == len(row['raw'][k]) else None) for k in ['beats', 'downbeats']],
                        key=lambda v: float('inf') if v is None else v)
        except Exception:
            row['failure'] = traceback.format_exc()
        finally:
            signal.alarm(0)
        write_json(target, row)
        failures = failures+1 if row.get('failure') else 0
        print(args.method, case['id'], 'FAIL' if row.get('failure') else
              f"beat={row['metrics']['beat']['f1']} downbeat={row['metrics']['downbeat']['f1'] if row['metrics']['downbeat'] else None} {row['timings'][0]['wall_seconds']:.2f}s", flush=True)
        if failures >= args.max_consecutive_failures:
            metadata['execution_stopped_after_consecutive_failures'] = failures
            break
    metadata['final_load_average'] = os.getloadavg()
    write_json(output/'metadata.json', metadata)
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('method')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--max-consecutive-failures', type=int, default=3)
    parser.add_argument('--overwrite', action='store_true')
    raise SystemExit(run(parser.parse_args()))
