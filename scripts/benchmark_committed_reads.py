"""Library reads that answer from committed state, and pool commits that skip rereads.

Runs the same measurements against this checkout and, with --reference, an
exported copy of another git revision (its code, this benchmark). Temporary
databases, history, annotation stores and pool manifests live on the
repository's storage volume. Network, compression and playback are excluded.

Each size runs in a disposable runtime (config, data, cache and music
directories under one temporary root) with a real LibraryManager whose
portable export is the music folder's library.json, as on a single-account
instance, and a Downloader on that same file.

- poll_304_ms: a conditional GET /api/library whose ETag is still current.
- edit_delta_ms: GET /api/library?delta=1 after LibraryManager.patch_track_metadata
  changed one title; every delta is applied and compared with a full response.
- pool_commit_*: Downloader.commit_track when only the pool wrote the file.
- cycle_commit_*: the pool commit in a steady-state single-account download;
  the account then admits that same track and exports into the shared file.
  cycle_total_ms includes both steps.

Bytes come from /proc/self/io `rchar`: every read the commit made, page-cache
hits included.
"""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def read_bytes():
    with open('/proc/self/io') as stream:
        return next(int(line.split()[1]) for line in stream if line.startswith('rchar'))


def apply(body, delta):
    from copy import deepcopy
    body = deepcopy(body)
    rows = {row['id']: row for row in body['tracks']}
    for key in delta['removed']:
        del rows[key]
    rows.update((row['id'], row) for row in delta['upserts'])
    body['tracks'] = [rows[key] for key in delta.get('order', rows)]
    body.update(delta['fields'])
    return body


def measure(code, count, repeats, scratch):
    sys.path.insert(0, str(code))
    from dataclasses import replace
    import threading
    from flask import Flask
    from scripts.benchmark_library_export import library
    from shared.runtime import RuntimeConfig, configure_runtime

    podcasts = {f'feed-{f}': {'fetched_at': '2026-01-01T00:00:00', 'episodes': [
        {'guid': f'{f}-{e}', 'title': f'Episode {e}', 'description': 'x' * 400} for e in range(20)]}
        for f in range(20)}
    result = {'tracks': count}
    with tempfile.TemporaryDirectory(prefix='soundsible-committed-', dir=scratch) as directory:
        root = Path(directory)
        # A disposable runtime: no lock, database or export outside `root`.
        runtime = RuntimeConfig.default({f'SOUNDSIBLE_{key.upper()}_DIR': str(root / key)
                                         for key in ('config', 'data', 'cache', 'log', 'music')})
        configure_runtime(runtime)
        from shared.app_config import set_output_dir
        set_output_dir(runtime.music_dir)
        from player.library import LibraryManager
        from shared.api.routes import library as route
        from shared.downloader.service import Downloader
        from shared.models import LibraryMetadata
        from shared.user_context import user_context

        with user_context('benchmark'):
            manager = LibraryManager(silent=True)
            manager.metadata = library(count)
            manager.metadata.podcast_episode_cache = podcasts
            assert manager._save_metadata()
            route._get_api = lambda: {'get_library': lambda: manager}
            app = Flask(__name__)
            app.register_blueprint(route.library_bp)
            client = app.test_client()
            first = client.get('/api/library?delta=1')
            accepted, etag = first.get_json(), first.headers['ETag']
            polls = []
            for _ in range(repeats):
                started = time.perf_counter()
                response = client.get('/api/library', headers={'If-None-Match': etag})
                polls.append((time.perf_counter() - started) * 1000)
                assert response.status_code == 304
            deltas = []
            for iteration in range(repeats):
                # The production label edit, not a whole-library save.
                assert manager.patch_track_metadata(manager.metadata.tracks[0].id, {'title': f'Edited {iteration}'})
                started = time.perf_counter()
                response = client.get('/api/library', query_string={'delta': '1', 'since': etag[3:-1]},
                                      headers={'If-None-Match': etag})
                deltas.append((time.perf_counter() - started) * 1000)
                body = response.get_json()
                assert body.get('kind') == 'delta', response.status_code
                accepted = apply(accepted, body)
                full = client.get('/api/library')
                assert accepted == full.get_json() and body['revision'] == full.headers['ETag'][3:-1]
                etag = 'W/"' + body['revision'] + '"'
            result.update(poll_304_ms=round(statistics.median(polls), 2),
                          edit_delta_ms=round(statistics.median(deltas), 2), delta_bytes=len(response.data))

            pool = Downloader.__new__(Downloader)
            pool.library_path = runtime.music_dir / 'library.json'
            pool._lock = threading.Lock()
            pool.library = pool._load_library()   # The Station's export of the account.
            extra = iter(library(count + 2 * repeats + 2).tracks[count:])

            def commit(track):
                before, started = read_bytes(), time.perf_counter()
                pool.commit_track(track)
                elapsed = (time.perf_counter() - started) * 1000
                return elapsed, read_bytes() - before

            def download():
                cycle = time.perf_counter()
                track = next(extra)
                elapsed, reads = commit(track)
                manager.metadata.add_track(replace(track, item_id=None))
                assert manager._save_metadata()
                return elapsed, reads, (time.perf_counter() - cycle) * 1000

            pool.commit_track(next(extra))
            times, reads = zip(*(commit(next(extra)) for _ in range(repeats)))
            result['pool_commit_ms'] = round(statistics.median(times), 2)
            result['pool_commit_read_bytes'] = statistics.median(reads)

            # Reset to the Station's original track list, then let one complete
            # download warm the shared manifest before timing the steady state.
            assert manager._save_metadata()
            pool.library = pool._load_library()
            download()
            times, reads, cycles = zip(*(download() for _ in range(repeats)))
            result['cycle_commit_ms'] = round(statistics.median(times), 2)
            result['cycle_commit_read_bytes'] = statistics.median(reads)
            result['cycle_total_ms'] = round(statistics.median(cycles), 2)
            saved = LibraryMetadata.from_json(pool.library_path.read_text())
            assert saved.podcast_episode_cache == podcasts
            assert [track.id for track in saved.tracks] == [track.id for track in manager.metadata.tracks]
            result['manifest_bytes'] = pool.library_path.stat().st_size
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--reference', help='git revision to compare against, e.g. origin/main')
    parser.add_argument('--sizes', type=int, nargs='+', default=[1000, 10000, 50000])
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--code', help=argparse.SUPPRESS)
    parser.add_argument('--label', default='candidate', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.repeats < 1 or any(n < 10 for n in args.sizes):
        parser.error('positive repeats and at least ten tracks required')
    if args.code:
        for count in args.sizes:
            print(json.dumps({'code': args.label, **measure(Path(args.code), count, args.repeats, ROOT.parent)}),
                  flush=True)
        return
    with tempfile.TemporaryDirectory(prefix='soundsible-reference-', dir=ROOT.parent) as exported:
        runs = [('candidate', ROOT)]
        if args.reference:
            archive = subprocess.run(['git', 'archive', args.reference], cwd=ROOT, check=True, capture_output=True).stdout
            subprocess.run(['tar', '-x', '-C', exported], input=archive, check=True)
            runs.insert(0, ('reference', Path(exported)))
        # One fresh interpreter per code base; sizes run in order inside it.
        for label, code in runs:
            subprocess.run([sys.executable, __file__, '--code', str(code), '--label', label, '--repeats',
                            str(args.repeats), '--sizes', *map(str, args.sizes)], check=True, cwd=code)


if __name__ == '__main__':
    main()
