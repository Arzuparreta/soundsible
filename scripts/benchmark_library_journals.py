"""Real canonical writes + HTTP deltas, against the previous local git revision.

Temporary databases live on the repository storage volume. Annotation stores
are real (initially empty). SQL loading, network, compression and audio are not
measured. Python peaks exclude the already-loaded library and native SQLite.
"""
import argparse
import ast
import importlib.util
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from flask import Flask
import shared.database as database
from shared.database import DatabaseManager
from shared.artwork import ArtworkStore
from shared.api import library_deltas as history
from shared.api.library_revision import validators
from shared.loudness import LoudnessStore, LoudnessMeasurement
from shared.loudness.store import reset_connections
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context
from scripts.benchmark_library_deltas import timed, apply
from scripts.benchmark_library_writes import measure


def reference_writer(revision):
    source = subprocess.check_output(['git', 'show', f'{revision}:shared/database.py'], cwd=ROOT, text=True)
    cls = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == 'DatabaseManager')
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name in {'replace_library', '_apply_schema'}]
    scope = dict(vars(database))
    exec(compile(ast.Module(body=methods, type_ignores=[]), '<reference writer>', 'exec'), scope)
    return type('ReferenceWriter', (DatabaseManager,), {name: scope[name] for name in ('replace_library', '_apply_schema')})


def route_module(revision):
    spec = importlib.util.spec_from_file_location('journal_benchmark_route', ROOT / 'shared/api/routes/library.py')
    route = importlib.util.module_from_spec(spec)
    if revision:
        source = subprocess.check_output(['git', 'show', f'{revision}:shared/api/routes/library.py'], cwd=ROOT, text=True)
        exec(compile(source, spec.origin, 'exec'), route.__dict__)
    else:
        spec.loader.exec_module(route)
    return route


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', default='cd2311b')
    parser.add_argument('--sizes', type=int, nargs='+', default=[1000, 10000, 50000])
    parser.add_argument('--cases', nargs='+', default=['title', 'playlist', 'artwork', 'loudness', 'remove', 'order'],
                        choices=['title', 'playlist', 'artwork', 'loudness', 'remove', 'order'])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--memory', action='store_true', help='extra memory-instrumented request for title edits')
    args = parser.parse_args()
    if args.repeats < 1 or any(n < 10 for n in args.sizes):
        parser.error('positive repeats and at least ten tracks required')
    for count in args.sizes:
        for name, reference in [('before', args.reference), ('after', None)]:
            with tempfile.TemporaryDirectory(prefix='soundsible-journals-', dir=ROOT.parent) as directory:
                root = Path(directory)
                reset_connections()
                validators.clear()
                art = ArtworkStore(root / 'art', root / 'art-cache')
                with (patch.object(history, 'get_cache_dir', return_value=root / 'history'),
                      patch('shared.artwork.artwork_store', return_value=art),
                      patch('shared.loudness.store.loudness_db_path', return_value=root / 'loudness.db'),
                      user_context('benchmark')):
                    route = route_module(reference)
                    db = (reference_writer(reference) if reference else DatabaseManager)(str(root / 'library.db'))
                    value = LibraryMetadata(1, [Track(
                        id=str(i), title=f'Title {i}', artist='Artist', artists=['Artist'], album=f'Album {i // 10}',
                        duration=180, file_hash=str(i), original_filename=f'{i}.mp3', compressed=False,
                        file_size=1000, bitrate=320, format='mp3',
                    ) for i in range(count)], {'List': ['0', '1']}, {}, last_updated='2026-01-01T00:00:00')
                    initial_write = measure(db, root / 'library.db', value)
                    lib = SimpleNamespace(db=db, metadata=value, refresh_if_stale=lambda: None)
                    route._get_api = lambda: {'get_core': lambda: (lib, None, None)}
                    app = Flask(__name__)
                    app.register_blueprint(route.library_bp)
                    client = app.test_client()
                    initial, initial_ms, _ = timed(lambda: client.get('/api/library?delta=1'))
                    accepted = initial.get_json()
                    etag = initial.headers['ETag']
                    print(json.dumps({'writer': name, 'tracks': count, 'case': 'initial',
                                      'write': initial_write, 'request_ms': round(initial_ms, 2)}), flush=True)
                    for case in args.cases:
                        durations, writes = [], []
                        peak = None
                        for iteration in range(args.repeats + int(args.memory and case == 'title')):
                            if case == 'title': value.tracks[0].title = f'Edited {iteration}'
                            elif case == 'playlist': value.playlists['List'][0] = f'external-{iteration}'
                            elif case == 'artwork': art.bind(value.tracks[0].id, f'cover-{iteration}', 'manual')
                            elif case == 'loudness':
                                LoudnessStore().put(value.tracks[0].file_hash, 'stamp', LoudnessMeasurement(-12 - iteration, -1, 4))
                            elif case == 'remove': value.tracks.pop()
                            elif case == 'order': value.tracks.reverse()
                            write = None
                            if case not in {'artwork', 'loudness'}:
                                write = measure(db, root / 'library.db', value)
                            base = etag[3:-1]
                            response, duration, measured_peak = timed(lambda: client.get('/api/library',
                                query_string={'delta': '1', 'since': base}, headers={'If-None-Match': etag}),
                                memory=args.memory and case == 'title' and iteration == args.repeats)
                            body = response.get_json()
                            assert body.get('kind') == 'delta', (case, response.status_code, body.keys())
                            accepted = apply(accepted, body)
                            full = client.get('/api/library')
                            assert accepted == full.get_json()
                            assert body['revision'] == full.headers['ETag'][3:-1]
                            etag = 'W/"' + body['revision'] + '"'
                            if iteration < args.repeats:
                                durations.append(duration)
                                if write: writes.append(write)
                            else:
                                peak = measured_peak
                        unchanged, unchanged_ms, _ = timed(lambda: client.get('/api/library?delta=1', headers={'If-None-Match': etag}))
                        assert unchanged.status_code == 304
                        with db._get_connection() as conn:
                            events = 0 if reference else conn.execute('SELECT COUNT(*) FROM public_changes').fetchone()[0]
                        history_bytes = (root / 'history/library-deltas.sqlite3').stat().st_size
                        print(json.dumps({'writer': name, 'tracks': count, 'case': case,
                            'request_ms': round(statistics.median(durations), 2), 'response_bytes': len(response.data),
                            'peak_python_bytes': peak, 'unchanged_ms': round(unchanged_ms, 2),
                            'write_ms': round(statistics.median(r['ms'] for r in writes), 2) if writes else None,
                            'write_wal_bytes': statistics.median(r['wal_bytes'] for r in writes) if writes else None,
                            'write_storage_bytes': statistics.median(r['storage_write_bytes'] for r in writes) if writes else None,
                            'journal_events': events, 'history_bytes': history_bytes}), flush=True)
                    reset_connections()
                    while db.pool_stats()['idle']:
                        db._pool.discard(db._pool.acquire())


if __name__ == '__main__':
    main()
