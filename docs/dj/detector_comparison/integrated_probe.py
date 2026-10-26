"""The integrated P12-b analyser on the frozen P12-a corpus, scored like every method.

Production path per case: FFmpeg decode at 22050 Hz (`store._decode_measured`),
Beat This! final0 through ONNX Runtime and the NumPy DBN (`beat_model.events`),
then the measures (`store._measure`). Scores three outputs separately: the
model's events, the final sample-aligned grid with its first beats, and the
first beats inside regions confirmed by independent evidence. No cache, no
network; reads the lab's manifest and audio.

  .venv/bin/python -I docs/dj/detector_comparison/integrated_probe.py LAB OUTPUT.json
"""
from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from docs.dj.detector_comparison.metrics import evaluate, events as match  # noqa: E402
from shared.dj import beat_model, store, weights  # noqa: E402


def confirmed(analysis):
    return [row for row in analysis['metric_regions']
            if row['beats_per_bar'] and row['metre_confidence'] > 0 and row['downbeat_confidence'] > 0]


def case_row(session, case, tolerance):
    path = Path(case['file'])
    cpu = time.process_time()
    samples, _ = store._decode_measured(path, beat_model.SAMPLE_RATE)
    decode_cpu = time.process_time() - cpu
    duration = samples.size / beat_model.SAMPLE_RATE
    cpu = time.process_time()
    model = beat_model.events(session, samples)
    model_cpu = time.process_time() - cpu
    cpu = time.process_time()
    analysis = store._measure(samples, samples, beat_model.SAMPLE_RATE, duration=duration, tail_start=0.0,
                              loudness_lufs=None, events=(model, model))
    measure_cpu = time.process_time() - cpu
    minutes = duration / 60
    model_result = dict(beats=model[0].tolist(), downbeats=model[1].tolist(), regions=[],
                        bpm=60 / float(np.median(np.diff(model[0]))) if len(model[0]) > 1 else None)
    grid_result = dict(beats=analysis['beat_grid'], downbeats=analysis['downbeats'],
                       regions=analysis['metric_regions'], bpm=analysis['bpm'] or None)
    row = dict(case=case['id'], dataset=case['dataset'], split=case['split'], genre=case['genre'],
               duration=duration, bpm=analysis['bpm'], tempo_confidence=analysis['tempo_confidence'],
               model=evaluate(model_result, case, tolerance), grid=evaluate(grid_result, case, tolerance),
               cpu_seconds_per_audio_minute=dict(decode=decode_cpu / minutes, model=model_cpu / minutes,
                                                 measures=measure_cpu / minutes))
    regions = confirmed(analysis)
    row['confirmed_coverage'] = sum(r['end'] - r['start'] for r in regions) / max(duration, 1e-9)
    firsts = case.get('downbeats')
    if firsts is not None:
        inside = [t for r in regions for t in r['downbeats']]
        # A confirmed first beat that matches no annotated one is a false certainty.
        scored = match(inside, firsts, tolerance) if inside else None
        row['confirmed_first_precision'] = scored['precision'] if scored else None
        row['confirmed_firsts'] = len(inside)
    return row


def summary(rows, key):
    def mean(values):
        values = [v for v in values if v is not None]
        return round(statistics.mean(values), 4) if values else None
    result = {}
    for (dataset, split) in sorted({(r['dataset'], r['split']) for r in rows}):
        group = [r for r in rows if (r['dataset'], r['split']) == (dataset, split)]
        result[f'{dataset}/{split}'] = dict(
            cases=len(group),
            model_beat_f1=mean(r['model']['beat']['f1'] for r in group),
            model_first_f1=mean(r['model']['downbeat']['f1'] if r['model'].get('downbeat') else None for r in group),
            grid_beat_f1=mean(r['grid']['beat']['f1'] for r in group),
            grid_first_f1=mean(r['grid']['downbeat']['f1'] if r['grid'].get('downbeat') else None for r in group),
            grid_beat_p90_ms=mean(r['grid']['beat'].get('p90_ms') for r in group),
            tempo_within_4_percent=sum(1 for r in group if r['grid'].get('tempo_error_percent') is not None
                                       and abs(r['grid']['tempo_error_percent']) < 4),
            confirmed_coverage=mean(r['confirmed_coverage'] for r in group),
            confirmed_firsts=sum(r.get('confirmed_firsts') or 0 for r in group),
            confirmed_first_precision=mean(r.get('confirmed_first_precision') for r in group),
            model_cpu_seconds_per_audio_minute=mean(r['cpu_seconds_per_audio_minute']['model'] for r in group),
            measures_cpu_seconds_per_audio_minute=mean(r['cpu_seconds_per_audio_minute']['measures'] for r in group),
        )
    return result


def main():
    lab, output = Path(sys.argv[1]), Path(sys.argv[2])
    manifest = json.loads((lab / 'corpus' / 'manifest.json').read_text())
    session = weights.session()
    if session is None:
        raise SystemExit('DJ beat model unavailable: run scripts/fetch_dj_model.py')
    rows = []
    for case in manifest['cases']:
        tolerance = manifest['tolerance_seconds']['synthetic' if case['dataset'] == 'synthetic' else 'real']
        rows.append(case_row(session, case, tolerance))
        print(case['id'], rows[-1]['grid']['beat']['f1'], flush=True)
    report = dict(method='integrated P12-b analyser (FFmpeg 22050 Hz, Beat This! final0 ONNX, NumPy DBN, P1 grid)',
                  model_sha256=weights.MODEL_SHA256, summary=summary(rows, 'grid'), rows=rows)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['summary'], indent=2))


if __name__ == '__main__':
    main()
