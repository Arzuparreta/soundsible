#!/usr/bin/env python3
"""Isolated HTTP Range baseline under real SQLite/export, scan and DJ work.

Uses the production local-stream handler and gevent patch order. Candidate
library and audio are synthetic; no remote provider or browser is exercised.
Output reports transport latency, hub stalls and process cost, NOT audible gaps.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def child(args):
    from gevent import monkey
    monkey.patch_all()
    import gevent
    from gevent.pywsgi import WSGIServer
    import hashlib
    import math
    import os
    import struct
    import tempfile
    import time
    from urllib.request import Request, urlopen
    import wave
    from unittest.mock import patch

    sys.path.insert(0, str(ROOT))
    with tempfile.TemporaryDirectory(prefix='soundsible-load-', dir=ROOT.parent) as temporary:
        root = Path(temporary)
        for name in ('config', 'data', 'cache', 'log', 'music'):
            os.environ[f'SOUNDSIBLE_{name.upper()}_DIR'] = str(root / name)
        os.environ['OUTPUT_DIR'] = str(root / 'music')
        from shared.runtime import RuntimeConfig, configure_runtime
        runtime = RuntimeConfig.default()
        configure_runtime(runtime)
        runtime.music_dir.mkdir()
        from shared.app_config import set_output_dir
        set_output_dir(runtime.music_dir)
        from shared.user_context import user_context
        from player.library import LibraryManager
        from scripts.benchmark_library_export import library
        from shared.api.orchestrator import JobOrchestrator
        from shared.api.routes import playback
        from shared import dj_engine, atomic_file
        if args.blocking_fsync:
            atomic_file.sync_file = os.fsync
        from flask import Flask
        from scripts.resource_sample import counters

        with user_context('load-benchmark'):
            manager = LibraryManager(silent=True)
            manager.metadata = library(args.tracks)
            assert manager._save_metadata()
        track = manager.metadata.tracks[0]
        path = runtime.music_dir / 'fixture.wav'
        # Thirty seconds of valid PCM, generated outside the timed interval.
        with wave.open(str(path), 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(22050)
            second = b''.join(struct.pack('<h', int(12000 * math.sin(2 * math.pi * 220 * i / 22050)))
                              for i in range(22050))
            for _ in range(30):
                output.writeframes(second)
        payload = path.read_bytes()
        track_id = track.id
        api = {'get_core': lambda: (manager, None, None),
               'get_track_by_id': lambda lib, identity: lib.metadata.get_track_by_id(identity),
               'is_trusted_network': lambda address: True,
               'is_safe_path': lambda value, **kw: Path(value) == path}
        app = Flask(__name__)
        app.register_blueprint(playback.playback_bp)
        server = WSGIServer(('127.0.0.1', 0), app, log=None)
        server.start()
        orchestrator = JobOrchestrator(profile=args.profile)
        samples, lag, snapshots, failures = [], [], [], []
        before = counters(os.getpid())
        cpu_start = time.process_time()
        started = time.monotonic()
        deadline = started + args.seconds
        counts = {'edits': 0, 'scans': 0, 'analysis_requests': 0}

        def monitor():
            expected = time.monotonic() + .02
            while time.monotonic() < deadline:
                gevent.sleep(max(0, expected - time.monotonic()))
                now = time.monotonic()
                lag.append(max(0, now - expected) * 1000)
                snapshots.append(orchestrator.resource_snapshot())
                expected = now + .02

        def writer():
            with user_context('load-benchmark'):
                manager.patch_track_metadata(track_id, {'title': f'Load edit {counts["edits"]}'})
            counts['edits'] += 1

        def scanner():
            for source in runtime.music_dir.rglob('*.wav'):
                with source.open('rb') as stream:
                    for block in iter(lambda: stream.read(65536), b''):
                        hashlib.sha256(block).digest()
                        gevent.sleep(0)
            counts['scans'] += 1

        def drive(task_id, operation):
            # Finite jobs model normal admission. Do not occupy the only HDD
            # worker with a supervisor loop that prevents the other work running.
            while time.monotonic() < deadline:
                orchestrator.submit_background(task_id, operation).result(timeout=30)
                gevent.sleep(.1)

        def listener():
            sequence = 0
            while time.monotonic() < deadline:
                offset = (sequence * 65536) % (len(payload) - 65536)
                request = Request(f'http://127.0.0.1:{server.server_port}/api/static/stream/{track_id}',
                                  headers={'Range': f'bytes={offset}-{offset + 65535}'})
                tick = time.monotonic()
                try:
                    with urlopen(request, timeout=10) as response:
                        body = response.read()
                        if response.status != 206 or body != payload[offset:offset + 65536]:
                            failures.append('incorrect range response')
                    samples.append((time.monotonic() - tick) * 1000)
                except Exception as exc:
                    failures.append(type(exc).__name__)
                sequence += 1
                gevent.sleep(.05)

        try:
            with patch.object(playback, '_get_api', return_value=api), \
                 patch.object(playback, 'resolve_local_track_path', return_value=str(path)):
                monitor_job = gevent.spawn(monitor)
                jobs = []
                if args.scenario in ('loaded', 'dj'):
                    jobs = [gevent.spawn(drive, 'edits', writer), gevent.spawn(drive, 'scan', scanner)]
                if args.scenario == 'dj':
                    for i in range(6):
                        dj_engine.request_analysis(path, f'load-analysis-{i}', duration_hint=30)
                        counts['analysis_requests'] += 1
                listeners = [gevent.spawn(listener) for _ in range(args.clients)] if args.scenario != 'idle' else []
                gevent.joinall([monitor_job, *listeners], raise_error=True)
                for job in jobs:
                    job.get(timeout=30)
                end = time.monotonic()
                after = counters(os.getpid())
        finally:
            orchestrator.shutdown()
            server.stop()
        def percentile(values, fraction):
            ordered = sorted(values)
            return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))] if ordered else None
        result = {'scenario': args.scenario, 'profile': args.profile, 'blocking_fsync': args.blocking_fsync, 'tracks': args.tracks,
                  'clients': args.clients, 'elapsed_s': end - started, 'requests': len(samples),
                  'range_p50_ms': percentile(samples, .5), 'range_p95_ms': percentile(samples, .95),
                  'range_max_ms': max(samples, default=None), 'hub_p95_ms': percentile(lag, .95),
                  'hub_max_ms': max(lag, default=None), 'cpu_seconds': time.process_time() - cpu_start,
                  'pss_before_kib': before.get('Pss'), 'pss_after_kib': after.get('Pss'),
                  'write_bytes': after.get('write_bytes', 0) - before.get('write_bytes', 0),
                  'max_background_queued': max((s['background']['queued'] for s in snapshots), default=0),
                  'final_queues': orchestrator.resource_snapshot(), 'work': counts, 'errors': failures}
        result['source_sha256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                                   for name in ('shared/atomic_file.py', 'shared/api/orchestrator.py',
                                                'player/library.py', 'shared/database.py',
                                                'scripts/benchmark_playback_load.py')}
        print(json.dumps(result), flush=True)
        if failures or (args.scenario != 'idle' and not samples):
            raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=30)
    parser.add_argument('--tracks', type=int, default=1000)
    parser.add_argument('--clients', type=int, default=2)
    parser.add_argument('--profile', choices=('hdd', 'ssd'), default='ssd')
    parser.add_argument('--scenario', choices=('idle', 'normal', 'loaded', 'dj'), default='normal')
    parser.add_argument('--blocking-fsync', action='store_true', help='Benchmark the prior synchronous fsync path')
    parser.add_argument('--child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if min(args.seconds, args.tracks, args.clients) <= 0:
        parser.error('seconds, tracks and clients must be positive')
    if args.child:
        child(args)
    else:
        # Fresh patched process per case, including cold feature/cache state.
        command = [sys.executable, __file__, *sys.argv[1:], '--child']
        raise SystemExit(subprocess.run(command, cwd=ROOT).returncode)
