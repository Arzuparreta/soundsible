"""Measure full and unchanged library responses through the Flask route.

Synthetic metadata; database refresh, loudness/artwork lookups, network and
compression are excluded. Run: venv/bin/python scripts/benchmark_library_revisions.py
"""
import argparse
import gc
import importlib.util
import json
from pathlib import Path
import statistics
import sys
import time
import tracemalloc
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from flask import Flask
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context


def measure(client, headers, repeats, memory=False):
    timings = []
    for _ in range(repeats):
        gc.collect()
        start = time.perf_counter()
        response = client.get('/api/library', headers=headers)
        timings.append((time.perf_counter() - start) * 1000)
    stats = {"status": response.status_code, "body_bytes": len(response.data),
             "median_ms": round(statistics.median(timings), 2)}
    if memory:
        gc.collect()
        tracemalloc.start()
        response = client.get('/api/library', headers=headers)
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        stats["peak_python_bytes"] = peak
    return response, stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', type=int, nargs='+', default=[1000, 10000, 50000])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--memory', action='store_true', help='separately measure peak Python allocations')
    args = parser.parse_args()
    if args.repeats < 1 or any(size < 0 for size in args.sizes):
        parser.error('repeats must be positive and sizes nonnegative')
    spec = importlib.util.spec_from_file_location('benchmark_library_route', ROOT / 'shared/api/routes/library.py')
    route = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(route)
    lib = SimpleNamespace(metadata=None, refresh_if_stale=lambda: None)
    route._get_api = lambda: {"get_core": lambda: (lib, None, None)}
    route.annotate_tracks = lambda tracks: True
    app = Flask(__name__)
    app.register_blueprint(route.library_bp)
    client = app.test_client()
    with (
        user_context('benchmark'),
        patch('shared.artwork.artwork_store', return_value=SimpleNamespace(
            annotate=lambda tracks: None, public_revision=lambda: 'fixture-artwork',
        )),
        patch('shared.loudness.LoudnessStore.public_revision', return_value='fixture-loudness'),
    ):
        for count in args.sizes:
            lib.metadata = LibraryMetadata(1, [Track(
                id=str(i), title='Title', artist='Artist', album='Album', duration=240,
                file_hash=str(i), original_filename=f'{i}.mp3', compressed=False,
                file_size=1000000, bitrate=320, format='mp3',
            ) for i in range(count)], {}, {}, last_updated='2026-01-01T00:00:00')
            full, full_stats = measure(client, {}, args.repeats, args.memory)
            unchanged, unchanged_stats = measure(client, {'If-None-Match': full.headers['ETag']}, args.repeats, args.memory)
            assert full.status_code == 200 and unchanged.status_code == 304 and not unchanged.data
            assert full.headers['ETag'] == unchanged.headers['ETag']
            print(json.dumps({'tracks': count, 'full': full_stats, 'unchanged': unchanged_stats}), flush=True)


if __name__ == '__main__':
    main()
