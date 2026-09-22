#!/usr/bin/env python3
"""Decision gate for DJ queue prioritisation; never opens the user's runtime.

Real Flask DJ handlers, gevent patch order, executor, FFmpeg and feature/cache
pipeline. Only candidate discovery and local-path lookup are controlled. This
is NOT a whole-engine/browser/listening benchmark. Each case gets a fresh child,
cache and synthetic 180-second PCM file. No artificial analysis delay is used.

The first refinement models an early seek/route switch. A diagnostic second
read after drain measures availability, NOT a retry the current client makes.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = ('cold', 'warm', 'switch', 'four_sessions')


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


def child(args):
    # No threading/socket/Flask/numerical imports before the daemon's patch.
    from gevent import monkey
    monkey.patch_all()
    import gevent
    import os
    import time
    import wave
    from types import SimpleNamespace
    from unittest.mock import patch

    sys.path.insert(0, str(ROOT))
    with tempfile.TemporaryDirectory(prefix='soundsible-dj-queue-') as directory:
        root = Path(directory)
        for label in ('config', 'data', 'cache', 'log', 'music'):
            path = root / label
            path.mkdir()
            os.environ[f'SOUNDSIBLE_{label.upper()}_DIR'] = str(path)
        os.environ['OUTPUT_DIR'] = str(root / 'music')
        from shared.runtime import RuntimeConfig, configure_runtime
        configure_runtime(RuntimeConfig.default())
        from shared.user_context import bind_user
        bind_user('queue-benchmark')
        from shared import dj_engine as engine
        from shared.api.routes import auto_mode
        from shared.api.routes.discovery_bp import discovery_bp
        from flask import Flask
        from scripts.benchmark_dj_analysis import synthetic_pcm
        from scripts.resource_sample import counters

        samples, rate = synthetic_pcm(args.seconds)
        source = root / 'music' / 'fixture.wav'
        with wave.open(str(source), 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes((samples * 32767).astype('<i2').tobytes())
        del samples
        app = Flask(__name__)
        app.register_blueprint(discovery_bp)
        lib = SimpleNamespace(metadata=None)
        api = {'get_core': lambda: (lib, None, None)}

        def item(number):
            row = {'id': f'fixture-{number}', 'track_id': f'fixture-{number}',
                   'title': f'Fixture {number}', 'artist': 'Synthetic',
                   'duration': args.seconds, 'source': 'library', 'source_pool': 'local',
                   'recommendation_identity': f'music:track:fixture-{number}'}
            return row

        def candidates(metadata, roots, **kwargs):
            offset = int(roots[0]['id'].rsplit('-', 1)[1])
            return auto_mode._GraphWalk([item(offset + i) for i in range(1, 9)], False, False)

        # Bounded by this finite corpus (maximum 36 identities), not a
        # production event history. Instrumentation is entirely benchmark-local.
        events = {}
        requested = set()
        original_request = engine.request_analysis
        original_analyse = engine.analyse_audio
        maximum = {'active': 0, 'pending': 0}
        active = 0
        epoch = time.perf_counter()

        def stamp():
            return time.perf_counter() - epoch

        def request(path, identity, **kwargs):
            requested.add(identity)
            if args.instrumented and identity not in events:
                events[identity] = {'submitted': stamp()}
                pending = sum('started' not in event for event in events.values())
                maximum['pending'] = max(maximum['pending'], pending)
            return original_request(path, identity, **kwargs)

        def analyse(path, identity, **kwargs):
            nonlocal active
            if args.instrumented:
                events[identity]['started'] = stamp()
                active += 1
                maximum['active'] = max(maximum['active'], active)
            try:
                result = original_analyse(path, identity, **kwargs)
                if args.instrumented:
                    events[identity]['analysed'] = bool(result.get('analysed'))
                return result
            finally:
                if args.instrumented:
                    events[identity]['finished'] = stamp()
                    active -= 1

        latencies = []

        def post(endpoint, body):
            started = time.perf_counter()
            with app.test_client() as client:
                response = client.post('/api/discovery/music/' + endpoint, json=body)
            elapsed = time.perf_counter() - started
            if response.status_code != 200:
                raise RuntimeError(f'{endpoint}: HTTP {response.status_code}: {response.get_json()}')
            latencies.append({'endpoint': endpoint, 'seconds': elapsed})
            return response.get_json()

        def plan(offset):
            seed = item(offset)
            result = post('dj-plan', {'seed': seed, 'limit': 8, 'session_id': f'session-{offset}',
                                      'source_policy': 'explicit',
                                      'sources': [{'id': f'source-{offset}', 'label': 'Fixture', 'tracks': [seed]}]})
            assert len(result['items']) == 8
            return {'from': seed, 'to': result['items'][0]}

        def drain():
            deadline = time.monotonic() + 120
            while engine._pending:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Analysis queue did not drain within 120 seconds')
                gevent.sleep(0.005)

        # Hub samples are bounded to a 120-second experiment at 10 ms cadence.
        hub = []
        running = True

        def heartbeat():
            while running and len(hub) < 12000:
                before = time.perf_counter()
                gevent.sleep(0.01)
                hub.append(max(0, time.perf_counter() - before - 0.01))

        with (patch.object(auto_mode, '_get_api', return_value=api),
              patch.object(auto_mode, '_planner_context_related', side_effect=candidates),
              patch.object(auto_mode, '_planner_warm_related'),
              patch.object(auto_mode, '_dj_source_path', return_value=str(source)),
              patch.object(auto_mode, 'request_analysis', side_effect=request),
              patch.object(engine, 'analyse_audio', side_effect=analyse)):
            if args.scenario == 'warm':
                plan(0)
                drain()
                events.clear()
                requested.clear()
                latencies.clear()
                maximum = {'active': 0, 'pending': 0}
            gevent.sleep(0.1)
            epoch = time.perf_counter()
            cpu = time.process_time()
            io_before = counters(os.getpid())
            ticker = gevent.spawn(heartbeat)
            if args.scenario == 'switch':
                plan(0)
                pair = plan(10)
            elif args.scenario == 'four_sessions':
                jobs = [gevent.spawn(plan, offset) for offset in (0, 10, 20, 30)]
                gevent.joinall(jobs, raise_error=True)
                pair = jobs[-1].value
            else:
                pair = plan(0)
            gevent.sleep(args.refine_delay)
            refine_time = stamp()
            first = post('dj-transition', pair)
            drain()
            drained = stamp()
            identities = [engine.analysis_identity(row) for row in pair.values()]
            final = post('dj-transition', pair)
            # A successful drain must produce real measurements, not swallowed
            # decoder failures which would otherwise look like a fast queue.
            assert final['measured'], 'Pair never acquired usable analysis'
            for identity in requested:
                result = engine.cached_analysis(source, identity)
                assert result and result['analysed'], 'An accepted analysis failed'
            running = False
            ticker.join(timeout=1)
            io_after = counters(os.getpid())
            result = {
                'scenario': args.scenario, 'instrumented': args.instrumented,
                'audio_seconds': args.seconds, 'refine_delay_s': args.refine_delay,
                'wall_s': drained, 'process_cpu_s': time.process_time() - cpu,
                'pss_kib_end': io_after.get('Pss'),
                'process_read_bytes': io_after.get('read_bytes', 0) - io_before.get('read_bytes', 0),
                'process_write_bytes': io_after.get('write_bytes', 0) - io_before.get('write_bytes', 0),
                'accepted_identities': len(requested), 'queue_max': maximum if args.instrumented else None,
                'first_refine_at_s': refine_time, 'first_measured': first['measured'],
                'diagnostic_after_drain_measured': final['measured'],
                'handler_latencies': latencies,
                'hub_lag_p95_s': percentile(hub, .95), 'hub_lag_max_s': max(hub, default=0),
            }
            if args.instrumented:
                result.update({
                    'analysis_finished_at_s': max((e['finished'] for e in events.values()), default=0),
                    'queue_wait_p50_s': percentile([e['started'] - e['submitted'] for e in events.values()], .5),
                    'queue_wait_p95_s': percentile([e['started'] - e['submitted'] for e in events.values()], .95),
                    'service_p50_s': percentile([e['finished'] - e['started'] for e in events.values()], .5),
                    'pair_events': [events.get(identity) for identity in identities],
                    'jobs': list(events.values()),
                })
            if engine._pool is not None:
                engine._pool.shutdown(wait=True)
            print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--seconds', type=int, default=180)
    parser.add_argument('--refine-delay', type=float, default=0.05)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--scenarios', nargs='+', choices=SCENARIOS, default=list(SCENARIOS))
    parser.add_argument('--child', action='store_true')
    parser.add_argument('--scenario', choices=SCENARIOS, default='cold')
    parser.add_argument('--instrumented', action='store_true')
    args = parser.parse_args()
    if args.seconds < 4 or args.repeats < 1 or not 0 <= args.refine_delay <= 120:
        parser.error('seconds >= 4, repeats >= 1 and 0 <= refine-delay <= 120 are required')
    if args.child:
        child(args)
        return
    import platform
    import hashlib
    metadata = {
        'kind': 'environment', 'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'python': sys.version, 'platform': platform.platform(),
        'benchmark_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'cpu': next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unknown'),
        'planner': 'current explicit-source collection route; independent sessions, one isolated account',
        'scope': 'isolated Flask handlers, controlled candidates, actual gevent/FFmpeg/analysis; no browser or network',
        'command': sys.argv[1:],
    }
    rows = [metadata]
    if args.output:
        args.output.write_text(json.dumps(metadata) + '\n')
    for repeat in range(args.repeats):
        for scenario in args.scenarios:
            # Alternate order to avoid systematically giving one setting the
            # warmer filesystem cache. Analysis cache is always child-local.
            for instrumented in ((False, True) if repeat % 2 == 0 else (True, False)):
                command = [sys.executable, str(Path(__file__).resolve()), '--child', '--scenario', scenario,
                           '--seconds', str(args.seconds), '--refine-delay', str(args.refine_delay)]
                if instrumented:
                    command.append('--instrumented')
                completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=180)
                if completed.returncode:
                    raise RuntimeError(completed.stderr + completed.stdout)
                row = json.loads(completed.stdout.splitlines()[-1])
                row['repeat'] = repeat + 1
                rows.append(row)
                if args.output:
                    with args.output.open('a') as output:
                        output.write(json.dumps(row) + '\n')
                print(json.dumps({k: row[k] for k in ('scenario', 'repeat', 'instrumented', 'wall_s', 'first_measured')}), flush=True)
    for scenario in args.scenarios:
        selected = [r for r in rows if r.get('scenario') == scenario and r['instrumented']]
        print(json.dumps({'summary': scenario, 'median_drain_s': statistics.median(r['wall_s'] for r in selected),
                          'first_measured_runs': sum(r['first_measured'] for r in selected), 'runs': len(selected)}))


if __name__ == '__main__':
    main()
