"""The integrated P12-b analyser on the frozen P12-a corpus, scored like every method.

Production path per case: FFmpeg decode at 22050 Hz (`store._decode_measured`),
Beat This! final0 through ONNX Runtime and the NumPy DBN (`beat_model.events`),
then the measures (`store._measure`). Scores three outputs separately: the
model's events, the final sample-aligned grid with its first beats, and the
first beats inside regions confirmed by independent evidence. No cache, no
network; reads the lab's manifest and audio.

  .venv/bin/python -I docs/dj/detector_comparison/integrated_probe.py LAB OUTPUT.json [DATASET ...]
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.metadata
import json
import platform
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from docs.dj.detector_comparison.metrics import evaluate  # noqa: E402
from shared.dj import beat_model, contracts, store, weights  # noqa: E402


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def frozen_manifest(path, reference):
    """Validate every input before inference; relocation is the only allowed change."""
    manifest = json.loads(Path(path).read_text())
    frozen = json.loads(Path(reference).read_text())
    def portable(value):
        return {**value, 'cases': [{k: v for k, v in case.items() if k not in ('file', 'annotation')}
                                  for case in value['cases']]}
    if portable(manifest) != portable(frozen):
        raise ValueError('Manifest differs from the frozen references')
    ids = [case['id'] for case in manifest['cases']]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate case identities')
    for case in manifest['cases']:
        if digest(case['file']) != case['file_sha256']:
            raise ValueError(f"Audio checksum mismatch: {case['id']}")
        if case.get('annotation_sha256'):
            annotation = Path(case['annotation'])
            if not annotation.is_absolute():
                annotation = Path(path).parent / annotation
            if digest(annotation) != case['annotation_sha256']:
                raise ValueError(f"Annotation checksum mismatch: {case['id']}")
    return manifest


def provenance(manifest, reference):
    sources = [*sorted((ROOT / 'shared/dj').glob('*.py')),
               *sorted(Path(__file__).parent.glob('*.py')), ROOT / 'tests/test_discovery_save_route.py']
    return dict(
        git_head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        analyser_version=contracts.ANALYSER_VERSION,
        source_sha256={str(p.relative_to(ROOT)): digest(p) for p in sources},
        manifest_sha256=digest(manifest), frozen_reference_sha256=digest(reference),
        python=sys.version, platform=platform.platform(), machine=platform.machine(),
        packages={name: importlib.metadata.version(name) for name in ('numpy', 'onnxruntime')},
        model_sha256=weights.MODEL_SHA256, model_bytes=weights.MODEL_BYTES,
        ffmpeg=subprocess.check_output([store.ffmpeg_executable(), '-version'], text=True).splitlines()[0],
        threads=dict(inference=1, inter_op=1),
    )


def confirmed(analysis):
    return [row for row in analysis['metric_regions']
            if row['beats_per_bar'] and row['metre_confidence'] > 0 and row['downbeat_confidence'] > 0]


def case_row(session, case, tolerance):
    path = Path(case['file'])
    cpu = time.process_time()
    samples, lufs = store._decode_measured(path, beat_model.SAMPLE_RATE)
    if samples is None:
        raise RuntimeError(f"Decode failed: {case['id']}")
    decode_cpu = time.process_time() - cpu
    duration = samples.size / beat_model.SAMPLE_RATE
    cpu = time.process_time()
    model = beat_model.events(session, samples)
    model_cpu = time.process_time() - cpu
    cpu = time.process_time()
    analysis = store._measure(samples, samples, beat_model.SAMPLE_RATE, duration=duration, tail_start=0.0,
                              loudness_lufs=lufs, events=(model, model))
    measure_cpu = time.process_time() - cpu
    minutes = duration / 60
    model_result = dict(beats=model[0].tolist(), downbeats=model[1].tolist(), regions=[],
                        bpm=60 / float(np.median(np.diff(model[0]))) if len(model[0]) > 1 else None)
    grid_result = dict(beats=analysis['beat_grid'], downbeats=analysis['downbeats'],
                       regions=analysis['metric_regions'], bpm=analysis['bpm'] or None)
    row = dict(case=case['id'], dataset=case['dataset'], split=case['split'], genre=case['genre'],
               duration=duration, bpm=analysis['bpm'], tempo_confidence=analysis['tempo_confidence'],
               model=evaluate(model_result, case, tolerance), grid=evaluate(grid_result, case, tolerance),
               analysis=analysis, model_events=model_result,
               audio_sha256=case['file_sha256'], tolerance_seconds=tolerance,
               cpu_seconds_per_audio_minute=dict(decode=decode_cpu / minutes, model=model_cpu / minutes,
                                                 measures=measure_cpu / minutes))
    regions = confirmed(analysis)
    row['confirmed_coverage'] = sum(r['end'] - r['start'] for r in regions) / max(duration, 1e-9)
    firsts = case.get('downbeats')
    if firsts is not None:
        # Regions share boundaries: count each claimed first beat once, with
        # the same annotated-window clipping as the model/grid metrics.
        claimed = dict(beats=analysis['beat_grid'], downbeats=sorted({t for r in regions for t in r['downbeats']}),
                       regions=regions, bpm=analysis['bpm'] or None)
        scored = evaluate(claimed, case, tolerance)['downbeat']
        # A confirmed first beat that matches no annotated one is a false certainty.
        row['confirmed_first_precision'] = scored['precision'] if scored else None
        row['confirmed_firsts'] = scored['predicted'] if scored else 0
        row['confirmed_false_firsts'] = scored['predicted'] - scored['matched'] if scored else 0
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
            confirmed_false_firsts=sum(r.get('confirmed_false_firsts') or 0 for r in group),
            confirmed_first_micro_precision=(
                1 - sum(r.get('confirmed_false_firsts') or 0 for r in group) / sum(r.get('confirmed_firsts') or 0 for r in group)
                if any(r.get('confirmed_firsts') for r in group) else None),
            reliable_pulse_cases=sum(r['tempo_confidence'] > .6 for r in group),
            reliable_pulse_wrong_tempo_cases=[r['case'] for r in group if r['tempo_confidence'] > .6
                                            and r['grid'].get('tempo_error_percent') is not None
                                            and abs(r['grid']['tempo_error_percent']) >= 4],
            model_cpu_seconds_per_audio_minute=mean(r['cpu_seconds_per_audio_minute']['model'] for r in group),
            measures_cpu_seconds_per_audio_minute=mean(r['cpu_seconds_per_audio_minute']['measures'] for r in group),
        )
    return result


def compare(rows, baseline):
    previous = {r['case']: r for r in baseline['rows']}
    if (set(previous) != {r['case'] for r in rows}
            or len(previous) != len(baseline['rows']) or len(previous) != len(rows)):
        raise ValueError('Baseline case cohort differs')
    changes = []
    for row in rows:
        old = previous[row['case']]
        before = {k: old[k] for k in ('bpm', 'tempo_confidence', 'model', 'grid')}
        after = {k: row[k] for k in before}
        if before != after:
            changes.append(dict(case=row['case'], before=before, after=after))
    return dict(cases=len(rows), changed_cases=changes,
                baseline_provenance=baseline.get('provenance', 'Not recorded in the archived report'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lab', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('datasets', nargs='*')
    parser.add_argument('--aac', action='store_true', help='Use the five frozen AAC diagnostics')
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    lab, output = args.lab, args.output
    reference = Path(__file__).parent / 'results' / ('aac-references.json' if args.aac else 'manifest-references.json')
    manifest_path = lab / 'corpus' / ('aac.json' if args.aac else 'manifest.json')
    manifest = frozen_manifest(manifest_path, reference)
    only = set(args.datasets)
    if only:
        manifest['cases'] = [case for case in manifest['cases'] if case['dataset'] in only]
    # A measurement run must use prepared, verified bytes; never download a
    # model or write the station cache as a side effect of the probe.
    model_path = weights.model_path(download=False)
    session = weights._open(model_path) if model_path is not None else None
    if session is None:
        raise SystemExit('DJ beat model unavailable: run scripts/fetch_dj_model.py')
    rows = []
    for case in manifest['cases']:
        tolerance = manifest['tolerance_seconds']['synthetic' if case['dataset'] == 'synthetic' else 'real']
        rows.append(case_row(session, case, tolerance))
        print(case['id'], rows[-1]['grid']['beat']['f1'], flush=True)
    report = dict(method='integrated P12-b analyser (FFmpeg 22050 Hz, Beat This! final0 ONNX, NumPy DBN, P1 grid)',
                  provenance=provenance(manifest_path, reference),
                  model_sha256=weights.MODEL_SHA256, summary=summary(rows, 'grid'), rows=rows)
    if args.baseline:
        report['comparison'] = compare(rows, json.loads(args.baseline.read_text()))
        report['comparison']['baseline_sha256'] = digest(args.baseline)
    payload = (json.dumps(report, indent=2, allow_nan=False) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(gzip.compress(payload, mtime=0) if output.suffix == '.gz' else payload)
    print(json.dumps(report['summary'], indent=2))


if __name__ == '__main__':
    main()
