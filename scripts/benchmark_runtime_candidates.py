"""Measure complete shell checks and local-search HTTP with alternative digests.

Disposable files and real local SQLite/ranking/JSON only. Network providers and
the production instance are excluded. No browser, bundle build or audio runs.
"""
import argparse
from hashlib import blake2b, sha256
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def samples(calls, repeats):
    values = {name: [] for name in calls}
    cpus = {name: [] for name in calls}
    for repeat in range(repeats):
        labels = list(calls) if repeat % 2 == 0 else list(calls)[::-1]
        for name in labels:
            cpu = time.process_time()
            start = time.perf_counter()
            response = calls[name]()
            values[name].append((time.perf_counter() - start) * 1000)
            cpus[name].append((time.process_time() - cpu) * 1000)
            assert response.status_code == 200
    return {name: {'median_ms': statistics.median(values[name]), 'samples_ms': values[name],
                   'cpu_median_ms': statistics.median(cpus[name])} for name in calls}


def shell(args):
    import shared.ensure_ui_dist as current
    from flask import Flask, send_file
    source = subprocess.check_output(['git', 'show', f'{args.reference}:shared/ensure_ui_dist.py'], text=True, cwd=ROOT)
    previous = dict(vars(current))
    exec(compile(source, '<reference shell>', 'exec'), previous)
    with tempfile.TemporaryDirectory(prefix='soundsible-shell-', dir=ROOT.parent) as directory:
        root = Path(directory) / 'ui_web'
        paths = list(previous['_iter_input_files'](ROOT / 'ui_web'))
        for path in paths:
            target = root / os.path.relpath(path, ROOT / 'ui_web')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture')
            os.utime(target, (100, 100))
        index = root / 'dist' / 'index.html'
        index.parent.mkdir()
        index.write_text('<html><body>Fixture shell</body></html>')
        os.utime(index, (200, 200))
        signature, _ = current._input_signature(root)
        info = index.stat()
        (index.parent / current._INPUT_MANIFEST).write_text(json.dumps({
            'inputs': signature, 'bundle': [info.st_mtime_ns, info.st_size]}))
        calls = {}
        for label, ensure in [('baseline', previous['ensure_ui_dist']), ('current', current.ensure_ui_dist)]:
            app = Flask(label)

            def view(ensure=ensure):
                assert ensure(ui_web=root)
                return send_file(index)

            app.add_url_rule('/player', view_func=view)
            client = app.test_client()
            calls[label] = lambda client=client: client.get('/player')
        result = samples(calls, args.repeats)
        removed = next(path for path in paths if path.is_relative_to(ROOT / 'ui_web' / 'src'))
        (root / removed.relative_to(ROOT / 'ui_web')).unlink()
        assert not previous['ui_dist_is_stale'](root)
        assert current.ui_dist_is_stale(root)
        return {'case': 'shell_http', 'input_files': len(paths), **result,
                'deleted_source_detected': {'baseline': False, 'current': True}}


def search(args):
    from scripts.benchmark_runtime_optimizations import fixture
    from shared import library_search
    from shared.user_context import user_context
    from shared.api.routes import catalog
    from shared.database import reset_database_managers
    from flask import Flask, jsonify
    results = []
    with tempfile.TemporaryDirectory(prefix='soundsible-search-', dir=ROOT.parent) as directory, user_context('benchmark'):
        manager, _, _, _ = fixture(Path(directory), args.tracks)
        tracks = catalog._LibraryTracks(manager.metadata.tracks)
        tracks.search_db = manager.db
        app = Flask(__name__)
        app.add_url_rule('/local-search/<query>', view_func=lambda query: jsonify(catalog._local_catalog(query, 30)))
        client = app.test_client()
        with patch.object(catalog, '_library_tracks', return_value=tracks):
            for query in ('song 4242', 'zzqx', 'so'):
                reference = None
                calls = {}
                fingerprints = {}
                for name, factory in [('blake2b', lambda: blake2b(digest_size=32)), ('sha256', sha256)]:
                    with patch.object(library_search._Digest, '__init__', lambda self, factory=factory: setattr(self, 'digest', factory())):
                        fingerprints[name] = library_search.model_fingerprint(tracks)

                    def call(name=name, factory=factory):
                        # Digest maintenance is setup, not search work; avoid
                        # measuring a SQLite write/fsync in each read sample.
                        with patch.object(library_search._Digest, '__init__', lambda self: setattr(self, 'digest', factory())):
                            return client.get('/local-search/' + query)

                    calls[name] = call
                # Both fingerprints describe identical rows. Persist the proof
                # between batches, excluding maintenance from read timings.
                stats = {name: [] for name in calls}
                for repeat in range(args.search_repeats):
                    names = list(calls) if repeat % 2 == 0 else list(calls)[::-1]
                    for name in names:
                        with manager.db._get_connection() as conn:
                            conn.execute('UPDATE library_search_state SET fingerprint=? WHERE singleton=1', (fingerprints[name],))
                        response = calls[name]()
                        if reference is None:
                            reference = response.json
                        assert response.json == reference
                        result = samples({name: calls[name]}, 1)[name]
                        stats[name].append(result)
                row = {'case': 'local_search_http', 'query': query, 'tracks': args.tracks}
                for name in calls:
                    values = [r['median_ms'] for r in stats[name]]
                    cpus = [r['cpu_median_ms'] for r in stats[name]]
                    row[name] = {'median_ms': statistics.median(values), 'samples_ms': values,
                                 'cpu_median_ms': statistics.median(cpus)}
                results.append(row)
            migrations = {'refold': [], 'rehash': []}
            for repeat in range(5):
                for name in (('refold', 'rehash') if repeat % 2 == 0 else ('rehash', 'refold')):
                    with manager.db._get_connection() as conn:
                        conn.execute('UPDATE library_search_state SET version=? WHERE singleton=1',
                                     (library_search._PREVIOUS_HASH_VERSION,))
                        conn.commit()
                        previous = library_search._PREVIOUS_HASH_VERSION if name == 'rehash' else ''
                        with patch.object(library_search, '_PREVIOUS_HASH_VERSION', previous):
                            start = time.perf_counter()
                            library_search.sync(conn)
                            conn.commit()
                            migrations[name].append((time.perf_counter() - start) * 1000)
            results.append({'case': 'search_digest_migration', 'tracks': args.tracks,
                            **{name: {'median_ms': statistics.median(values), 'samples_ms': values}
                               for name, values in migrations.items()}})
        reset_database_managers()
    return results


def artwork(args):
    import io
    from PIL import Image
    from flask import Flask
    import shared.artwork as art
    from shared.api.routes import playback
    from scripts.benchmark_runtime_optimizations import controls, variant
    groups = controls(args.reference)
    with tempfile.TemporaryDirectory(prefix='soundsible-covers-', dir=ROOT.parent) as directory:
        root = Path(directory)
        store = art.ArtworkStore(root / 'originals', root / 'variants')
        expected = {}
        for i in range(50):
            raw = io.BytesIO()
            Image.new('RGB', (640, 500), (i * 5, 100, 50)).save(raw, 'PNG')
            digest = store.put(raw.getvalue())
            store.bind(str(i), digest, 'manual')
            item = store.open_variant(digest, 320)
            expected[str(i)] = item.file.read()
            item.file.close()
        lib = SimpleNamespace(get_cover_url=lambda track: store.path(track.id))
        api = {'get_core': lambda: (lib, None, None),
               'get_track_by_id': lambda lib, identity: SimpleNamespace(id=identity, cover_source='manual')}
        app = Flask(__name__)
        app.register_blueprint(playback.playback_bp)
        client = app.test_client()

        def grid(label):
            with variant(groups, label):
                for identity, jpeg in expected.items():
                    response = client.get('/api/static/cover/' + identity + '?size=320')
                    assert response.status_code == 200 and response.data == jpeg
                    response.close()
            return SimpleNamespace(status_code=200)

        with patch.object(playback, '_get_api', return_value=api), patch.object(art, 'artwork_store', return_value=store):
            stats = samples({label: lambda label=label: grid(label) for label in ('baseline', 'current')}, args.search_repeats)
        return {'case': 'artwork_grid_http', 'covers': len(expected), **stats}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', default='3c7e4af39a523141de21f14f3891e935728bc864')
    parser.add_argument('--repeats', type=int, default=31)
    parser.add_argument('--search-repeats', type=int, default=15)
    parser.add_argument('--tracks', type=int, default=50000)
    parser.add_argument('--cases', nargs='+', choices=['shell', 'search', 'artwork'], default=['shell', 'search', 'artwork'])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    with args.output.open('w') as output:
        paths = ['shared/ensure_ui_dist.py', 'shared/library_search.py', 'shared/artwork_variants.py',
                 'scripts/benchmark_runtime_candidates.py']
        output.write(json.dumps({'reference': args.reference, 'python': sys.version,
                                 'source_sha256': {path: sha256((ROOT / path).read_bytes()).hexdigest() for path in paths}}) + '\n')
        operations = {'shell': lambda: [shell(args)], 'search': lambda: search(args), 'artwork': lambda: [artwork(args)]}
        for name in args.cases:
            for row in operations[name]():
                output.write(json.dumps(row) + '\n')
                output.flush()
                print(json.dumps(row), flush=True)
