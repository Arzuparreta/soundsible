"""Publish compact evidence without copying recordings, weights or caches."""
from __future__ import annotations

import argparse
import csv
import gzip
import json
from pathlib import Path

from .common import digest, write_json
from .metrics import evaluate
from .report import average, interval, report


def compressed(path, value):
    path.write_bytes(gzip.compress(json.dumps(value, separators=(',', ':'), allow_nan=False).encode(), mtime=0))


def number(value, digits=3):
    return '—' if value is None else f'{value:.{digits}f}'


def runtime(summary):
    value = summary.get('source_plus_decoder_cpu_seconds_per_audio_minute')
    if value is not None:
        return value, 'suma fuente + decoder; no pipeline nuevo cronometrado'
    return summary.get('backend_with_separation_cpu_seconds_per_audio_minute'), 'backend, incluida separación si la requiere'


def assets(root, method):
    files = []
    source = method.removesuffix('-common')
    if source.startswith('beatthis-'):
        name = source.split('-')[1]
        file = root/'checkpoints'/(name+'.ckpt')
        if not file.exists():
            file = Path.home()/'.cache/torch/hub/checkpoints'/('beat_this-'+name+'.ckpt')
        files = [file]
    elif source.startswith('beatnet-'):
        files = [root/'sources/mjhydri_BeatNet/src/BeatNet/models'/('model_'+source.split('-')[1]+'_weights.pt')]
    elif source.startswith('beatnetplus-'):
        filename = {'generic': 'generic_weights.pt', 'main': 'generic_main_weights.pt',
                    'nonpercussive': 'af_non_percussive_weights.pt'}[source.split('-')[1]]
        files = [root/'sources/mjhydri_BeatNet-Plus/src/BeatNetPlus/models'/filename]
    elif source.startswith('madmom-'):
        repo = 'imcmurray_madmom-modern' if source.startswith('madmom-modern') else 'CPJKU_madmom'
        files = sorted((root/'sources'/repo/'madmom/models/downbeats/2016').glob('downbeats_blstm_[1-8].pkl'))
    elif source.startswith('allin1-'):
        files = sorted((root/'checkpoints').glob('harmonix-fold*.pth')) if source.endswith('-all') else [root/'checkpoints/harmonix-fold0-0vra4ys2.pth']
        files += [Path.home()/'.cache/torch/hub/checkpoints/955717e8-8726e21a.th']
    elif source.startswith('transformer-'):
        files = [root/'sources/zhaojw1998_Beat-Transformer/checkpoint/fold_0_trf_param.pt']
        files += sorted(p for p in (root/'pretrained_models/5stems').iterdir() if p.is_file())
    return dict(method=method, external_weight_bytes=sum(p.stat().st_size for p in files),
                files=[dict(path=str(p), bytes=p.stat().st_size, sha256=digest(p)) for p in files])


def dependency_key(method):
    if method.startswith('beatthis-'):
        return 'beatthis-dbn' if method.endswith(('-dbn', '-common')) else 'beatthis'
    if method.startswith('madmom-'):
        return 'madmom-modern' if method.startswith('madmom-modern') else 'madmom'
    for family in ['beatnetplus', 'beatnet', 'allin1', 'transformer', 'essentia', 'librosa']:
        if method.startswith(family+'-'):
            return family
    return 'joint-dbn' if method == 'joint-dbn' else None


def compatibility(root):
    manifest = json.loads((root/'corpus/compatibility.json').read_text())
    cases = {case['id']: case for case in manifest['cases']}
    rows = []
    for directory in sorted((root/'results/compatibility').iterdir()):
        if not (directory/'metadata.json').exists():
            continue
        for path in sorted(directory.glob('*.json')):
            if path.name == 'metadata.json':
                continue
            current = json.loads(path.read_text())
            original_path = root/'results'/directory.name/path.name
            row = dict(method=directory.name, case=current['case'])
            if current.get('failure') or not original_path.exists():
                row['failure'] = current.get('failure') or 'Reference inference unavailable'
            else:
                original = json.loads(original_path.read_text())
                if original.get('failure'):
                    row['failure'] = 'Reference inference failed'
                else:
                    case = cases[current['case']]
                    row['input_sha256'] = case['file_sha256']
                    for kind in ['beats', 'downbeats']:
                        left, right = original['raw'][kind], current['raw'][kind]
                        row[kind] = dict(reference_events=len(left), current_events=len(right), identical=left == right,
                            maximum_absolute_delta_seconds=max((abs(a-b) for a, b in zip(left, right)), default=0.) if len(left) == len(right) else None)
                    tolerance = manifest['tolerance_seconds']['synthetic' if case['dataset'] == 'synthetic' else 'real']
                    row['reference_metrics'] = evaluate(original['raw'], case, tolerance)
                    row['current_metrics'] = evaluate(current['raw'], case, tolerance)
            rows.append(row)
        recorded = {row['case'] for row in rows if row['method'] == directory.name}
        metadata = json.loads((directory/'metadata.json').read_text())
        for case in manifest['cases']:
            if case['id'] not in recorded:
                rows.append(dict(method=directory.name, case=case['id'],
                                 failure=metadata.get('admission_failure') or 'Not executed'))
    return dict(results=rows, scope='Three frozen inputs per configuration on Python 3.14; event comparison with the measured interpreter, not full-corpus or platform parity.')


def export(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    main = json.loads((root/'comparison-results.json').read_text())
    aac_path = root/'aac-comparison-results.json'
    report(root, aac_path, root/'corpus/aac.json')
    aac = json.loads(aac_path.read_text())
    write_json(destination/'summaries.json', dict(manifest_sha256=main['manifest_sha256'],
                summaries=main['summaries'], evaluation_files_sha256=main['evaluation_files_sha256'],
                limitations=main['limitations'], aac_summaries=aac['summaries']))
    compressed(destination/'matrix.json.gz', dict(main=main['matrix'], aac=aac['matrix']))
    fields = ['method', 'case', 'dataset', 'genre', 'split', 'failure', 'beat_f1', 'downbeat_f1',
              'downbeat_precision', 'downbeat_recall', 'grouping_coverage', 'correct_grouping_coverage',
              'subdivision_accuracy', 'subdivision_coverage', 'correct_subdivision_coverage',
              'bar_duration_abs_error_percent', 'tempo_error_percent', 'refined_beat_f1',
              'refined_downbeat_f1', 'matched_beat_p90_ms', 'refined_matched_beat_p90_ms']
    with (destination/'method-case.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in main['matrix']:
            output = {k: row.get(k) for k in fields[:6]}
            metrics, refined = row.get('metrics', {}), row.get('refined_metrics', {})
            output.update({k: metrics.get(k) for k in fields[11:17]})
            for kind in ['beat', 'downbeat']:
                native = metrics.get(kind) or {}
                output[kind+'_f1'] = native.get('f1')
                output['refined_'+kind+'_f1'] = (refined.get(kind) or {}).get('f1')
                if kind == 'downbeat':
                    output['downbeat_precision'], output['downbeat_recall'] = native.get('precision'), native.get('recall')
            output['matched_beat_p90_ms'] = (metrics.get('beat') or {}).get('p90_ms')
            output['refined_matched_beat_p90_ms'] = (refined.get('beat') or {}).get('p90_ms')
            output['grouping_coverage'] = metrics.get('grouping_coverage')
            writer.writerow(output)
    retained = []
    metadata = {}
    for name, base in [('main', root/'results'), ('aac', root/'results/aac'), ('compatibility', root/'results/compatibility')]:
        for directory in sorted(base.iterdir()):
            if not (directory/'metadata.json').exists():
                continue
            method = directory.name
            metadata[name+'/'+method] = json.loads((directory/'metadata.json').read_text())
            for file in sorted(directory.glob('*.json')):
                if file.name == 'metadata.json':
                    continue
                row = json.loads(file.read_text())
                raw = row.get('raw', {})
                retained.append(dict(manifest=name, method=method, case=row['case'],
                    raw={k: raw[k] for k in ['beats', 'downbeats', 'regions', 'bpm', 'activation_kind',
                        'preprocessing_cost', 'native_inference_cpu_seconds', 'native_inference_wall_seconds',
                        'neural_forward_cost', 'structure_segments', 'separation_cache_hit', 'downbeat_capability'] if k in raw},
                    refined={k: row.get('refined', {}).get(k) for k in ['beats', 'downbeats', 'regions', 'bpm']},
                    timings=row.get('timings'), failure=row.get('failure'),
                    repeat_event_max_delta_seconds=row.get('repeat_event_max_delta_seconds'),
                    record_sha256=digest(file)))
    compressed(destination/'observations.json.gz', retained)
    compressed(destination/'environments.json.gz', metadata)
    for name in ['manifest', 'aac', 'compatibility']:
        frozen = json.loads((root/'corpus'/(name+'.json')).read_text())
        for case in frozen['cases']:
            case['file'] = Path(case['file']).name
        write_json(destination/(name+'-references.json'), frozen)
    for name in ['experiment', 'additional-experiment', 'inventory', 'training-overlap',
                 'madmom-downbeat-parameter-parity', 'pipeline-results', 'calibration-results',
                 'structure-results', 'frontend-equivalence', 'frontend-costs', 'disk-maintenance', 'hardware']:
        path = root/(name+'.json')
        if path.exists():
            write_json(destination/(name+'.json'), json.loads(path.read_text()))
    actual = sorted(main['summaries'])
    write_json(destination/'executed-methods.json', dict(
        native_methods=[name for name in actual if not name.endswith('-common')],
        retained_activation_variants=[name for name in actual if name.endswith('-common')],
        interpretation='The initial experiment file lists the first preparation batch; this executed inventory is authoritative.'))
    write_json(destination/'admission.json', dict(
        methods={name: dict(attempted=True,
                           admission_failure=metadata.get('main/'+name, {}).get('admission_failure'))
                 for name in actual if not name.endswith('-common')},
        excluded=[dict(repository='fosfrancesco/md_beat_this',
                       revision='aca41a23a26881ba3d1e5b5e4bc3f4869d6a3ed7',
                       reason='The inspected tree contains evaluate.py and predictions, without executable inference code or a checkpoint for the frozen input corpus.')],
        qualification='Admission to measurement is not approval for product distribution; license and platform limits remain separate.'))
    memory = {p.stem: json.loads(p.read_text()) for p in sorted((root/'memory-results').glob('*.json'))}
    write_json(destination/'memory.json', memory)
    footprints = {p.stem: json.loads(p.read_text()) for p in sorted((root/'footprints').glob('*.json'))}
    write_json(destination/'footprints.json', footprints)
    weights = {method: assets(root, method) for method in main['summaries']}
    write_json(destination/'method-assets.json', weights)
    write_json(destination/'compatibility.json', compatibility(root))
    # Differences resample the same recordings, not two independent samples.
    test = {method: {row['case']: row['metrics']['downbeat']['f1']
                    for row in main['matrix'] if row['method'] == method and row['split'] == 'test'
                    and not row.get('failure')
                    and row.get('metrics', {}).get('downbeat') is not None}
            for method in main['summaries']}
    paired = {}
    for left in test:
        if left.startswith(('essentia-', 'librosa-')):
            continue
        paired[left] = {}
        for right in test:
            cases = sorted(set(test[left]) & set(test[right]))
            deltas = [test[left][c]-test[right][c] for c in cases
                      if test[left][c] is not None and test[right][c] is not None]
            if deltas:
                paired[left][right] = dict(cases=len(deltas), mean_f1_difference=average(deltas), bootstrap_95=interval(deltas))
    write_json(destination/'paired-test-differences.json', paired)
    lines = ['# Tablas medidas', '',
             'Test: 20 GTZAN; tolerancia 70 ms; media por grabación. F1 no es porcentaje de compases correctos.',
             'Modelo 2 de BeatNet entrenado con GTZAN: su resultado no es test independiente.', '',
             '| Método | Test ejecutado | F1 pulso | F1 primer tiempo | IC bootstrap 95 % del 1 | CPU s/min audio, con separación | RAM PSS árbol MiB |',
             '| --- | ---: | ---: | ---: | --- | ---: | ---: |']
    for method, groups in main['summaries'].items():
        row = groups.get('test', {})
        bounds = row.get('downbeat_f1_bootstrap_95')
        bounds = '—' if bounds is None else '–'.join(number(v) for v in bounds)
        profile = memory.get(method, {}).get('sampled_tree', {})
        pss = profile.get('pss_tree_kib')
        if method.endswith('-common'):
            pss = None  # No complete variant memory process was measured.
        lines.append(f"| {method} | {row.get('completed', 0)}/20 | {number(row.get('beat_f1'))} | {number(row.get('downbeat_f1'))} | {bounds} | {number(runtime(row)[0], 2)} | {number(pss/1024 if pss is not None else None, 0)} |")
    lines += ['', 'Las variantes `-common` usan la suma de CPU de la fuente y del decoder, conservadas por separado en la matriz. No se ha cronometrado un pipeline nuevo completo ni su RAM.',
              'Las variantes con separación reutilizada añaden el coste de preparación medido previamente a su inferencia; no es otro pase completo con separación fría.',
              'La RAM se mide en un proceso sin el evaluador, sobre el mismo fragmento de 30 s; no es una garantía de máximo para canciones de cualquier duración.', '',
              '| Método | Señales ejecutadas | Positivas evaluadas | F1 del 1 en positivas | Cobertura de agrupación correcta | Cobertura de subdivisión correcta | Unos sin referencia en controles |',
              '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for method, groups in main['summaries'].items():
        row = groups.get('known_signal', {})
        lines.append(f"| {method} | {row.get('completed', 0)}/20 | {row.get('positive_downbeat_cases', 0)}/17 | {number(row.get('downbeat_f1_on_annotated_positive_cases'))} | {number(row.get('correct_grouping_coverage'))} | {number(row.get('correct_subdivision_coverage'))} | {row.get('unsupported_downbeat_events', 0)} |")
    lines += ['', '| Método | Pesos con frontend MiB | Archivos de dependencias MiB |',
              '| --- | ---: | ---: |']
    for method in main['summaries']:
        footprint = footprints.get(dependency_key(method), {})
        size = footprint.get('registered_installed_bytes')
        if method.startswith('transformer-') and size is not None:
            worker_size = footprints.get('spleeter232', {}).get('registered_installed_bytes')
            size = size+worker_size if worker_size is not None else None
        lines.append(f"| {method} | {number(weights[method]['external_weight_bytes']/1024**2, 1)} | {number(size/1024**2 if size is not None else None, 1)} |")
    lines += ['', 'Dependencias: archivos instalados registrados en los entornos medidos, con dependencias importadas explícitas cuando no las declara el paquete; sin intérprete ni cachés. No son el incremento exacto sobre el instalador de Soundsible. Transformer suma los dos entornos necesarios. Algunos pesos ya forman parte de los paquetes, también modelos no usados: las columnas no son conjuntos disjuntos y no deben sumarse como tamaño mínimo de despliegue.']
    lines += ['', '| Método | Carga de proceso/modelo CPU s | CPU caliente p10/mediana/p90 s/min | Diferencia absoluta entre dos pasadas % |',
              '| --- | ---: | --- | ---: |']
    for method, groups in main['summaries'].items():
        row = groups.get('test', {})
        load = metadata.get('main/'+method, {}).get('load_cpu_seconds')
        spread = row.get('warm_cpu_seconds_per_audio_minute_percentiles_10_50_90')
        rendered = '/'.join(number(v, 2) for v in spread) if spread else '—'
        lines.append(f"| {method} | {number(load, 2)} | {rendered} | {number(row.get('median_repeat_cpu_absolute_difference_percent'), 1)} |")
    lines += ['', 'La carga no vacía las cachés del sistema operativo. Los percentiles calientes describen diferencias entre grabaciones; la diferencia entre pasadas solo se calcula cuando ambas ejecutan el mismo trabajo de backend, excluyendo los frontends separados cacheados. Son dos repeticiones, no un estudio de variabilidad entre máquinas. En `-common` el tiempo caliente y la variación son del decoder, con el coste de la fuente aparte.']
    (destination/'TABLES.md').write_text('\n'.join(lines)+'\n')
    print('Exported', len(main['matrix']), 'main rows,', len(aac['matrix']), 'AAC rows and', len(retained), 'observations')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    export(args.root, args.destination)
