"""Rescore retained events and export a compact, auditable method/case matrix."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

import numpy as np

from .common import Audio, digest, write_json
from .metrics import evaluate
from .run import refine


def average(values):
    values = [v for v in values if v is not None]
    return float(np.mean(values)) if values else None


def interval(values):
    values = np.asarray([v for v in values if v is not None])
    if not len(values):
        return None
    rng = np.random.default_rng(1804)
    means = values[rng.integers(0, len(values), (2000, len(values)))].mean(axis=1)
    return [float(v) for v in np.percentile(means, [2.5, 97.5])]


def summarize(rows):
    okay = [r for r in rows if 'metrics' in r and not r.get('failure')]
    beats = [r['metrics']['beat']['f1'] for r in okay]
    firsts = [r['metrics']['downbeat']['f1'] for r in okay if r['metrics']['downbeat'] is not None]
    positive_firsts = [r['metrics']['downbeat']['f1'] for r in okay
                       if r['metrics']['downbeat'] is not None and r['metrics']['downbeat']['reference'] > 0]
    timings = [(t, r['duration']) for r in okay for t in r['timings']]
    warm = [(r['timings'][-1], r['duration']) for r in okay if r['timings']]
    source_plus_decoder = [
        (source['cpu_seconds']+source['child_cpu_seconds']+decoder['cpu_seconds'])/r['duration']*60
        for r in okay for source, decoder in zip(r.get('shared_source_timings', []), r['timings'])]
    warm_cpu = [(t['cpu_seconds']+t['child_cpu_seconds'])/duration*60 for t, duration in warm]
    repeat_delta = []
    cache_ratio = []
    for row in okay:
        if len(row['timings']) < 2:
            continue
        first, second = [t['cpu_seconds']+t['child_cpu_seconds'] for t in row['timings'][:2]]
        if first > 0:
            cache_ratio.append(second/first)
        if 'preprocessing_cost' not in row['raw'] and first+second > 0:
            repeat_delta.append(abs(first-second)/((first+second)/2)*100)
    full_cost = []
    inference_cost = []
    for row in okay:
        raw = row['raw']
        if 'preprocessing_cost' in raw:
            pre = raw['preprocessing_cost']
            full_cost.append((pre['cpu_seconds']+raw['native_inference_cpu_seconds'])/row['duration']*60)
            inference_cost.append(raw['native_inference_cpu_seconds']/row['duration']*60)
        else:
            full_cost.extend((t['cpu_seconds']+t['child_cpu_seconds'])/row['duration']*60 for t in row['timings'])
            inference_cost.extend(t['cpu_seconds']/row['duration']*60 for t in row['timings'])
    return dict(cases=len(rows), completed=len(okay), failures=len(rows)-len(okay),
                beat_f1=average(beats), downbeat_f1=average(firsts),
                positive_downbeat_cases=len(positive_firsts),
                downbeat_f1_on_annotated_positive_cases=average(positive_firsts),
                beat_f1_bootstrap_95=interval(beats), downbeat_f1_bootstrap_95=interval(firsts),
                downbeat_abstention=average([r['metrics']['downbeat_abstention'] for r in okay]),
                downbeat_precision=average([r['metrics']['downbeat']['precision'] for r in okay if r['metrics']['downbeat'] is not None]),
                correct_grouping_coverage=average([r['metrics']['correct_grouping_coverage'] for r in okay]),
                subdivision_accuracy=average([r['metrics']['subdivision_accuracy'] for r in okay]),
                subdivision_coverage=average([r['metrics']['subdivision_coverage'] for r in okay]),
                correct_subdivision_coverage=average([r['metrics']['correct_subdivision_coverage'] for r in okay]),
                bar_duration_abs_error_percent=average([r['metrics']['bar_duration_abs_error_percent'] for r in okay]),
                beat_cmlt=average([r['metrics']['beat_continuity']['cmlt'] for r in okay if r['metrics']['beat_continuity']]),
                downbeat_cmlt=average([r['metrics']['downbeat_continuity']['cmlt'] for r in okay if r['metrics']['downbeat_continuity']]),
                tempo_abs_error_percent=average([abs(r['metrics']['tempo_error_percent']) for r in okay if r['metrics']['tempo_error_percent'] is not None]),
                matched_beat_p90_ms=average([r['metrics']['beat']['p90_ms'] for r in okay]),
                refined_matched_beat_p90_ms=average([r['refined_metrics']['beat']['p90_ms'] for r in okay]),
                refined_beat_f1=average([r['refined_metrics']['beat']['f1'] for r in okay]),
                refined_downbeat_f1=average([r['refined_metrics']['downbeat']['f1'] for r in okay if r['refined_metrics']['downbeat'] is not None]),
                refinement_cpu_seconds_per_audio_minute=average([r['rescored_refinement_cpu_seconds']/r['duration']*60 for r in okay if 'rescored_refinement_cpu_seconds' in r]),
                wall_seconds_per_audio_minute=average([t['wall_seconds']/duration*60 for t, duration in timings if not t.get('maintenance_interrupted')]),
                cpu_seconds_per_audio_minute=average([(t['cpu_seconds']+t['child_cpu_seconds'])/duration*60 for t, duration in timings]),
                warm_cpu_seconds_per_audio_minute=average([(t['cpu_seconds']+t['child_cpu_seconds'])/duration*60 for t, duration in warm]),
                warm_cpu_seconds_per_audio_minute_percentiles_10_50_90=[float(v) for v in np.percentile(warm_cpu, [10, 50, 90])] if warm_cpu else None,
                mean_second_to_first_cpu_ratio=average(cache_ratio),
                median_repeat_cpu_absolute_difference_percent=float(np.median(repeat_delta)) if repeat_delta else None,
                source_plus_decoder_cpu_seconds_per_audio_minute=average(source_plus_decoder),
                backend_with_separation_cpu_seconds_per_audio_minute=average(full_cost),
                cached_frontend_cpu_seconds_per_audio_minute=average(inference_cost),
                peak_rss_mib=max([t['process_peak_rss_kib']/1024 for t, _ in timings], default=0),
                unsupported_downbeat_events=sum(r['metrics'].get('unsupported_downbeat_events') or 0 for r in okay))


def report(root, target, manifest_path=None):
    manifest_path = manifest_path or root/'corpus/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    base = root/'results' if manifest_path.name == 'manifest.json' else root/'results'/manifest_path.stem
    cases = {c['id']: c for c in manifest['cases']}
    matrix = []
    summaries = {}
    for directory in sorted(base.iterdir()):
        if not (directory/'metadata.json').exists():
            continue
        rows = []
        for path in sorted(directory.glob('*.json')):
            if path.name == 'metadata.json':
                continue
            row = json.loads(path.read_text())
            case = cases[row['case']]
            if row.get('raw'):
                # Metrics-only fixes never require repeating a model inference.
                tolerance = manifest['tolerance_seconds']['synthetic' if case['dataset'] == 'synthetic' else 'real']
                raw = row['raw']
                row['metrics'] = evaluate(raw, case, tolerance)
                if raw.get('downbeat_capability') is False:
                    row['metrics']['downbeat'] = None
                    row['metrics']['downbeat_continuity'] = None
                start = time.process_time()
                aligned = refine(raw, Audio(case, root/'derivatives'), root)
                row['rescored_refinement_cpu_seconds'] = time.process_time()-start
                row['refined_metrics'] = evaluate(aligned, case, tolerance)
                if raw.get('downbeat_capability') is False:
                    row['refined_metrics']['downbeat'] = None
            compact = {k: v for k, v in row.items() if k not in ['raw', 'refined', 'failure']}
            if row.get('failure'):
                compact['failure'] = row['failure'].splitlines()[-1]
            compact['method'] = directory.name
            matrix.append(compact)
            rows.append(row)
        recorded = {r['case'] for r in rows}
        for case in manifest['cases']:
            if case['id'] in recorded:
                continue
            missing = dict(case=case['id'], method=directory.name, dataset=case['dataset'],
                           genre=case['genre'], split=case['split'], duration=case['duration'],
                           failure='not executed or not available; inspect backend admission/execution failure')
            rows.append(missing)
            matrix.append(missing)
        splits = sorted(set(r['split'] for r in rows))
        summaries[directory.name] = {split: summarize([r for r in rows if r['split'] == split]) for split in splits}
    result = dict(manifest_sha256=digest(manifest_path), summaries=summaries, matrix=matrix,
                  evaluation_files_sha256={name: digest(Path(__file__).with_name(name))
                                           for name in ['metrics.py', 'matching.py', 'run.py', 'report.py']},
                  limitations=['Case bootstrap intervals do not correct selection bias or small genre samples.',
                               'Wall time measured on a shared workstation; CPU time is also reported.',
                               'Experimental data moved to /mnt/storage during the run; interrupted wall samples are excluded. CPU excludes the maintenance suspension.',
                               'Model activations are not calibrated musical confidence.'])
    write_json(target, result)
    for method, groups in summaries.items():
        row = groups.get('test', {})
        print(method, row.get('completed'), row.get('beat_f1'), row.get('downbeat_f1'), row.get('cpu_seconds_per_audio_minute'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('target', type=Path)
    parser.add_argument('--manifest', type=Path)
    args = parser.parse_args()
    report(args.root, args.target, args.manifest)
