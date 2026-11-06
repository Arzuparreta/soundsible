"""Isolated HTTP image delivery and cooperative-loop responsiveness.

Compares a git baseline's ArtworkStore against this checkout using the same
HTTP route, JPEG encoder, filesystem and synthetic images. This measures HTTP
delivery, not audio quality, battery use, Pi hardware or a listening session.
"""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from shared.cooperative import patch_process
patch_process()

import argparse
import hashlib
import io
import json
import statistics
import subprocess
import tempfile
import time
import types

import gevent
from gevent.pywsgi import WSGIServer
from flask import Flask
from PIL import Image
import requests

from shared.runtime import RuntimeConfig, configure_runtime


def percentile(values, fraction):
    return sorted(values)[min(len(values) - 1, int(len(values) * fraction))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', default='1d904020')
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--images', type=int, default=12)
    args = parser.parse_args()
    if not 1 <= args.images <= 16 or not 1 <= args.repeats <= 20:
        parser.error('images must be 1..16; repeats 1..20')
    old = types.ModuleType('baseline_artwork')
    code = subprocess.check_output(['git', 'show', args.baseline + ':shared/artwork.py'], cwd=ROOT, text=True)
    exec(compile(code, '<baseline-artwork>', 'exec'), old.__dict__)
    with tempfile.TemporaryDirectory(prefix='soundsible-artwork-http-', dir=ROOT.parent) as directory:
        root = Path(directory)
        env = {f'SOUNDSIBLE_{key}_DIR': str(root / key.lower()) for key in ('CONFIG', 'DATA', 'CACHE', 'LOG', 'MUSIC')}
        os.environ.update(env)
        configure_runtime(RuntimeConfig.default(env))
        from shared import artwork
        from shared.artwork_worker import worker
        from shared.api.routes import playback
        bodies = []
        for n in range(args.images):
            image = Image.new('RGB', (24, 16))
            image.putdata([((i * 17 + n * 43) % 256, (i * 7 + n * 31) % 256, (i * 3 + n * 11) % 256)
                           for i in range(24 * 16)])
            image = image.resize((1280, 720), Image.Resampling.BICUBIC)
            output = io.BytesIO()
            image.save(output, 'PNG')
            bodies.append(output.getvalue())
        app = Flask('artwork-benchmark')
        from shared.user_context import bind_user
        @app.before_request
        def account():
            bind_user('benchmark')
        app.add_url_rule('/api/static/cover/<track_id>', view_func=playback.get_track_cover)
        server = WSGIServer(('127.0.0.1', 0), app, log=None)
        server.start()
        origin = f'http://127.0.0.1:{server.server_port}'
        try:
            for implementation, store_type in [('baseline', old.ArtworkStore), ('pipeline', artwork.ArtworkStore)]:
                for repeat in range(args.repeats):
                    store = store_type(root / f'{implementation}-{repeat}/data', root / f'{implementation}-{repeat}/cache')
                    if implementation == 'baseline':
                        store.effective_ref, store.effective_path = store.ref, store.path
                    for i, body in enumerate(bodies):
                        store.bind(str(i), store.put(body), 'youtube')
                    artwork.artwork_store = lambda: store
                    playback._get_api = lambda: {
                        'get_core': lambda: (types.SimpleNamespace(get_cover_url=lambda t: store.path(t.id)), None, None),
                        'get_track_by_id': lambda _, key: types.SimpleNamespace(id=key, cover_source='youtube'),
                        'WEB_UI_PATH': str(root),
                    }
                    # Prime worker startup separately from cold-variant throughput.
                    if implementation == 'pipeline':
                        value = store.open_variant(store.ref('0')['hash'], 160, True)
                        value.file.close()
                    for phase in ('cold', 'warm'):
                        gaps, latencies, digests, sizes = [], [], [], []
                        running = True
                        def heartbeat():
                            last = time.perf_counter()
                            while running:
                                gevent.sleep(.001)
                                now = time.perf_counter()
                                gaps.append(max(0, now - last - .001) * 1000)
                                last = now
                        def request(index):
                            started = time.perf_counter()
                            response = requests.get(origin + f'/api/static/cover/{index}?size=960&fit=square', timeout=35)
                            assert response.status_code == 200, response.text
                            digests.append(hashlib.sha256(response.content).hexdigest())
                            sizes.append(len(response.content))
                            latencies.append((time.perf_counter() - started) * 1000)
                        beat = gevent.spawn(heartbeat)
                        gevent.sleep(.005)
                        started, cpu = time.perf_counter(), time.process_time()
                        gevent.joinall([gevent.spawn(request, i) for i in range(args.images)], raise_error=True)
                        wall, cpu = time.perf_counter() - started, time.process_time() - cpu
                        gevent.sleep(.005)
                        running = False
                        beat.join()
                        print(json.dumps({'implementation': implementation, 'repeat': repeat, 'phase': phase,
                                          'images': args.images, 'wall_ms': wall * 1000, 'parent_cpu_ms': cpu * 1000,
                                          'http_p50_ms': statistics.median(latencies),
                                          'http_p95_ms': percentile(latencies, .95), 'max_hub_lag_ms': max(gaps),
                                          'body_bytes': sum(sizes), 'bodies_digest': hashlib.sha256(''.join(sorted(digests)).encode()).hexdigest()}), flush=True)
        finally:
            server.stop()
            worker.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
