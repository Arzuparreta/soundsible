"""Disk history, ordered delta equivalence and transparent HTTP fallback."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import sqlite3

from flask import Flask
import pytest

from shared.api import library_deltas as history
from shared.models import LibraryMetadata, Track
from shared.runtime import get_cache_dir


def snapshot(count=30):
    return LibraryMetadata(1, [Track(
        id=f'song-{i}', title=f'Song {i}', artist='Artist', album='Album', duration=180,
        file_hash=str(i), original_filename=f'{i}.mp3', compressed=False,
        file_size=1000, bitrate=320, format='mp3',
    ) for i in range(count)], {'Old': ['song-0']}, {'old': True},
        podcast_subscriptions=[{'id': 'feed'}], podcast_episode_cache={'feed': {'episodes': []}})


def apply(base, delta):
    result = deepcopy(base)
    rows = {track['id']: track for track in result['tracks']}
    for track_id in delta['removed']:
        del rows[track_id]
    for track in delta['upserts']:
        rows[track['id']] = track
    result['tracks'] = [rows[track_id] for track_id in delta.get('order', rows)]
    result.update(delta['fields'])
    return result


@pytest.mark.parametrize('change', ['edit', 'add', 'remove', 'order', 'empty', 'headers', 'annotations'])
def test_persistent_delta_equals_full_snapshot(change):
    before = snapshot().to_public_dict()
    before['tracks'][0]['loudness_lufs'] = -12
    after = deepcopy(before)
    if change == 'edit': after['tracks'][0]['title'] = 'Edited'
    elif change == 'add': after['tracks'].append({**after['tracks'][0], 'id': 'new'})
    elif change == 'remove': after['tracks'].pop(0)
    elif change == 'order': after['tracks'].reverse()
    elif change == 'empty': after['tracks'].clear()
    elif change == 'headers':
        after.update(playlists={}, settings={}, podcast_subscriptions=[], podcast_episode_cache={})
    elif change == 'annotations':
        del after['tracks'][0]['loudness_lufs']
        after['tracks'][1]['artwork_revision'] = 'new'
    assert history.exchange('a', 'before', before) is None
    # Each call reopens disk. No Python history object survives the exchange.
    delta = history.exchange('a', 'after', after, 'before')
    assert apply(before, delta) == after
    assert ('order' in delta) == (change in {'add', 'remove', 'order', 'empty'})
    assert history.exchange('b', 'after', after, 'before') is None


def test_expiry_count_byte_limits_and_no_payload_storage(monkeypatch):
    body = snapshot(5).to_public_dict()
    now = [1000.0]
    monkeypatch.setattr(history.time, 'time', lambda: now[0])
    for index in range(7):
        now[0] += 1
        history.exchange('a', str(index), body)
    with history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM revisions').fetchone()[0] == 4
        assert db.execute('SELECT revision FROM revisions ORDER BY created').fetchall() == [('3',), ('4',), ('5',), ('6',)]
        assert db.execute('SELECT length(hash) FROM rows LIMIT 1').fetchone()[0] == 32
    assert history.exchange('a', '7', body, '0') is None
    now[0] += history.TTL + 1
    assert history.exchange('a', '8', body, '7') is None
    with history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM revisions').fetchone()[0] == 1
        size = db.execute('SELECT bytes FROM revisions').fetchone()[0]
    monkeypatch.setattr(history, 'MAX_BYTES', size * 2 + 4096)
    for i in range(6):
        history.exchange(f'user{i}', str(i), body)
    with history.connection() as db:
        assert db.execute('SELECT SUM(bytes) FROM revisions').fetchone()[0] <= history.MAX_BYTES
    # Oversized histories are not admitted, even though serving a full library works.
    assert history.exchange('huge', 'large', snapshot(1000).to_public_dict()) is None
    with history.connection() as db:
        assert not db.execute("SELECT 1 FROM revisions WHERE account='huge'").fetchone()


def test_duplicate_ids_rollback_and_concurrent_admission():
    body = snapshot().to_public_dict()
    bad = deepcopy(body)
    bad['tracks'].append(bad['tracks'][0])
    with pytest.raises(sqlite3.IntegrityError):
        history.exchange('a', 'bad', bad)
    with history.connection() as db:
        assert not db.execute('SELECT 1 FROM revisions').fetchone()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(lambda _: history.exchange('a', 'same', body), range(2))) == [None, None]
    with history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM revisions').fetchone()[0] == 1
        assert db.execute('SELECT COUNT(*) FROM rows').fetchone()[0] == len(body['tracks'])


@pytest.fixture
def endpoint(monkeypatch):
    from shared.api.routes import library
    from shared.api.library_revision import validators
    validators.clear()
    lib = SimpleNamespace(metadata=snapshot(), refresh_if_stale=lambda: None)
    monkeypatch.setattr(library, '_get_api', lambda: {'get_core': lambda: (lib, None, None)})
    app = Flask(__name__)
    app.register_blueprint(library.library_bp)
    return app.test_client(), lib


def test_http_opt_in_delta_full_fallback_and_unchanged(endpoint):
    client, lib = endpoint
    first = client.get('/api/library?delta=1')
    etag = first.headers['ETag']
    base = etag[3:-1]
    lib.metadata.tracks[0].title = 'Edited'
    response = client.get('/api/library', query_string={'delta': '1', 'since': base}, headers={'If-None-Match': etag})
    delta = response.get_json()
    assert delta['kind'] == 'delta'
    assert len(delta['upserts']) == 1
    assert 'ETag' not in response.headers
    assert response.headers['Cache-Control'] == 'private, no-store'
    full = client.get('/api/library')
    assert apply(first.get_json(), delta) == full.get_json()
    assert delta['revision'] == full.headers['ETag'][3:-1]
    assert client.get('/api/library?delta=1', headers={'If-None-Match': full.headers['ETag']}).status_code == 304
    assert 'tracks' in client.get('/api/library?delta=1&since=missing').get_json()
    # Clients that don't opt in always get the original full JSON contract.
    assert 'tracks' in client.get('/api/library', query_string={'since': base}).get_json()


def test_large_delta_and_unavailable_history_fall_back(endpoint, monkeypatch):
    client, lib = endpoint
    first = client.get('/api/library?delta=1')
    base = first.headers['ETag'][3:-1]
    for track in lib.metadata.tracks:
        track.title = 'Every track changed'
    full = client.get('/api/library?delta=1&since=' + base)
    assert 'tracks' in full.get_json()
    monkeypatch.setattr(history, 'exchange', lambda *args: (_ for _ in ()).throw(sqlite3.OperationalError('locked')))
    lib.metadata.tracks[0].title = 'Again'
    assert client.get('/api/library?delta=1&since=' + base).status_code == 200


def test_deleted_history_recovers_after_restart(endpoint):
    client, lib = endpoint
    first = client.get('/api/library?delta=1')
    base = first.headers['ETag'][3:-1]
    (get_cache_dir() / 'library-deltas.sqlite3').unlink()
    lib.metadata.tracks[0].title = 'New'
    assert 'tracks' in client.get('/api/library?delta=1&since=' + base).get_json()


def test_real_disk_lock_and_corruption_preserve_full_http_response(endpoint):
    client, lib = endpoint
    first = client.get('/api/library?delta=1')
    base = first.headers['ETag'][3:-1]
    path = get_cache_dir() / 'library-deltas.sqlite3'
    with sqlite3.connect(path) as blocker:
        blocker.execute('BEGIN IMMEDIATE')
        lib.metadata.tracks[0].title = 'While locked'
        response = client.get('/api/library?delta=1&since=' + base)
        assert response.status_code == 200 and 'tracks' in response.get_json()
    path.write_bytes(b'not a SQLite database')
    lib.metadata.tracks[0].title = 'While corrupt'
    response = client.get('/api/library?delta=1&since=' + base)
    assert response.status_code == 200 and 'tracks' in response.get_json()


def test_history_is_available_in_a_fresh_process():
    import subprocess
    import sys
    from pathlib import Path

    body = snapshot().to_public_dict()
    history.exchange('a', 'base', body)
    code = '''
import json, sys
from pathlib import Path
from shared.api import library_deltas as history
history.get_cache_dir = lambda: Path(sys.argv[1])
payload = json.loads(sys.stdin.read())
payload['tracks'][0]['title'] = 'New process'
print(json.dumps(history.exchange('a', 'next', payload, 'base')))
'''
    process = subprocess.run([sys.executable, '-c', code, str(get_cache_dir())],
                             cwd=Path(__file__).resolve().parents[1], input=history.encoded(body).decode(),
                             text=True, capture_output=True, check=True)
    import json
    delta = json.loads(process.stdout)
    assert delta['base_revision'] == 'base'
    assert len(delta['upserts']) == 1
    assert delta['upserts'][0]['title'] == 'New process'


def test_history_connections_close_and_physical_file_is_capped(monkeypatch):
    real_connect = sqlite3.connect
    connections = []

    class Connection(sqlite3.Connection):
        closed = False

        def close(self):
            self.closed = True
            super().close()

    def connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs, factory=Connection)
        connections.append(conn)
        return conn

    monkeypatch.setattr(history.sqlite3, 'connect', connect)
    body = snapshot().to_public_dict()
    for i in range(8):
        history.exchange('a', str(i), body, str(i - 1))
    assert all(conn.closed for conn in connections)
    with history.connection() as db:
        page_size = db.execute('PRAGMA page_size').fetchone()[0]
        assert db.execute('PRAGMA max_page_count').fetchone()[0] * page_size <= history.MAX_BYTES
    path = get_cache_dir() / 'library-deltas.sqlite3'
    assert path.stat().st_size <= history.MAX_BYTES
    assert path.stat().st_mode & 0o777 == 0o600


def test_small_delta_never_materializes_full_json(endpoint, monkeypatch):
    from shared.api.routes import library as route

    client, lib = endpoint
    lib.metadata = snapshot(1001)
    first = client.get('/api/library?delta=1')
    base = first.headers['ETag'][3:-1]
    lib.metadata.tracks[500].title = 'Changed at batch boundary 🎵'
    expected = client.get('/api/library')
    original = route.jsonify
    bodies = []

    def jsonify_delta_only(body):
        assert 'tracks' not in body, 'full JSON must not be built for a small delta'
        bodies.append(body)
        return original(body)

    monkeypatch.setattr(route, 'jsonify', jsonify_delta_only)
    response = client.get('/api/library?delta=1&since=' + base)
    assert response.status_code == 200
    assert len(bodies) == 1
    delta = response.get_json()
    assert len(delta['upserts']) == 1
    assert apply(first.get_json(), delta) == expected.get_json()
    assert delta['revision'] == expected.headers['ETag'][3:-1]


@pytest.mark.parametrize('mode', ['pretty', 'custom', 'unicode', 'unsorted'])
def test_provider_options_preserve_delta_full_equivalence(endpoint, mode):
    from flask.json.provider import DefaultJSONProvider

    client, lib = endpoint
    app = client.application
    if mode == 'pretty': app.json.compact = False
    elif mode == 'custom':
        class Custom(DefaultJSONProvider):
            def dumps(self, obj, **kwargs):
                return super().dumps(obj, **kwargs) + ' '
        app.json = Custom(app)
    elif mode == 'unicode': app.json.ensure_ascii = False
    elif mode == 'unsorted': app.json.sort_keys = False
    first = client.get('/api/library?delta=1')
    base = first.headers['ETag'][3:-1]
    lib.metadata.tracks[0].title = 'Más música 🎵'
    response = client.get('/api/library?delta=1&since=' + base)
    full = client.get('/api/library')
    delta = response.get_json()
    assert delta['kind'] == 'delta'
    assert apply(first.get_json(), delta) == full.get_json()
    assert delta['revision'] == full.headers['ETag'][3:-1]
