"""Check retained source-separation models against fresh one-shot processes.

Run after inference timings, never concurrently with a measured backend.
The check uses one frozen real input and does not establish platform parity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np

from .common import Audio, digest, load_snapshot, scratch, write_json


def compare(left, right):
    if left.shape != right.shape:
        return dict(equal=False, left_shape=list(left.shape), right_shape=list(right.shape))
    return dict(equal=bool(np.array_equal(left, right)), shape=list(left.shape),
                maximum_absolute_delta=float(np.max(np.abs(left-right), initial=0)))


def check(root):
    import soundfile as sf
    scratch(root)
    case = json.loads((root/'corpus/manifest.json').read_text())['cases'][0]
    audio = Audio(case, root/'derivatives')
    canonical = audio.wave(44100)
    target = root/'equivalence'
    target.mkdir(parents=True, exist_ok=True)
    output = dict(case=case['id'], input_sha256=digest(canonical), checks={})
    raw = json.loads((root/'results/allin1-fold0'/(case['id']+'.json')).read_text())['raw']
    configuration = raw['preprocessing_configuration']
    namespace = hashlib.sha256(json.dumps(configuration, sort_keys=True).encode()).hexdigest()[:16]
    retained = root/'separated'/(audio.identity+'-'+namespace)/'demix/htdemucs'/canonical.stem
    program = ('import random,sys,torch; from demucs import separate; '
               'torch.set_num_threads(1); torch.set_num_interop_threads(1); '
               'random.seed(1804); torch.manual_seed(1804); separate.main(sys.argv[1:])')
    started = time.perf_counter()
    subprocess.run([sys.executable, '-c', program, '--out', str(target/'fresh-demucs'),
                    '--name', 'htdemucs', '--device', 'cpu', str(canonical)], check=True)
    fresh = target/'fresh-demucs/htdemucs'/canonical.stem
    output['checks']['demucs_retained_vs_fresh'] = {
        name: compare(sf.read(retained/(name+'.wav'))[0], sf.read(fresh/(name+'.wav'))[0])
        for name in ['bass', 'drums', 'other', 'vocals']}
    output['fresh_demucs_wall_seconds'] = time.perf_counter()-started
    silence = next(c for c in json.loads((root/'corpus/manifest.json').read_text())['cases']
                   if c['id'] == 'synthetic_silence')
    checked = subprocess.run([sys.executable, '-c', program, '--out', str(target/'silence-demucs'),
                              '--name', 'htdemucs', '--device', 'cpu',
                              str(Audio(silence, root/'derivatives').wave(44100))],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    (target/'silence-upstream.log').write_text(checked.stdout)
    output['checks']['fresh_upstream_silence'] = dict(returncode=checked.returncode,
        assertion_reproduced='AssertionError' in checked.stdout,
        log_sha256=digest(target/'silence-upstream.log'))
    transformer = root/'results/transformer-fold0'/(case['id']+'.json')
    if transformer.exists() and not json.loads(transformer.read_text()).get('failure'):
        raw = json.loads(transformer.read_text())['raw']
        configuration = raw['preprocessing_configuration']
        namespace = hashlib.sha256(json.dumps(configuration, sort_keys=True).encode()).hexdigest()[:16]
        retained = root/'separated'/(audio.identity+'-'+namespace)/'spleeter232-mel128.npy'
        fresh = target/'fresh-spleeter.npy'
        subprocess.run([str(root/'spleeter232-venv/bin/python'),
                        str(Path(__file__).with_name('spleeter_frontend.py')),
                        str(canonical), str(fresh)], cwd=root, check=True)
        output['checks']['spleeter_worker_vs_fresh'] = compare(np.load(retained), np.load(fresh))
    else:
        output['checks']['spleeter_worker_vs_fresh'] = dict(unavailable=True)
    # Diagnostic only, outside the frozen accuracy matrix: the original P12
    # unit test synthesizes directly at 11025 Hz; the common corpus starts at
    # 44100 Hz and is resampled. Neither periodic signal identifies a bar.
    import importlib
    package = '_p12_uniform_diagnostic'
    load_snapshot(root/'snapshots/2ca8ccf2', package)
    compose = importlib.import_module(package+'.analysis')._compose
    uniform = next(c for c in json.loads((root/'corpus/manifest.json').read_text())['cases']
                   if c['id'] == 'synthetic_uniform_pulse')
    rate = 11025
    direct = np.zeros(72*rate, dtype=np.float32)
    t = np.arange(round(.1*rate))/rate
    hit = np.sin(2*np.pi*80*t)*np.exp(-t/.025)
    for at in np.arange(.25, 71, .5):
        start = round(at*rate)
        direct[start:start+len(hit)] += hit
    diagnoses = {}
    for name, samples in [('direct_11025', direct),
                          ('common_44100_resampled', Audio(uniform, root/'derivatives').samples(rate))]:
        native = compose(samples, samples, rate, duration=72, tail_start=0)
        diagnoses[name] = {key: native[key] for key in ['bpm', 'downbeats', 'metric_regions',
                                                       'metre_confidence', 'downbeat_confidence']}
    output['checks']['p12_uniform_sample_rate_diagnostic'] = diagnoses
    write_json(root/'frontend-equivalence.json', output)
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    check(parser.parse_args().root)
