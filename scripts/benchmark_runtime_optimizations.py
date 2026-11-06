"""Alternate reference/current complete library operations in disposable runtimes.

HTTP uses the real library route, SQLite, artwork and loudness stores. Only core
lookup is bound to the fixture. Saves include SQLite plus both local exports;
download commits include revision checks, podcast preservation and publication.
No user data, production engine, network provider or audible playback is used.
"""
import argparse
import ast
from contextlib import ExitStack, contextmanager
from dataclasses import replace
import gc
import hashlib
import importlib
import json
import os
import platform
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def source(reference, path):
    return subprocess.check_output(['git', 'show', f'{reference}:{path}'], cwd=ROOT, text=True)


def old_methods(reference, module_name, class_name, names):
    module = importlib.import_module(module_name)
    tree = ast.parse(source(reference, module_name.replace('.', '/') + '.py'))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    scope = dict(vars(module))
    definitions = {}
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name in names]
    exec(compile(ast.Module(body=methods, type_ignores=[]), '<reference methods>', 'exec'), scope, definitions)
    return [(getattr(module, class_name), name, definitions[name]) for name in names]


def controls(reference):
    from shared import library_fingerprint, library_changes, library_search
    from shared.downloader import service
    groups = {'fields': old_methods(reference, 'shared.models', 'Track', ['to_public_dict', 'from_dict']),
              'pool': old_methods(reference, 'shared.models', 'LibraryMetadata', ['iter_json']),
              'edit': old_methods(reference, 'player.library', 'LibraryManager', ['patch_track_metadata'])
                      + old_methods(reference, 'shared.database', 'DatabaseManager', ['patch_track_metadata']),
              'artwork': old_methods(reference, 'shared.artwork_variants', 'VariantCache', ['open', 'hit', 'index'])}
    scope = dict(vars(library_search))
    exec(compile(source(reference, 'shared/library_search.py'), '<reference search>', 'exec'), scope)
    groups['search'] = [(library_search._Digest, '__init__', scope['_Digest'].__init__),
                        (library_search, 'VERSION', scope['VERSION'])]
    for module, name in ((library_fingerprint, 'fingerprint'), (library_changes, 'sync_source')):
        scope = dict(vars(module))
        exec(compile(source(reference, module.__name__.replace('.', '/') + '.py'), '<reference module>', 'exec'), scope)
        groups['fields'].append((module, name, scope[name]))
    # Each baseline method retains its original module globals/imports.
    scope = dict(vars(service))
    exec(compile(source(reference, 'shared/downloader/service.py'), '<reference pool>', 'exec'), scope)
    for name in ('commit_track', 'replace_snapshot', '_save_library_locked'):
        groups['pool'].append((service.Downloader, name, getattr(scope['Downloader'], name)))
    return groups


@contextmanager
def variant(groups, label):
    with ExitStack() as stack:
        enabled = set(groups) if label == 'current' else {label}
        for group, changes in groups.items():
            if group not in enabled:
                for target, name, previous in changes:
                    stack.enter_context(patch.object(target, name, previous))
        # Routes that import the function at module scope must use the same
        # implementation as the canonical writer and late-importing callers.
        from shared.api import library_revision, library_incremental
        from shared import library_fingerprint
        stack.enter_context(patch.object(library_revision, 'fingerprint', library_fingerprint.fingerprint))
        stack.enter_context(patch.object(library_incremental, 'fingerprint', library_fingerprint.fingerprint))
        yield


def fixture(root, count):
    from scripts.benchmark_library_export import library
    from shared.runtime import RuntimeConfig, configure_runtime
    from shared.app_config import set_output_dir
    env = {f'SOUNDSIBLE_{key.upper()}_DIR': str(root / key) for key in ('config', 'data', 'cache', 'log', 'music')}
    runtime = RuntimeConfig.default(env)
    configure_runtime(runtime)
    set_output_dir(runtime.music_dir)
    from player.library import LibraryManager
    from shared.downloader.service import Downloader
    from shared.api.routes import library as route
    from flask import Flask
    manager = LibraryManager(silent=True)
    manager.metadata = library(count)
    assert manager._save_metadata()
    pool = Downloader.__new__(Downloader)
    pool._lock = threading.Lock()
    pool.library_path = root / 'pool' / 'library.json'
    pool.library = library(count)
    pool.library.podcast_subscriptions = [{'id': 'feed', 'title': 'Podcast'}]
    pool.library.podcast_episode_cache = {'feed': {'episodes': [{'title': 'Episode'}]}}
    pool.save_library()
    app = Flask(__name__)
    app.register_blueprint(route.library_bp)
    return manager, pool, app.test_client(), runtime


def run(args, groups, output):
    from shared.user_context import user_context
    from shared.database import reset_database_managers
    from shared.api.routes import library as route
    from shared.api.library_revision import validators
    from shared.loudness.store import reset_connections
    from shared.models import LibraryMetadata
    from shared.runtime import configure_runtime
    from shared.app_config import set_output_dir
    paths = ['shared/models.py', 'shared/library_json.py', 'shared/library_fingerprint.py', 'shared/library_search.py',
             'shared/artwork_variants.py', 'scripts/benchmark_runtime_optimizations.py',
             'shared/library_changes.py', 'shared/downloader/service.py', 'shared/downloader/library_podcasts.py']
    output.write(json.dumps({'reference': args.reference, 'python': sys.version, 'platform': platform.platform(),
                             'load_average_at_start': os.getloadavg(), 'repeats': args.repeats,
                             'source_sha256': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in paths},
                             'scope': __doc__}) + '\n')
    for count in args.sizes:
        with tempfile.TemporaryDirectory(prefix='soundsible-runtime-', dir=ROOT.parent) as temporary, user_context('benchmark'):
            sides = {}
            for label in args.variants:
                with variant(groups, label):
                    sides[label] = fixture(Path(temporary) / label, count)
            for case in args.cases:
                samples = {label: [] for label in sides}
                cpus = {label: [] for label in sides}
                for repeat in range(args.repeats):
                    labels = args.variants if repeat % 2 == 0 else args.variants[::-1]
                    for label in labels:
                        manager, pool, client, runtime = sides[label]
                        configure_runtime(runtime)
                        set_output_dir(runtime.music_dir)
                        reset_connections()
                        with variant(groups, label), patch.object(route, '_get_api', return_value={'get_core': lambda: (manager, None, None)}):
                            headers = {}
                            if case in ('revalidate', 'delta'):
                                first = client.get('/api/library?delta=1' if case == 'delta' else '/api/library')
                                assert first.status_code == 200
                                headers = {'If-None-Match': first.headers['ETag']}
                                if case == 'delta':
                                    headers = {}
                                    url = '/api/library?delta=1&since=' + first.get_etag()[0]
                                    assert manager.patch_track_metadata(manager.metadata.tracks[0].id, {'title': f'Delta {repeat}'})
                            gc.collect()
                            cpu = time.process_time()
                            start = time.perf_counter()
                            if case in ('revalidate', 'full', 'delta'):
                                result = client.get(url if case == 'delta' else '/api/library', headers=headers)
                            elif case == 'edit':
                                result = manager.patch_track_metadata(manager.metadata.tracks[0].id, {'title': f'Edited {repeat}'})
                            elif case == 'save':
                                manager.metadata.tracks[0].title = f'Saved {repeat}'
                                result = manager._save_metadata()
                            elif case == 'export':
                                result = manager._export_metadata()
                            elif case == 'download':
                                result = pool.commit_track(replace(pool.library.tracks[-1], title=f'Download {repeat}'))
                            elif case == 'load_pool':
                                result = pool.read_snapshot()
                            samples[label].append((time.perf_counter() - start) * 1000)
                            cpus[label].append((time.process_time() - cpu) * 1000)
                            if case == 'revalidate':
                                assert result.status_code == 304 and not result.data
                            elif case in ('full', 'delta'):
                                assert result.status_code == 200
                                if case == 'delta':
                                    assert result.json['kind'] == 'delta'
                                    assert result.json['upserts'][0]['title'] == f'Delta {repeat}'
                                else:
                                    assert len(result.json['tracks']) == count
                            elif case in ('edit', 'save', 'export'):
                                assert result is True or case == 'export'
                                expected = manager.metadata.to_json()
                                assert manager.manifest_path.read_text() == expected
                                assert (runtime.music_dir / 'library.json').read_text() == expected
                                assert manager.db.load_library_metadata().tracks[0].title == manager.metadata.tracks[0].title
                            elif case == 'download':
                                assert pool.library_path.read_text() == pool.library.to_json()
                                assert pool.library.podcast_subscriptions == [{'id': 'feed', 'title': 'Podcast'}]
                            elif case == 'load_pool':
                                assert isinstance(result[0], LibraryMetadata) and len(result[0].tracks) == count
                row = {'case': case, 'tracks': count,
                       **{label: {'median_ms': statistics.median(samples[label]), 'samples_ms': samples[label],
                                  'cpu_median_ms': statistics.median(cpus[label])} for label in sides}}
                output.write(json.dumps(row) + '\n')
                output.flush()
                print(json.dumps(row), flush=True)
            reset_database_managers()
            reset_connections()
            validators.clear()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', default='3c7e4af39a523141de21f14f3891e935728bc864')
    parser.add_argument('--repeats', type=int, default=7)
    parser.add_argument('--sizes', nargs='+', type=int, default=[200, 10000, 50000])
    parser.add_argument('--variants', nargs='+', choices=['baseline', 'fields', 'pool', 'edit', 'artwork', 'search', 'current'], default=['baseline', 'current'])
    parser.add_argument('--cases', nargs='+', choices=['revalidate', 'full', 'delta', 'edit', 'save', 'export', 'download', 'load_pool'],
                        default=['revalidate', 'full', 'delta', 'edit', 'save', 'export', 'download', 'load_pool'])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if min(args.sizes) < 1 or args.repeats < 1:
        parser.error('sizes and repeats must be positive')
    groups = controls(args.reference)
    with args.output.open('w') as output:
        run(args, groups, output)


if __name__ == '__main__':
    main()
