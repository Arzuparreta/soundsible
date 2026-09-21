"""Synthetic HTTP delta cost including disk history writes.

Uses a temporary directory beside the repository, rather than /tmp (often
memory-backed). Excludes SQL library loading, annotation lookups, compression,
network and playback. Run: venv/bin/python scripts/benchmark_library_deltas.py
"""
import argparse
from copy import deepcopy
import gc
import importlib.util
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time
import tracemalloc
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from flask import Flask
from shared.api import library_deltas as history
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context


def timed(call, memory=False):
    gc.collect()
    if memory:
        tracemalloc.start()
    start = time.perf_counter()
    response = call()
    elapsed = (time.perf_counter() - start) * 1000
    peak = None
    if memory:
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    return response, elapsed, peak


def apply(snapshot, delta):
    snapshot = deepcopy(snapshot)
    rows = {t['id']: t for t in snapshot['tracks']}
    for track_id in delta['removed']:
        del rows[track_id]
    for track in delta['upserts']:
        rows[track['id']] = track
    snapshot['tracks'] = [rows[key] for key in delta.get('order', rows)]
    snapshot.update(delta['fields'])
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', type=int, nargs='+', default=[1000, 10000, 50000])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--memory', action='store_true')
    args = parser.parse_args()
    if args.repeats < 1 or any(size < 1 for size in args.sizes):
        parser.error('positive sizes and repeats required')
    spec = importlib.util.spec_from_file_location('benchmark_delta_route', ROOT / 'shared/api/routes/library.py')
    route = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(route)
    lib = SimpleNamespace(metadata=None, refresh_if_stale=lambda: None)
    route._get_api = lambda: {'get_core': lambda: (lib, None, None)}
    route.annotate_tracks = lambda tracks: True
    app = Flask(__name__)
    app.register_blueprint(route.library_bp)
    client = app.test_client()
    for count in args.sizes:
        with (tempfile.TemporaryDirectory(prefix='soundsible-delta-bench-', dir=ROOT.parent) as directory,
              patch.object(history, 'get_cache_dir', return_value=Path(directory)),
              patch('shared.artwork.artwork_store', return_value=SimpleNamespace(annotate=lambda tracks: None, public_revision=lambda: 'art')),
              patch('shared.loudness.LoudnessStore.public_revision', return_value='loudness'), user_context('benchmark')):
            lib.metadata = LibraryMetadata(1, [Track(
                id=str(i), title='Title', artist='Artist', album='Album', duration=240,
                file_hash=str(i), original_filename=f'{i}.mp3', compressed=False,
                file_size=1000000, bitrate=320, format='mp3',
            ) for i in range(count)], {}, {}, last_updated='2026-01-01T00:00:00')
            full, full_ms, _ = timed(lambda: client.get('/api/library'))
            initial, initial_ms, _ = timed(lambda: client.get('/api/library?delta=1'))
            etag = initial.headers['ETag']
            accepted = initial.get_json()
            elapsed = []
            for i in range(args.repeats + int(args.memory)):
                lib.metadata.tracks[0].title = f'Edited {i}'
                base = etag[3:-1]
                response, duration, peak = timed(lambda: client.get('/api/library',
                    query_string={'delta': '1', 'since': base}, headers={'If-None-Match': etag}),
                    memory=args.memory and i == args.repeats)
                delta = response.get_json()
                assert delta['kind'] == 'delta', delta.keys()
                accepted = apply(accepted, delta)
                assert accepted == client.get('/api/library').get_json()
                etag = 'W/"' + delta['revision'] + '"'
                if i < args.repeats:
                    elapsed.append(duration)
            unchanged, unchanged_ms, _ = timed(lambda: client.get('/api/library?delta=1', headers={'If-None-Match': etag}))
            assert unchanged.status_code == 304
            with history.connection() as db:
                retained = db.execute('SELECT COUNT(*), SUM(bytes) FROM revisions').fetchone()
            print(json.dumps({'tracks': count, 'full_bytes': len(full.data), 'full_ms': round(full_ms, 2),
                'initial_history_ms': round(initial_ms, 2), 'delta_bytes': len(response.data),
                'changed_delta_median_ms': round(statistics.median(elapsed), 2),
                'changed_delta_peak_python_bytes': peak,
                'unchanged_ms': round(unchanged_ms, 2), 'retained_revisions': retained[0],
                'history_accounted_bytes': retained[1], 'history_file_bytes': (Path(directory) / 'library-deltas.sqlite3').stat().st_size}), flush=True)


if __name__ == '__main__':
    main()
