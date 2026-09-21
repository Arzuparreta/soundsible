"""Compare canonical writes with the frozen 2ad6db3 implementation.

Temporary databases live beside the repository on storage, not RAM-backed /tmp.
WAL growth excludes checkpoints; process write counters also include temporary
SQLite writes. These are synthetic storage costs, not playback measurements.
Run: venv/bin/python scripts/benchmark_library_writes.py --sizes 1000 10000 50000
"""
import argparse
from copy import deepcopy
import gc
import json
from pathlib import Path
import runpy
import statistics
import sys
import tempfile
import time
import tracemalloc
from types import FunctionType

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import shared.database as database
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track


def reference_class():
    frozen = runpy.run_path(str(ROOT / 'tests/fixtures/library_writer_reference.py'))

    class Legacy(DatabaseManager):
        replace_library = FunctionType(frozen['replace_library'].__code__, vars(database))
        _replace_catalog_projection = staticmethod(FunctionType(frozen['_replace_catalog_projection'].__code__, vars(database)))
    Legacy.replace_library.__kwdefaults__ = frozen['replace_library'].__kwdefaults__
    return Legacy


def io_counts():
    path = Path('/proc/self/io')
    if not path.exists():
        return {}
    return {line.split(':')[0]: int(line.split(':')[1]) for line in path.read_text().splitlines()}


def measure(db, path, value, memory=False):
    with db._get_connection() as conn:
        conn.execute('PRAGMA wal_autocheckpoint=0')
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    gc.collect()
    before = io_counts()
    if memory:
        tracemalloc.start()
    start = time.perf_counter()
    db.replace_library(value)
    elapsed = (time.perf_counter() - start) * 1000
    after = io_counts()
    peak = None
    if memory:
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    wal = Path(str(path) + '-wal')
    return {'ms': round(elapsed, 2), 'wal_bytes': wal.stat().st_size if wal.exists() else 0,
            'write_syscall_bytes': after.get('wchar', 0) - before.get('wchar', 0),
            'storage_write_bytes': after.get('write_bytes', 0) - before.get('write_bytes', 0),
            'peak_python_bytes': peak}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', type=int, nargs='+', default=[1000, 10000, 50000])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--memory', action='store_true')
    args = parser.parse_args()
    if args.repeats < 1 or any(size < 1 for size in args.sizes):
        parser.error('positive sizes and repeats required')
    for count in args.sizes:
        value = LibraryMetadata(1, [Track(
            id=str(i), title=f'Title {i}', artist=f'Artist {i // 100}', album=f'Album {i // 10}',
            duration=180, file_hash=str(i), original_filename=f'{i}.mp3', compressed=False,
            file_size=1000, bitrate=320, format='mp3',
        ) for i in range(count)], {'List': [str(i) for i in range(min(count, 100))], 'Empty': []}, {},
            last_updated='2026-01-01T00:00:00')
        with tempfile.TemporaryDirectory(prefix='soundsible-write-bench-', dir=ROOT.parent) as directory:
            for name, cls in [('before', reference_class()), ('after', DatabaseManager)]:
                path = Path(directory) / (name + '.db')
                db = cls(str(path))
                initial = measure(db, path, deepcopy(value))
                print(json.dumps({'tracks': count, 'writer': name, 'case': 'initial', **initial}), flush=True)
                for case in ('same', 'title', 'playlist', 'album', 'order'):
                    samples = []
                    for iteration in range(args.repeats + int(args.memory)):
                        db.replace_library(deepcopy(value))
                        changed = deepcopy(value)
                        if case == 'title': changed.tracks[0].title = 'Edited'
                        elif case == 'playlist': changed.playlists['List'][0] = 'external'
                        elif case == 'album': changed.tracks[0].album = 'Different'
                        elif case == 'order': changed.tracks.reverse()
                        result = measure(db, path, changed, memory=args.memory and iteration == args.repeats)
                        if iteration < args.repeats:
                            samples.append(result)
                    summary = {key: statistics.median(row[key] for row in samples)
                               for key in ('ms', 'wal_bytes', 'write_syscall_bytes', 'storage_write_bytes')}
                    summary['peak_python_bytes'] = result['peak_python_bytes']
                    print(json.dumps({'tracks': count, 'writer': name, 'case': case, **summary}), flush=True)
                while db.pool_stats()["idle"]:
                    db._pool.discard(db._pool.acquire())


if __name__ == '__main__':
    main()
