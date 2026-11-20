"""Journal deltas equal full responses without materializing untouched tracks."""
from copy import deepcopy
from types import SimpleNamespace

from flask import Flask
import pytest

from shared.api import library_incremental as incremental
from shared.api import library_revision as revisions
from shared.api.library_revision import validators
from shared.artwork import artwork_store
from shared.database import DatabaseManager
from shared.db import library as library_store
from shared.library_fingerprint import fingerprint
from shared.loudness import LoudnessStore, LoudnessMeasurement
from shared.loudness.store import reset_connections, _connect
from shared.models import LibraryMetadata, Track
from shared.sqlite_changes import cursor, install_changes, changes_since
from shared.user_context import user_context


def model(count=40):
    return LibraryMetadata(1, [Track(
        id=str(i), title=f'Title {i}', artist='Artist', artists=['Artist'], album='Album',
        duration=180, file_hash=str(i), original_filename=f'{i}.mp3',
        file_size=1000, bitrate=320, format='mp3',
    ) for i in range(count)], {'List': ['0', 'external', '0']}, {'nested': [True]},
        last_updated='2026-01-01T00:00:00')


def apply(body, delta):
    body = deepcopy(body)
    rows = {row['id']: row for row in body['tracks']}
    for key in delta['removed']:
        assert key in rows
        del rows[key]
    rows.update((row['id'], row) for row in delta['upserts'])
    body['tracks'] = [rows[key] for key in delta.get('order', rows)]
    body.update(delta['fields'])
    return body


@pytest.fixture
def endpoint(tmp_path, monkeypatch):
    from shared.api.routes import library
    validators.clear()
    reset_connections()
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = model()
    db.replace_library(metadata)
    assert db.public_source()['fingerprint'] == fingerprint(metadata)
    lib = SimpleNamespace(db=db, metadata=metadata, refresh_if_stale=lambda: None)
    monkeypatch.setattr(library, '_get_api', lambda: {'get_library': lambda: lib})
    app = Flask(__name__)
    app.register_blueprint(library.library_bp)
    yield app.test_client(), lib, library
    validators.clear()
    reset_connections()


def get_delta(client, base):
    return client.get('/api/library', query_string={'delta': '1', 'since': base.headers['ETag'][3:-1]},
                      headers={'If-None-Match': base.headers['ETag']})


def test_unchanged_saves_keep_the_validator_and_delta_bases(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Saved'
    lib.db.replace_library(lib.metadata)
    fast_client = client.get('/api/library?delta=1')
    with monkeypatch.context() as patch:
        patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('unchanged save caused a full GET'))
        for _ in range(5):
            lib.db.replace_library(lib.metadata)
            assert get_delta(client, fast_client).status_code == 304
        delta = get_delta(client, first).get_json()
    assert apply(first.get_json(), delta) == fast_client.get_json()


@pytest.mark.parametrize('external', [False, True])
def test_unverified_warm_validator_observes_sqlite_writes(endpoint, monkeypatch, external):
    from contextlib import closing
    import sqlite3

    client, lib, _ = endpoint

    def edit(title):
        connection = closing(sqlite3.connect(lib.db.db_path)) if external else lib.db._get_connection()
        with connection as conn:
            conn.execute("UPDATE tracks SET title=? WHERE id='0'", (title,))
            conn.commit()

    edit('Unverified title')
    first = client.get('/api/library')
    assert first.get_json()['tracks'][0]['title'] == 'Unverified title'
    headers = {'If-None-Match': first.headers['ETag']}
    with monkeypatch.context() as patch:
        patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('warm fallback read a full snapshot'))
        assert client.get('/api/library', headers=headers).status_code == 304
    edit('New unverified title')
    second = client.get('/api/library', headers=headers)
    assert second.status_code == 200 and second.get_json()['tracks'][0]['title'] == 'New unverified title'


def test_projected_artist_changes_reach_other_tracks_in_the_delta(endpoint):
    client, lib, _ = endpoint
    lib.metadata.tracks[0].artists = ['Alpha', 'alpha', ' Guest ', 42]
    lib.metadata.tracks[1].artists = ['alpha']
    lib.db.replace_library(lib.metadata)
    first = client.get('/api/library?delta=1')
    assert first.get_json()['tracks'][0]['artists'] == ['Alpha', 'Guest', '42']
    assert first.get_json()['tracks'][1]['artists'] == ['Alpha']

    lib.metadata.tracks[0].artists = ['Other']
    lib.db.replace_library(lib.metadata)
    delta = get_delta(client, first).get_json()
    assert [track['artists'] for track in delta['upserts']] == [['Other'], ['alpha']]
    assert apply(first.get_json(), delta) == client.get('/api/library').get_json()


def test_unverified_library_read_resolves_stale_aliases(endpoint):
    client, lib, _ = endpoint
    with lib.db._get_connection() as db:
        db.execute("INSERT INTO track_id_aliases VALUES ('0','Resolved')")
    first = client.get('/api/library').get_json()
    assert (first['tracks'][0]['id'], first['tracks'][0]['file_hash']) == ('Resolved', 'Resolved')
    assert first == lib.db.load_library_metadata().to_public_dict()


@pytest.mark.parametrize('change', ['settings', 'order', 'rows'])
def test_delta_after_a_restored_database_diverges_from_its_backup(endpoint, tmp_path, change):
    from contextlib import closing
    import sqlite3

    client, lib, _ = endpoint
    target = tmp_path / 'restored.db'
    with lib.db._get_connection() as original, closing(sqlite3.connect(target)) as copied:
        original.backup(copied)
    restored_db = DatabaseManager(str(target))
    restored = restored_db.load_library_metadata()
    if change == 'settings':
        lib.metadata.settings['crossfade'] = 1
        restored.settings['crossfade'] = 2
    elif change == 'order':
        lib.metadata.tracks.reverse()
        restored.tracks[:] = restored.tracks[1:] + restored.tracks[:1]
    else:
        lib.metadata.tracks[0].title = 'Edited on first branch'
        restored.tracks[1].title = 'Edited on second branch'

    lib.db.replace_library(lib.metadata)
    old = client.get('/api/library?delta=1')
    restored_db.replace_library(restored)
    assert restored_db.get_library_revision() == lib.db.get_library_revision()
    lib.db = restored_db
    if change == 'rows':
        # The restored branch can even advance beyond the served cursor.
        restored.tracks[2].title = 'Second change on restored branch'
        restored_db.replace_library(restored)
    response = get_delta(client, old)
    full = client.get('/api/library')
    assert response.status_code == 200
    body = response.get_json()
    if change == 'rows':
        assert body == full.get_json()
    else:
        assert body['kind'] == 'delta'
        assert apply(old.get_json(), body) == full.get_json()
        assert body['revision'] == full.get_etag()[0]


def test_debug_json_can_revalidate_without_reading_the_library(endpoint, monkeypatch):
    client, lib, _ = endpoint
    client.application.debug = True
    first = client.get('/api/library')
    monkeypatch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('debug 304 read the full library'))
    assert client.get('/api/library', headers={'If-None-Match': first.headers['ETag']}).status_code == 304


@pytest.mark.parametrize('change', ['title', 'add', 'remove', 'order', 'headers', 'artwork', 'dimensions',
                                   'override_dimensions', 'artwork_delete', 'loudness', 'loudness_delete', 'shared_hash'])
def test_partial_delta_equals_full_and_only_copies_changed_rows(endpoint, monkeypatch, change):
    client, lib, route = endpoint
    art = artwork_store()
    if change in {'artwork_delete', 'dimensions'}:
        art.bind('0', 'cover', 'manual')
    if change == 'override_dimensions':
        art.bind_override('0', 'cover', 'manual')
    if change == 'loudness_delete':
        LoudnessStore().put('0', 'stamp', LoudnessMeasurement(-12, -1, 4))
    if change == 'shared_hash':
        lib.metadata.tracks[1].file_hash = '0'
        lib.db.replace_library(lib.metadata)
    first = client.get('/api/library?delta=1')
    if change == 'title': lib.metadata.tracks[0].title = 'Changed 🎵'
    elif change == 'add':
        added = deepcopy(lib.metadata.tracks[0])
        added.id = 'new'
        lib.metadata.tracks.append(added)
    elif change == 'remove': lib.metadata.tracks.pop(0)
    elif change == 'order': lib.metadata.tracks.reverse()
    elif change == 'headers':
        lib.metadata.playlists = {'New': ['3', '2']}
        lib.metadata.settings = {}
        lib.metadata.podcast_episode_cache = {'feed': {'episodes': []}}
    elif change == 'artwork': art.bind('0', 'cover', 'manual')
    elif change in {'dimensions', 'override_dimensions'}:
        with art.connect() as db:
            db.execute("INSERT INTO objects VALUES ('cover',800,600,'jpeg',1)")
    elif change == 'artwork_delete':
        with art.connect() as db: db.execute("DELETE FROM refs WHERE track_id='0'")
    elif change in {'loudness', 'shared_hash'}:
        LoudnessStore().put('0', 'stamp', LoudnessMeasurement(-12, -1, 4))
    elif change == 'loudness_delete': LoudnessStore().forget('0')
    if change in {'title', 'add', 'remove', 'order', 'headers'}:
        lib.db.replace_library(lib.metadata)
    original = library_store._public_track
    copied = []

    def copy(row):
        track = original(row)
        copied.append(track['id'])
        return track

    with monkeypatch.context() as patch:
        patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('full snapshot'))
        if change != 'headers':
            patch.setattr(lib.db, '_public_headers', lambda *_: pytest.fail('unchanged headers read'))
        patch.setattr(library_store, '_public_track', copy)
        patch.setattr(route, 'compact_signature', lambda *_: pytest.fail('full hashing'), raising=False)
        patch.setattr(LoudnessStore, 'measured', lambda _: pytest.fail('full loudness scan'))
        patch.setattr(revisions, 'fingerprint', lambda _: pytest.fail('full model fingerprint'))
        response = get_delta(client, first)
    assert response.status_code == 200
    delta = response.get_json()
    assert delta['kind'] == 'delta'
    expected_count = 0 if change in {'headers', 'order', 'remove'} else 2 if change == 'shared_hash' else 1
    assert len(copied) == expected_count
    full = client.get('/api/library')
    assert apply(first.get_json(), delta) == full.get_json()
    assert delta['revision'] == full.headers['ETag'][3:-1]
    with monkeypatch.context() as patch:
        patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('warm 304 copied library'))
        patch.setattr(revisions, 'fingerprint', lambda _: pytest.fail('warm 304 hashed the library'))
        assert client.get('/api/library', headers={'If-None-Match': full.headers['ETag']}).status_code == 304


def test_add_delete_between_polls_does_not_remove_an_unknown_id(endpoint):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    added = deepcopy(lib.metadata.tracks[0])
    added.id = 'temporary'
    lib.metadata.tracks.append(added)
    lib.db.replace_library(lib.metadata)
    lib.metadata.tracks.pop()
    lib.metadata.tracks[0].title = 'Keep a visible edit'
    lib.db.replace_library(lib.metadata)
    delta = get_delta(client, first).get_json()
    assert delta['kind'] == 'delta'
    assert delta['removed'] == []
    assert apply(first.get_json(), delta) == client.get('/api/library').get_json()


@pytest.mark.parametrize('change', ['raw_sql', 'missing_history', 'expired', 'gap', 'bulk', 'empty'])
def test_unprovable_or_large_changes_fall_back(endpoint, change):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    if change == 'raw_sql':
        with lib.db._get_connection() as db:
            db.execute("UPDATE tracks SET title='Outside writer' WHERE id='0'")
            db.commit()
    elif change in {'missing_history', 'expired'}:
        with incremental.history.connection() as db:
            if change == 'missing_history': db.execute('DELETE FROM incremental_bases')
            else: db.execute('UPDATE incremental_bases SET created=0')
        lib.metadata.tracks[0].title = 'Changed'
        lib.db.replace_library(lib.metadata)
    elif change == 'gap':
        lib.metadata.tracks[0].title = 'Changed'
        lib.db.replace_library(lib.metadata)
        with lib.db._get_connection() as db:
            db.execute('UPDATE public_changes_state SET floor=seq')
            db.commit()
    elif change == 'bulk':
        for track in lib.metadata.tracks: track.title = 'All changed'
        lib.db.replace_library(lib.metadata)
    elif change == 'empty':
        lib.metadata.tracks.clear()
        lib.db.replace_library(lib.metadata)
    response = get_delta(client, first)
    assert 'tracks' in response.get_json()
    assert response.get_json() == client.get('/api/library').get_json()


def test_fresh_and_conditional_reads_share_the_committed_library(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Unsaved'
    with monkeypatch.context() as patch:
        # Nothing was committed: the client is current, without a pass over
        # the live model.
        patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('full snapshot'))
        assert get_delta(client, first).status_code == 304
    fresh = client.get('/api/library')
    assert fresh.get_json() == first.get_json()
    assert fresh.headers['ETag'] == first.headers['ETag']
    saved = deepcopy(lib.metadata)
    saved.tracks[0].title = first.get_json()['tracks'][0]['title']
    saved.tracks[1].title = 'Saved'
    lib.db.replace_library(saved)
    delta = get_delta(client, first).get_json()
    assert delta['kind'] == 'delta'
    assert [track['title'] for track in delta['upserts']] == ['Saved']
    assert apply(first.get_json(), delta) == client.get('/api/library').get_json()


def test_full_response_ignores_unsaved_headers_after_an_expired_base(endpoint):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    saved = deepcopy(lib.metadata)
    saved.tracks[1].title = 'Saved'
    lib.db.replace_library(saved)
    lib.metadata.playlists['List'].append('unsaved')
    with incremental.history.connection() as db:
        db.execute('DELETE FROM incremental_bases')
    response = get_delta(client, first)
    assert response.get_json() == saved.to_public_dict()


def test_reloaded_model_and_disk_base_work_without_validator_memory(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Persisted'
    lib.db.replace_library(lib.metadata)
    lib.metadata = lib.db.load_library_metadata()
    validators.clear()
    with monkeypatch.context() as patch:
        patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('full copy after reload'))
        response = get_delta(client, first)
    assert response.get_json()['kind'] == 'delta'
    assert apply(first.get_json(), response.get_json()) == client.get('/api/library').get_json()


def test_account_bases_cannot_cross_users(endpoint):
    client, lib, _ = endpoint
    with user_context('alice'):
        first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Changed'
    lib.db.replace_library(lib.metadata)
    with user_context('bob'):
        response = get_delta(client, first)
        assert 'tracks' in response.get_json()
        assert response.headers['ETag'] != first.headers['ETag']


def test_journal_transaction_rollback_and_key_renames(tmp_path):
    import sqlite3
    with sqlite3.connect(tmp_path / 'journal') as db:
        db.execute('CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT)')
        install_changes(db, (('items', 'item', 'id'),))
        db.execute("INSERT INTO items VALUES ('old','value')")
        db.commit()
        before = cursor(db)
        db.execute("UPDATE items SET id='new' WHERE id='old'")
        assert changes_since(db, before, cursor(db)) == [('item', 'new', 'INSERT'), ('item', 'old', 'DELETE')]
        db.rollback()
        assert cursor(db) == before
        assert changes_since(db, before, cursor(db)) == []


def test_failure_or_commit_during_annotation_cannot_send_partial_proof(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Changed'
    lib.db.replace_library(lib.metadata)
    original = incremental.annotate_tracks

    def racing(tracks, **kwargs):
        result = original(tracks, **kwargs)
        artwork_store().bind('1', 'new', 'manual')
        return result

    monkeypatch.setattr(incremental, 'annotate_tracks', racing)
    response = get_delta(client, first)
    assert 'tracks' in response.get_json()
    assert response.get_json() == client.get('/api/library').get_json()


def test_commit_during_sqlite_delta_read_falls_back_to_latest_snapshot(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Saved'
    lib.db.replace_library(lib.metadata)
    original = library_store._public_track
    writer = DatabaseManager(str(lib.db.db_path))
    latest = deepcopy(lib.metadata)
    latest.tracks[0].title = 'Newer commit'
    committed = False

    def decode(row):
        nonlocal committed
        if not committed:
            committed = True
            writer.replace_library(latest)
        return original(row)

    monkeypatch.setattr(library_store, '_public_track', decode)
    response = get_delta(client, first)
    assert 'tracks' in response.get_json()
    assert response.get_json()['tracks'][0]['title'] == 'Newer commit'


def test_fingerprint_ignores_string_and_collection_sharing():
    value = model(1)
    shared = ['artist']
    value.settings = {'a': shared, 'b': shared}
    before = fingerprint(value)
    value.settings['b'] = ['artist']
    value.tracks[0].artists = [''.join(['Art', 'ist'])]
    assert fingerprint(value) == before


def test_journal_is_bounded_and_rejects_pruned_or_recreated_bases(tmp_path):
    import sqlite3
    from shared.sqlite_changes import MAX_EVENTS
    with sqlite3.connect(tmp_path / 'bounded') as db:
        db.execute('CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT)')
        install_changes(db, (('items', 'item', 'id'),))
        start = cursor(db)
        db.executemany('INSERT INTO items VALUES (?,?)', ((str(i), 'v') for i in range(MAX_EVENTS + 700)))
        current = cursor(db)
        assert db.execute('SELECT COUNT(*) FROM public_changes').fetchone()[0] <= MAX_EVENTS + 255
        assert db.execute('SELECT COUNT(*) FROM public_changes_anchors').fetchone() == db.execute(
            'SELECT COUNT(*) FROM public_changes').fetchone()
        assert changes_since(db, start, current) is None
        db.execute('UPDATE public_changes_state SET epoch=lower(hex(randomblob(16)))')
        assert changes_since(db, current, cursor(db)) is None
        before = cursor(db)
        db.execute('INSERT INTO items VALUES (?,?)', ('x' * 513, 'v'))
        assert changes_since(db, before, cursor(db)) is None
        assert db.execute('SELECT MAX(length(CAST(key AS BLOB))) FROM public_changes').fetchone()[0] <= 512


def test_lightweight_bases_have_count_ttl_and_payload_bounds(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    from shared.user_context import current_user_id
    account = current_user_id() or ''
    proof = incremental.load_base(account, first.headers['ETag'][3:-1])
    assert proof and 'tracks' not in proof and 'Title 0' not in str(proof)
    digests = incremental.header_digests(lib.metadata.public_headers())
    for i in range(8): incremental.remember(account, str(i), proof, digests)
    with incremental.history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM incremental_bases WHERE account=?', (account,)).fetchone()[0] == 4
        assert db.execute('SELECT MAX(length(proof)) FROM incremental_bases').fetchone()[0] < 8192
    monkeypatch.setattr(incremental, 'MAX_BASES', 5)
    for i in range(8): incremental.remember(f'account-{i}', 'base', proof, digests)
    with incremental.history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM incremental_bases').fetchone()[0] == 5
        db.execute('UPDATE incremental_bases SET created=0')
    assert incremental.load_base('account-7', 'base') is None
    incremental.remember('new', 'new', proof, digests)
    with incremental.history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM incremental_bases').fetchone()[0] == 1


def test_loading_a_saved_delta_base_does_not_take_the_write_lock(endpoint):
    from shared.user_context import current_user_id

    client, _, _ = endpoint
    first = client.get('/api/library?delta=1')
    with incremental.history.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        assert incremental.load_base(current_user_id() or '', first.get_etag()[0]) is not None


def test_partial_delta_survives_a_fresh_process(endpoint):
    import json
    import subprocess
    import sys
    from shared.user_context import current_user_id
    from shared.loudness.store import loudness_db_path

    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Written before restart'
    lib.db.replace_library(lib.metadata)
    art = artwork_store()
    with lib.db._get_connection() as db:
        db_path = db.execute('PRAGMA database_list').fetchone()[2]
    code = '''
import json,sys
from pathlib import Path
from types import SimpleNamespace
from flask import Flask
from shared.database import DatabaseManager
from shared.models import LibraryMetadata
from shared.api.routes import library
from shared.api import library_deltas
from shared.artwork import ArtworkStore
import shared.artwork as artwork
import shared.loudness.store as loudness
from shared.user_context import user_context
library_deltas.get_cache_dir=lambda:Path(sys.argv[1])
artwork.artwork_store=lambda:ArtworkStore(Path(sys.argv[2]),Path(sys.argv[3]))
loudness.loudness_db_path=lambda:Path(sys.argv[4])
db=DatabaseManager(sys.argv[5])
lib=SimpleNamespace(db=db,metadata=db.load_library_metadata(),refresh_if_stale=lambda:None)
library._get_api=lambda:{'get_library':lambda:lib}
db.public_snapshot=lambda:(_ for _ in ()).throw(RuntimeError('full snapshot after restart'))
app=Flask(__name__)
app.register_blueprint(library.library_bp)
with user_context(sys.argv[6]):
 response=app.test_client().get('/api/library',query_string={'delta':'1','since':sys.argv[7]})
 assert response.status_code==200,response.data
 print(json.dumps(response.get_json()))
'''
    result = subprocess.run([sys.executable, '-c', code, str(incremental.history.get_cache_dir()),
                             str(art.root), str(art.cache), str(loudness_db_path()), db_path,
                             current_user_id() or '', first.headers['ETag'][3:-1]],
                            check=True, text=True, capture_output=True)
    delta = json.loads(result.stdout)
    assert delta['kind'] == 'delta'
    assert apply(first.get_json(), delta) == client.get('/api/library').get_json()


def test_external_reorder_followed_by_save_cannot_skip_order(endpoint):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    with lib.db._get_connection() as db:
        db.execute('UPDATE library_tracks SET position=100-position')
        db.commit()
    lib.metadata = lib.db.load_library_metadata()
    lib.db.replace_library(lib.metadata)
    delta = get_delta(client, first).get_json()
    assert delta['kind'] == 'delta'
    assert delta['order'] == [t.id for t in lib.metadata.tracks]
    assert apply(first.get_json(), delta) == client.get('/api/library').get_json()


def test_write_failure_rolls_back_journal_and_source(endpoint, monkeypatch):
    import shared.library_changes as changes
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    before = lib.db.public_source()
    original = changes.sync_source

    def fail_after_journal(*args):
        original(*args)
        raise RuntimeError('failed after journal')

    lib.metadata.tracks[0].title = 'Must roll back'
    with monkeypatch.context() as patch:
        patch.setattr(changes, 'sync_source', fail_after_journal)
        with pytest.raises(RuntimeError): lib.db.replace_library(lib.metadata)
    assert lib.db.public_source() == before
    lib.metadata = lib.db.load_library_metadata()
    assert get_delta(client, first).status_code == 304


def test_commit_during_partial_annotation_forces_full_fallback(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'First change'
    lib.db.replace_library(lib.metadata)
    original = incremental.annotate_tracks

    def commit(tracks, **kwargs):
        result = original(tracks, **kwargs)
        lib.metadata.tracks[1].title = 'Concurrent commit'
        lib.db.replace_library(lib.metadata)
        return result

    monkeypatch.setattr(incremental, 'annotate_tracks', commit)
    response = get_delta(client, first)
    assert 'tracks' in response.get_json()
    assert response.get_json() == client.get('/api/library').get_json()


def test_legacy_database_migrates_without_claiming_unverified_source(tmp_path):
    path = str(tmp_path / 'legacy.db')
    old = DatabaseManager(path)
    value = model()
    old.replace_library(value)
    # Recreate the pre-journal layout, then let normal schema initialization
    # install the new tables without marking old data as verified.
    with old._get_connection() as db:
        triggers = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'")]
        for name in triggers:
            if name.startswith(('changes_', 'invalidate_public_')):
                db.execute(f'DROP TRIGGER {name}')
        for table in ('public_changes', 'public_changes_state', 'library_public_rows', 'library_public_source'):
            db.execute(f'DROP TABLE {table}')
        db.commit()
    new = DatabaseManager(path)
    assert new.public_source() is None
    loaded = new.load_library_metadata()
    new.replace_library(loaded)
    assert new.public_source()['fingerprint'] == fingerprint(loaded)


def test_previous_engine_can_open_and_save_an_upgraded_database(tmp_path):
    path = str(tmp_path / 'upgraded.db')
    db = DatabaseManager(path)
    value = model()
    db.replace_library(value)
    with db._get_connection() as conn:
        # The previous engine's schema statement, verbatim.
        conn.execute("INSERT OR IGNORE INTO library_public_source VALUES (1,0,'',0,1)")
        # Its save proves a new source without knowing header hashes.
        conn.execute("UPDATE library_public_source SET fingerprint='written-by-previous-engine'")
        conn.commit()
    # The new engine accepts a same-source base or proves the headers on save.
    assert db.public_source()['headers'] is None
    db.replace_library(value)
    assert db.public_source()['headers'] is not None


def test_older_library_can_send_annotation_deltas_before_its_first_save(endpoint, monkeypatch):
    client, lib, _ = endpoint
    with lib.db._get_connection() as conn:
        conn.execute('DELETE FROM library_public_headers')
        conn.commit()
    lib.metadata = lib.db.load_library_metadata()
    first = client.get('/api/library?delta=1')
    art = artwork_store()
    for track_id in ('0', '1'):
        art.bind(track_id, f'cover-{track_id}', 'manual')
        with monkeypatch.context() as patch:
            patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('full copy on upgrade'))
            delta = get_delta(client, first).get_json()
        assert delta['kind'] == 'delta' and delta['fields'] == {}
        assert apply(first.get_json(), delta) == client.get('/api/library').get_json()
    assert lib.db.public_source()['headers'] is None


def test_older_writer_can_change_headers_without_a_header_hash(endpoint):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.settings['crossfade'] = 2
    lib.db.replace_library(lib.metadata)
    with lib.db._get_connection() as db:
        db.execute('DELETE FROM library_public_headers')
    delta = get_delta(client, first).get_json()
    assert delta['kind'] == 'delta'
    assert delta['fields'] == {'settings': lib.metadata.settings}
    assert apply(first.get_json(), delta) == client.get('/api/library').get_json()



def test_a_previous_response_projection_bootstraps_once(endpoint):
    client, lib, _ = endpoint
    old = client.get('/api/library?delta=1')
    with incremental.history.connection() as db:
        db.execute("UPDATE incremental_bases SET proof=json_remove(proof,'$.projection')")
    lib.metadata.tracks[0].title = 'First edit'
    lib.db.replace_library(lib.metadata)
    fresh = get_delta(client, old)
    assert fresh.get_json() == client.get('/api/library').get_json()

    lib.metadata.tracks[0].title = 'Second edit'
    lib.db.replace_library(lib.metadata)
    delta = get_delta(client, fresh).get_json()
    assert delta['kind'] == 'delta'
    assert apply(fresh.get_json(), delta) == client.get('/api/library').get_json()


def test_live_header_edit_during_a_save_is_neither_stored_nor_certified(endpoint, monkeypatch):
    import shared.collection as collection
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Saved'
    original = collection.project_user_state

    def racing(conn):
        # The live model changes after the save took its header snapshot.
        lib.metadata.settings['late'] = True
        return original(conn)

    monkeypatch.setattr(collection, 'project_user_state', racing)
    lib.db.replace_library(lib.metadata)
    monkeypatch.setattr(collection, 'project_user_state', original)
    stored = lib.db.load_library_metadata()
    assert 'late' not in stored.settings
    assert lib.db.public_source()['fingerprint'] == fingerprint(stored)
    delta = get_delta(client, first).get_json()
    assert delta['kind'] == 'delta' and 'late' not in delta['fields'].get('settings', {})
    assert apply(first.get_json(), delta) == client.get('/api/library').get_json()


def test_live_header_edit_during_a_track_patch_cannot_enter_the_delta(endpoint, monkeypatch):
    from contextlib import contextmanager
    from dataclasses import replace
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    metadata = lib.metadata
    source = lib.db.public_source()['fingerprint']
    updated = replace(metadata.tracks[0], title='Saved')
    candidate = replace(metadata, tracks=[updated, *metadata.tracks[1:]])
    original = lib.db._get_connection

    def edit_header(sql):
        if sql.startswith('UPDATE library_public_source SET valid=1,fingerprint='):
            metadata.settings['late'] = True

    @contextmanager
    def traced():
        with original() as conn:
            conn.set_trace_callback(edit_header)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)

    with monkeypatch.context() as patch:
        patch.setattr(lib.db, '_get_connection', traced)
        lib.db.patch_track_metadata(updated.id, {'title': 'Saved'},
                                    expected_revision=lib.db.get_library_revision(),
                                    previous_fingerprint=source, metadata=candidate)
    lib.metadata = candidate
    stored = lib.db.load_library_metadata()
    assert 'late' not in stored.settings and candidate.settings['late'] is True
    assert lib.db.public_source()['fingerprint'] == fingerprint(stored)
    delta = get_delta(client, first).get_json()
    assert delta['kind'] == 'delta'
    assert apply(first.get_json(), delta) == stored.to_public_dict()


def test_track_mutation_after_sql_write_cannot_reuse_the_old_validator(endpoint, monkeypatch):
    from shared import library_changes
    client, lib, _ = endpoint
    first = client.get('/api/library')
    track = lib.metadata.tracks[0]
    previous = track.title
    track.title = 'Saved title'
    original = library_changes.sync_source

    def changed_after_write(*args):
        track.title = previous
        try:
            return original(*args)
        finally:
            track.title = 'Saved title'

    monkeypatch.setattr(library_changes, 'sync_source', changed_after_write)
    lib.db.replace_library(lib.metadata)
    stored = lib.db.load_library_metadata()
    assert stored.tracks[0].title == 'Saved title'
    response = client.get('/api/library', headers={'If-None-Match': first.headers['ETag']})
    assert response.status_code == 200
    assert response.get_json()['tracks'][0]['title'] == 'Saved title'
    assert lib.db.public_source()['fingerprint'] == fingerprint(stored)


@pytest.mark.parametrize(('field', 'portable', 'stored'), [('artists', None, ['Artist']), ('duration', 180.0, 180)])
def test_sqlite_projection_stays_the_same_after_a_reload(endpoint, monkeypatch, field, portable, stored):
    client, lib, _ = endpoint
    setattr(lib.metadata.tracks[0], field, portable)
    lib.db.replace_library(lib.metadata)
    first = client.get('/api/library?delta=1')
    lib.metadata = lib.db.load_library_metadata()
    value = first.get_json()['tracks'][0][field]
    assert value == stored and type(value) is type(stored)
    assert client.get('/api/library').get_json() == first.get_json()
    monkeypatch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('warm 304 read a snapshot'))
    for _ in range(3):
        assert get_delta(client, first).status_code == 304


@pytest.mark.parametrize('pending', ['cleared', 'first_track'])
def test_committed_revalidation_ignores_whether_the_live_model_is_empty(endpoint, pending):
    client, lib, _ = endpoint
    if pending == 'first_track':
        lib.metadata.tracks.clear()
        lib.db.replace_library(lib.metadata)
    first = client.get('/api/library')
    if pending == 'cleared':
        lib.metadata.tracks.clear()
    else:
        lib.metadata.tracks.append(model(1).tracks[0])
    # Nothing was committed: the committed holder stays current.
    assert client.get('/api/library', headers={'If-None-Match': first.headers['ETag']}).status_code == 304


def test_saved_model_carries_the_date_sqlite_keeps(endpoint):
    client, lib, _ = endpoint
    lib.metadata.tracks[0].added_at = '2020-01-01T00:00:00'
    lib.db.replace_library(lib.metadata)
    legacy = deepcopy(lib.metadata)
    legacy.tracks[0].added_at = None  # As a manifest from before dates.
    lib.db.replace_library(legacy)
    assert legacy.tracks[0].added_at == '2020-01-01T00:00:00'
    stored = lib.db.load_library_metadata()
    assert lib.db.public_source()['fingerprint'] == fingerprint(stored) == fingerprint(legacy)


def test_locked_history_cache_still_delivers_a_verified_delta(endpoint, monkeypatch):
    from contextlib import closing
    import sqlite3
    from shared.runtime import get_cache_dir

    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Locked cache edit'
    lib.db.replace_library(lib.metadata)
    expected = lib.db.load_library_metadata().to_public_dict()

    cache_path = get_cache_dir() / 'library-deltas.sqlite3'
    with closing(sqlite3.connect(cache_path, isolation_level=None)) as locker:
        locker.execute('BEGIN IMMEDIATE')
        try:
            with monkeypatch.context() as patch:
                patch.setattr(lib.db, 'public_snapshot', lambda: pytest.fail('locked cache caused full fallback'))
                response = get_delta(client, first)
        finally:
            locker.execute('ROLLBACK')

    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'private, no-store'
    delta = response.get_json()
    assert delta['kind'] == 'delta'
    assert apply(first.get_json(), delta) == expected


@pytest.mark.parametrize('artist_count', [1, 2])
def test_artist_fanout_caps_database_work_before_deduplicating(tmp_path, artist_count):
    from contextlib import closing
    import sqlite3
    from shared import library_changes

    db = DatabaseManager(str(tmp_path / 'library.db'))
    db.replace_library(model(1))
    with db._get_connection() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO tracks(id, title, artist, album) VALUES (?, 'T', 'Shared', 'A')",
            ((f't{i}',) for i in range(10000)),
        )
        for index in range(artist_count):
            artist_id = f'shared-{index}'
            conn.execute(
                "INSERT OR IGNORE INTO artists(id, name, name_key) VALUES (?, ?, ?)",
                (artist_id, f'Shared {index}', f'shared {index}'),
            )
            conn.executemany(
                "INSERT OR IGNORE INTO track_artists(track_id, artist_id, position) VALUES (?, ?, ?)",
                ((f't{i}', artist_id, index) for i in range(10000)),
            )
        conn.execute("UPDATE library_public_source SET valid=1 WHERE singleton=1")
        before = library_changes.source(conn)
        for index in range(artist_count):
            conn.execute("UPDATE artists SET name=? WHERE id=?", (f'Renamed {index}', f'shared-{index}'))
        conn.execute("UPDATE library_public_source SET valid=1 WHERE singleton=1")
        after = library_changes.source(conn)

    with closing(sqlite3.connect(db.db_path)) as conn:
        conn.set_progress_handler(lambda: 1, 35000)
        assert library_changes.affected(conn, before, after, (), ()) is None
