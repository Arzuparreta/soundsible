"""Freeze the corpus before inference. No audio is distributed in Git."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import urllib.request

import numpy as np
import soundfile as sf

from .common import digest, write_json


def prepare(root, ballroom_manifest=None):
    root = Path(root)
    corpus = root/'corpus'
    cases = []
    real = json.loads((corpus/'gtzan-manifest.json').read_text())
    for item in real['cases']:
        data = np.loadtxt(item['annotation'], ndmin=2)
        info = sf.info(item['file'])
        cases.append({**item, 'duration': info.duration, 'beats': data[:, 0].tolist(),
                      'downbeats': data[data[:, 1] == 1, 0].tolist() if data.shape[1] > 1 and np.any(data[:, 1] == 1) else None,
                      'subdivision': None})
    ann_rev = '826c2eadb7d89e8fbcc655477416f8b3d3ff1c0e'
    ballroom_manifest = ballroom_manifest or root/'corpus/ballroom-manifest.json'
    for item in json.loads(Path(ballroom_manifest).read_text()):
        annotation = corpus/item['annotation']
        url = f'https://raw.githubusercontent.com/CPJKU/BallroomAnnotations/{ann_rev}/{item["annotation"]}'
        if not annotation.exists():
            annotation.write_bytes(urllib.request.urlopen(url, timeout=30).read())
        data = np.loadtxt(annotation, ndmin=2)
        cases.append({**item, 'id': 'ballroom_'+Path(item['file']).stem, 'dataset': 'Ballroom',
                      'split': 'seen_diagnostic', 'annotation_url': url,
                      'file_sha256': digest(item['file']), 'annotation_sha256': digest(annotation),
                      'duration': sf.info(item['file']).duration, 'beats': data[:, 0].tolist(),
                      'downbeats': data[data[:, 1] == 1, 0].tolist(), 'subdivision': None})
    # The existing signal generator is frozen at #394, rather than adjusted
    # after looking at a candidate. Render at 44.1 kHz for every backend.
    source = root/'snapshots/2ca8ccf2/tests/test_dj_metre.py'
    namespace = {}
    text = source.read_text().split('\ndef analyse_signal', 1)[0]
    text = text.replace('import pytest', '').replace('from shared.dj.analysis import _compose', '')
    exec(compile(text, str(source), 'exec'), namespace)
    namespace['RATE'] = rate = 44100
    signal = namespace['metric_signal']
    variants = [('plain', {}), ('pickup_weak_one', dict(first=.83, pickup=1, weak_first=True)),
                ('syncopated', dict(syncopated=True)), ('drift', dict(drift=.015))]
    for size, subdivision in [(3, 2), (4, 2), (2, 3)]:
        for label, options in variants:
            audio, beats, bars = signal(beats_per_bar=size, subdivision=subdivision, **options)
            cases.append(save_signal(corpus, f'synthetic_{size}_{subdivision}_{label}', audio, rate, beats, bars,
                                     subdivision=None if size == 2 and label == 'syncopated' else subdivision,
                                     options=dict(beats_per_bar=size, subdivision=subdivision, **options)))
    for label, options in [('change_aligned', dict(change=(36.25, 3))),
                           ('change_unaligned', dict(change=(30.75, 3)))]:
        audio, beats, bars = signal(**options)
        cases.append(save_signal(corpus, 'synthetic_'+label, audio, rate, beats, bars, options=options))
    for label in ['silence', 'tone', 'uniform_pulse']:
        audio = np.zeros(72*rate, dtype=np.float32)
        beats = []
        if label == 'tone':
            audio[:] = .1*np.sin(2*np.pi*440*np.arange(len(audio))/rate)
        if label == 'uniform_pulse':
            t = np.arange(round(.1*rate))/rate
            hit = np.sin(2*np.pi*80*t)*np.exp(-t/.025)
            beats = np.arange(.25, 71, .5)
            for at in beats:
                start = round(at*rate)
                audio[start:start+len(hit)] += hit
        cases.append(save_signal(corpus, 'synthetic_'+label, audio, rate, beats, [], options=dict(kind=label)))
    # P13 preparation: the reference declares physical content-change limits,
    # not a guessed musical label such as drop/build. Not used to tune rhythm.
    for phrase_bars in [4, 8, 16]:
        audio, beats, bars = signal(seconds=132.)
        boundaries = bars[::phrase_bars]
        for index, at in enumerate(boundaries):
            stop = boundaries[index+1] if index+1 < len(boundaries) else len(audio)/rate
            if index % 2:
                start, end = round(at*rate), round(stop*rate)
                t = np.arange(end-start)/rate
                audio[start:end] += .04*np.sin(2*np.pi*880*t)
        cases.append(save_signal(corpus, f'structure_{phrase_bars}_bars', audio, rate, beats, bars,
                                 options=dict(phrase_bars=phrase_bars), structure_boundaries=boundaries.tolist()))
    manifest = dict(schema=1, tolerance_seconds=dict(real=.07, synthetic=.01),
                    protocol='All cases fixed before candidate inference; dev/test never used for tuning.',
                    gtzan_audio_revision=real['audio_revision'], gtzan_annotation_revision=real['annotation_revision'],
                    synthetic_source_sha256=digest(source), cases=cases)
    path = corpus/'manifest.json'
    if path.exists() and json.loads(path.read_text()) != manifest:
        raise RuntimeError('Frozen manifest differs; create a new experiment instead of overwriting')
    write_json(path, manifest)
    print(f'{len(cases)} cases; manifest SHA256 {digest(path)}', flush=True)


def save_signal(corpus, name, audio, rate, beats, bars, **extra):
    path = corpus/(name+'.wav')
    sf.write(path, audio, rate, subtype='FLOAT')
    return dict(id=name, file=str(path), file_sha256=digest(path), dataset='synthetic',
                split='known_signal', genre='synthetic', duration=len(audio)/rate,
                beats=np.asarray(beats).tolist(), downbeats=np.asarray(bars).tolist(), **extra)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--ballroom-manifest', type=Path)
    args = parser.parse_args()
    prepare(args.root, args.ballroom_manifest)
