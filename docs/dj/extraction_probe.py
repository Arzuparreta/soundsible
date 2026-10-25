"""Compare P11 against a trusted pre-extraction revision, without personal data.

    .venv/bin/python -I docs/dj/extraction_probe.py --reference ad59b838

Executes the old monolithic source from Git with the same NumPy/FFmpeg as the
current code. No expectation is regenerated. Temporary SQLite rows are also
read in both directions without decoding; the analyser version must match.
"""
from __future__ import annotations

import argparse
import itertools
import json
import subprocess
import sys
import tempfile
import types
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from shared import dj_engine
from shared.dj import analysis, store
from shared.dj.contracts import fallback_analysis
from shared.ffmpeg_runtime import ffmpeg_executable


def signal(bpm=120, seconds=18, *, quiet=False):
    rate = 11025
    t = np.arange(round(rate * seconds)) / rate
    phase = np.mod(t - .25, 60 / bpm)
    samples = .4 * np.sin(2 * np.pi * 80 * t) * np.exp(-phase * 70)
    for frequency in (130.8128, 164.8138, 195.9977):
        samples += .06 * np.sin(2 * np.pi * frequency * t)
    if quiet:
        samples *= np.where((t < 64.25) | (t >= 176.25), .25, 1)
    return samples.astype(np.float32)


def measured(bpm=120, *, duration=240):
    period = 60 / bpm
    grid = [round(.25 + index * period, 4) for index in range(int((duration - .25) / period) + 1)]
    return {**fallback_analysis(duration), 'analysed': True, 'bpm': bpm,
            'bar_seconds': period * 4, 'confidence': .9, 'tempo_confidence': 1.,
            'key': 'C', 'mode': 'major', 'note_rate': 2., 'loudness_lufs': -14., 'spectral_flatness': .05,
            'beat_grid': grid, 'downbeats': grid[::4], 'phrase_boundaries': grid[::32],
            'intro_cue': .25, 'outro_cue': 192.25}


def compare(reference, directory):
    old = types.ModuleType('pre_p11_dj_engine')
    source = subprocess.check_output(['git', 'show', f'{reference}:shared/dj_engine.py'], cwd=ROOT, text=True)
    if 'def _compose(' not in source:
        raise ValueError('Choose a trusted pre-P11 monolithic revision, e.g. ad59b838')
    exec(compile(source, f'{reference}:shared/dj_engine.py', 'exec'), old.__dict__)
    assert old.ANALYSER_VERSION == dj_engine.ANALYSER_VERSION
    rate = 11025
    pcm = {
        'pulse-90': signal(90), 'pulse-137': signal(137),
        'silence': np.zeros(rate * 18, dtype=np.float32),
        'tone': (.2 * np.sin(2 * np.pi * 220 * np.arange(rate * 18) / rate)).astype(np.float32),
        'noise': np.random.default_rng(11).normal(0, .08, rate * 18).astype(np.float32),
        'sections': signal(seconds=240, quiet=True),
    }
    measured_rows = []
    for name, samples in pcm.items():
        kwargs = dict(duration=len(samples) / rate, tail_start=0., loudness_lufs=-14.)
        before = old._compose(samples, samples, rate, **kwargs)
        after = analysis._compose(samples, samples, rate, **kwargs)
        assert after == before, name
        measured_rows.append(before)
    head, tail = signal(seconds=90), signal(137, seconds=120)
    before = old._compose(tail, head, rate, duration=600, tail_start=480)
    assert analysis._compose(tail, head, rate, duration=600, tail_start=480) == before
    assert not any(90 < point < 480 for point in before['beat_grid'])
    measured_rows.append(before)

    # Cold data, zeroes, short files, half/double tempo, long blend, gap and
    # drift exercise the same ranking/selection boundary as the existing vectors.
    rows = [fallback_analysis(), fallback_analysis(240), *measured_rows]
    rows.extend(measured(bpm) for bpm in (55, 60, 90, 100, 106, 112, 120, 125, 130, 137, 173, 220))
    rows.extend([{**measured(), 'note_rate': 0., 'spectral_flatness': 0.}, measured(duration=90),
                 {**measured(), 'tempo_confidence': .6},
                 {**measured(), 'bpm': 0}, {**measured(), 'key': None, 'mode': None}])
    out, inc = measured(), measured(125)
    out['sections'] = [{'start': 176.25, 'end': 224.25, 'label': 'breakdown', 'level': .1},
                       {'start': 224.25, 'end': 240., 'label': 'outro', 'level': .1}]
    inc['sections'] = [{'start': .25, 'end': 16.25, 'label': 'intro', 'level': .1},
                       {'start': 16.25, 'end': 64.25, 'label': 'breakdown', 'level': .1}]
    rows.extend([out, inc])
    plans = 0
    for left, right in itertools.product(rows, repeat=2):
        assert dj_engine.plan_transition(left, right) == old.plan_transition(left, right)
        plans += 1
    routes = 0
    for seed in rows:
        pool = [({'id': str(index), 'score': .5 + (index % 3) / 5, 'source_pool': 'local' if index % 2 else 'related',
                  'semantic_score': (index % 4) / 4}, features) for index, features in enumerate(rows)]
        assert dj_engine.order_continuous_route(seed, pool) == old.order_continuous_route(seed, pool)
        for sequence in (None, ('related', 'local')):
            assert dj_engine.order_route(seed, pool, limit=8, source_sequence=sequence) == old.order_route(
                seed, pool, limit=8, source_sequence=sequence)
        for starts in (1, 3, 5):
            assert dj_engine.route_to_request(seed, pool[:6], pool[-1], max_starts=starts) == old.route_to_request(
                seed, pool[:6], pool[-1], max_starts=starts)
        routes += 6

    wav = directory / 'pulse.wav'
    with wave.open(str(wav), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes((pcm['pulse-137'] * 32767).astype('<i2').tobytes())
    aac = directory / 'pulse.m4a'
    subprocess.run([ffmpeg_executable(), '-v', 'error', '-i', str(wav), '-ar', '44100', '-c:a', 'aac', str(aac)],
                   check=True, timeout=30)
    old._cache_path = lambda: directory / 'analysis.sqlite3'
    decoded = 0
    with patch.object(store, '_cache_path', old._cache_path):
        for path in (wav, aac):
            with patch.object(old, '_decode_measured', wraps=old._decode_measured) as decoder:
                before = old.analyse_audio(path, f'old-{path.suffix}')
                assert decoder.call_count == 1
            with patch.object(store, '_analyse_pcm', side_effect=AssertionError('cache hit decoded')):
                assert store.analyse_audio(path, f'old-{path.suffix}') == before
            with patch.object(store, '_decode_measured', wraps=store._decode_measured) as decoder:
                assert store.analyse_audio(path, f'new-{path.suffix}') == before
                assert decoder.call_count == 1
            with patch.object(old, '_analyse_pcm', side_effect=AssertionError('cache hit decoded')):
                assert old.analyse_audio(path, f'new-{path.suffix}') == before
            decoded += 1
    return {'reference': reference, 'pcm_analyses_equal': len(measured_rows), 'plans_equal': plans,
            'routes_equal': routes, 'decoded_pcm_aac_equal': decoded, 'cache_reads_both_directions': decoded * 2,
            'analyser_version_unchanged': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='dj-p11-') as temporary:
        print(json.dumps(compare(args.reference, Path(temporary)), sort_keys=True))


if __name__ == '__main__':
    main()
