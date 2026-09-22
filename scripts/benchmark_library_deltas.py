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
import subprocess
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
    parser.add_argument('--reference', help='load the HTTP route from this local git revision')
    parser.add_argument('--fallbacks', action='store_true', help='also measure unknown-base and bulk-edit fallback')
    args = parser.parse_args()
    if args.repeats < 1 or any(size < 1 for size in args.sizes):
        parser.error('positive sizes and repeats required')
    spec = importlib.util.spec_from_file_location('benchmark_delta_route', ROOT / 'shared/api/routes/library.py')
    route = importlib.util.module_from_spec(spec)
    if args.reference:
        source = subprocess.check_output(
            ['git', 'show', f'{args.reference}:shared/api/routes/library.py'], cwd=ROOT, text=True)
        exec(compile(source, spec.origin, 'exec'), route.__dict__)
    else:
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
            fallback_results = {}
            if args.fallbacks:
                expected = client.get('/api/library').data
                missing_times = []
                for _ in range(args.repeats):
                    fallback, duration, _ = timed(lambda: client.get('/api/library?delta=1&since=missing'))
                    assert fallback.data == expected
                    missing_times.append(duration)
                bulk_times = []
                for i in range(args.repeats):
                    for track in lib.metadata.tracks:
                        track.title = f'Bulk edit {i}'
                    base = etag[3:-1]
                    fallback, duration, _ = timed(lambda: client.get('/api/library',
                        query_string={'delta': '1', 'since': base}, headers={'If-None-Match': etag}))
                    assert 'tracks' in fallback.get_json()
                    assert fallback.data == client.get('/api/library').data
                    etag = fallback.headers['ETag']
                    bulk_times.append(duration)
                fallback_results = {
                    'missing_base_median_ms': round(statistics.median(missing_times), 2),
                    'bulk_fallback_median_ms': round(statistics.median(bulk_times), 2),
                }
            with history.connection() as db:
                retained = db.execute('SELECT COUNT(*), SUM(bytes) FROM revisions').fetchone()
            print(json.dumps({'route_reference': args.reference or 'working-tree', **fallback_results,
                'tracks': count, 'full_bytes': len(full.data), 'full_ms': round(full_ms, 2),
                'initial_history_ms': round(initial_ms, 2), 'delta_bytes': len(response.data),
                'changed_delta_median_ms': round(statistics.median(elapsed), 2),
                'changed_delta_peak_python_bytes': peak,
                'unchanged_ms': round(unchanged_ms, 2), 'retained_revisions': retained[0],
                'history_accounted_bytes': retained[1], 'history_file_bytes': (Path(directory) / 'library-deltas.sqlite3').stat().st_size}), flush=True)


if __name__ == '__main__':
    main()
