#!/usr/bin/env python3
"""Linux benchmark: compare DJ analysis in fresh processes against a git revision.

Run with the station virtualenv: python scripts/benchmark_dj_analysis.py
--reference origin/main --output /tmp/dj-benchmark.json
Uses synthetic PCM and does not touch the station database or audio cache.
The reference revision must be trusted: its Python implementation is executed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time
import types
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_engine(revision):
    if revision:
        source = subprocess.check_output(['git', 'show', f'{revision}:shared/dj_engine.py'], cwd=ROOT, text=True)
        engine = types.ModuleType('reference_dj_engine')
        exec(compile(source, 'reference_dj_engine.py', 'exec'), engine.__dict__)
    else:
        from shared import dj_engine as engine
    return engine


def synthetic_pcm(seconds):
    import numpy as np
    rate = 11025
    t = np.arange(seconds * rate, dtype=np.float32) / rate
    samples = (0.25 * np.sin(2 * np.pi * 220 * t) + 0.12 * np.sin(2 * np.pi * 330 * t)
               + 0.3 * np.exp(-np.mod(t, 0.5) * 70)).astype(np.float32)
    del t
    return samples, rate


def run_child(revision, seconds, pipeline=False):
    engine = load_engine(revision)
    samples, rate = synthetic_pcm(seconds)
    # Let numerical-library initialization settle before timing short windows.
    time.sleep(0.3)
    if pipeline:
        with tempfile.TemporaryDirectory(prefix='soundsible-dj-benchmark-') as directory:
            source = Path(directory) / 'synthetic.wav'
            with wave.open(str(source), 'wb') as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(rate)
                output.writeframes((samples * 32767).astype('<i2').tobytes())
            del samples
            wall = time.perf_counter()
            cpu = time.process_time()
            features = engine._analyse_pcm(source, duration_hint=seconds)
    else:
        wall = time.perf_counter()
        cpu = time.process_time()
        features = engine._window_features(samples, rate)
    result = {'wall_s': time.perf_counter() - wall, 'cpu_s': time.process_time() - cpu, 'features': features}
    # Linux /proc avoids inherited ru_maxrss from the benchmark parent.
    result['peak_rss_kib'] = next(int(line.split()[1]) for line in Path('/proc/self/status').read_text().splitlines()
                                  if line.startswith('VmHWM:'))
    print(json.dumps(result))


def serve_http(revision, seconds):
    # Match the daemon's import order, in an isolated process and temporary port.
    from gevent import monkey
    monkey.patch_all()
    import gevent
    from gevent.pywsgi import WSGIServer

    engine = load_engine(revision)
    samples, rate = synthetic_pcm(seconds)
    gevent.sleep(0.3)
    compute = getattr(engine, '_compose_off_loop', engine._compose)
    jobs = []

    def start_jobs():
        jobs.extend(gevent.spawn(compute, samples, samples, rate, duration=seconds, tail_start=0) for _ in range(2))

    def app(env, start_response):
        if env['PATH_INFO'] == '/start':
            gevent.spawn_later(0.05, start_jobs)
        body = json.dumps({'completed': sum(job.ready() and job.successful() for job in jobs)}).encode()
        start_response('200 OK', [('Content-Type', 'application/json'), ('Content-Length', str(len(body)))])
        return [body]

    server = WSGIServer(('127.0.0.1', 0), app, log=None)
    server.start()
    print(json.dumps({'port': server.server_port}), flush=True)
    server.serve_forever()


def http_runs(args):
    import selectors
    import urllib.request

    runs = []
    for _ in range(args.repeats):
        for mode in ('reference', 'current'):
            with tempfile.TemporaryFile(mode='w+') as errors:
                child = subprocess.Popen([
                    sys.executable, str(Path(__file__).resolve()), '--child', mode, '--serve-http',
                    '--reference', args.reference, '--seconds', str(args.seconds[-1]),
                ], cwd=ROOT, stdout=subprocess.PIPE, stderr=errors, text=True)
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(child.stdout, selectors.EVENT_READ)
                        if not selector.select(timeout=60):
                            raise RuntimeError('HTTP benchmark startup timed out')
                    line = child.stdout.readline()
                    if not line:
                        errors.seek(0)
                        raise RuntimeError(errors.read())
                    base = f"http://127.0.0.1:{json.loads(line)['port']}"
                    with urllib.request.urlopen(base + '/start', timeout=30) as response:
                        response.read()
                    times = []
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        start = time.perf_counter()
                        with urllib.request.urlopen(base + '/ping', timeout=30) as response:
                            response.read()
                        times.append((time.perf_counter() - start) * 1000)
                        time.sleep(0.005)
                    with urllib.request.urlopen(base + '/stats', timeout=30) as response:
                        assert json.load(response)['completed'] == 2, 'Analysis did not finish successfully'
                    row = {'mode': mode, 'requests': len(times), 'max_ms': max(times),
                           'p50_ms': statistics.median(times), 'p95_ms': sorted(times)[int((len(times) - 1) * .95)]}
                    runs.append(row)
                    print(json.dumps(row), flush=True)
                finally:
                    if child.poll() is None:
                        child.terminate()
                    try:
                        child.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.communicate()
    return runs


def assert_equivalent(actual, expected):
    import numpy as np

    if isinstance(actual, dict):
        assert actual.keys() == expected.keys()
        for key in actual:
            assert_equivalent(actual[key], expected[key])
    elif isinstance(actual, list):
        assert len(actual) == len(expected)
        for value, reference in zip(actual, expected):
            assert_equivalent(value, reference)
    elif isinstance(actual, (int, float)):
        np.testing.assert_allclose(actual, expected, rtol=1e-10, atol=1e-10)
    else:
        assert actual == expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', default='origin/main')
    parser.add_argument('--seconds', type=int, nargs='+', default=[18, 120, 480])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--pipeline', action='store_true', help='Include FFmpeg decoding and full analysis of synthetic WAV')
    parser.add_argument('--http', action='store_true', help='Measure isolated HTTP response latency during two analyses')
    parser.add_argument('--serve-http', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--child', choices=['reference', 'current'], help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not sys.platform.startswith('linux'):
        parser.error('This benchmark uses Linux /proc peak-memory counters')
    if min(args.seconds) < 4 or args.repeats < 1:
        parser.error('Use at least 4 seconds of audio and one repetition')
    if args.http and args.pipeline:
        parser.error('Choose --http or --pipeline')
    if args.child:
        revision = args.reference if args.child == 'reference' else None
        if args.serve_http:
            serve_http(revision, args.seconds[0])
        else:
            run_child(revision, args.seconds[0], args.pipeline)
        return
    report = {'reference': subprocess.check_output(['git', 'rev-parse', args.reference], cwd=ROOT, text=True).strip(),
              'method': 'Fresh child per run; synthetic float32 PCM; feature extraction only, excluding decoder and network',
              'results': []}
    if args.http:
        report['method'] = 'Separate HTTP client process; two concurrent synthetic PCM analyses; excludes decoder/network providers'
        report['audio_seconds'] = args.seconds[-1]
        report['results'] = http_runs(args)
    elif args.pipeline:
        report['method'] = 'Fresh child; synthetic WAV; FFmpeg and full analysis; temporary files; excludes station caches/providers'
    for seconds in [] if args.http else args.seconds:
        runs = {'reference': [], 'current': []}
        expected = None
        for _ in range(args.repeats):
            for mode in runs:
                result = json.loads(subprocess.check_output([
                    sys.executable, str(Path(__file__).resolve()), '--child', mode,
                    '--reference', args.reference, '--seconds', str(seconds),
                    *(['--pipeline'] if args.pipeline else []),
                ], cwd=ROOT, text=True, timeout=300))
                features = result.pop('features')
                if mode == 'reference':
                    expected = features
                else:
                    assert_equivalent(features, expected)
                runs[mode].append(result)
        summary = {mode: {key: statistics.median(run[key] for run in values)
                          for key in ('wall_s', 'cpu_s', 'peak_rss_kib')} for mode, values in runs.items()}
        row = {'audio_seconds': seconds, 'equivalent': True, 'median': summary, 'runs': runs}
        report['results'].append(row)
        print(json.dumps({'audio_seconds': seconds, **summary}))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
