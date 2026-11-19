"""Library reads that answer from committed state, and pool commits that skip rereads.

Runs the same measurements against this checkout and, with --reference, an
exported copy of another git revision (its code, this benchmark). Temporary
databases, history, annotation stores and pool manifests live on the
repository's storage volume. Network, compression and playback are excluded.

- poll_304_ms: a conditional GET /api/library whose ETag is still current.
- delta_ms: GET /api/library?delta=1 after one committed title edit; every
  delta is applied and compared with an unconditional full response.
- commit_ms / commit_read_bytes: Downloader.commit_track on a pool manifest
  that only the pool wrote; bytes come from /proc/self/io `rchar`, so they
  include every read the commit made, not only the manifest's.
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
    from types import SimpleNamespace
    from unittest.mock import patch
    import threading
    from flask import Flask
    from shared.api import library_deltas as history
    from shared.api.routes import library as route
    from shared.artwork import ArtworkStore
    from shared.database import DatabaseManager
    from shared.downloader.service import Downloader
    from shared.loudness.store import reset_connections
    from shared.models import LibraryMetadata, Track
    from shared.user_context import user_context

    def track(i):
        return Track(id=str(i), title=f'Title {i}', artist='Artist', artists=['Artist'], album=f'Album {i // 10}',
                     duration=180, file_hash=str(i), original_filename=f'{i}.mp3',
                     file_size=1000, bitrate=320, format='mp3')

    podcasts = {f'feed-{f}': {'fetched_at': '2026-01-01T00:00:00', 'episodes': [
        {'guid': f'{f}-{e}', 'title': f'Episode {e}', 'description': 'x' * 400} for e in range(20)]}
        for f in range(20)}
    result = {'tracks': count}
    with tempfile.TemporaryDirectory(prefix='soundsible-committed-', dir=scratch) as directory:
        root = Path(directory)
        reset_connections()
        art = ArtworkStore(root / 'art', root / 'art-cache')
        with (patch.object(history, 'get_cache_dir', return_value=root / 'history'),
              patch('shared.artwork.artwork_store', return_value=art),
              patch('shared.loudness.store.loudness_db_path', return_value=root / 'loudness.db'),
              user_context('benchmark')):
            db = DatabaseManager(str(root / 'library.db'))
            value = LibraryMetadata(1, [track(i) for i in range(count)], {'List': ['0', '1']}, {},
                                    last_updated='2026-01-01T00:00:00', podcast_episode_cache=podcasts)
            db.replace_library(value)
            lib = SimpleNamespace(db=db, metadata=value, refresh_if_stale=lambda: None)
            route._get_api = lambda: {'get_library': lambda: lib}
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
                value.tracks[0].title = f'Edited {iteration}'
                db.replace_library(value)
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
            result.update(poll_304_ms=round(statistics.median(polls), 2), delta_ms=round(statistics.median(deltas), 2),
                          delta_bytes=len(response.data))
            reset_connections()

        pool = Downloader.__new__(Downloader)
        pool.library_path = root / 'pool' / 'library.json'
        pool.library_path.parent.mkdir()
        pool._lock = threading.Lock()
        initial = LibraryMetadata(1, [track(i) for i in range(count)], {}, {}, podcast_episode_cache=podcasts)
        pool.library_path.write_text(initial.to_json())
        pool.library = pool._load_library()
        pool.commit_track(track(count))
        commits, reads = [], []
        for iteration in range(repeats):
            before, started = read_bytes(), time.perf_counter()
            pool.commit_track(track(count + 1 + iteration))
            commits.append((time.perf_counter() - started) * 1000)
            reads.append(read_bytes() - before)
        saved = LibraryMetadata.from_json(pool.library_path.read_text())
        assert len(saved.tracks) == count + 1 + repeats and saved.podcast_episode_cache == podcasts
        result.update(commit_ms=round(statistics.median(commits), 2), commit_read_bytes=statistics.median(reads),
                      manifest_bytes=pool.library_path.stat().st_size)
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
