"""Journal deltas equal full responses without materializing untouched tracks."""
from copy import deepcopy
from types import SimpleNamespace

from flask import Flask
import pytest

from shared.api import library_incremental as incremental
from shared.api.library_revision import validators
from shared.artwork import artwork_store
from shared.database import DatabaseManager
from shared.library_fingerprint import fingerprint
from shared.loudness import LoudnessStore, LoudnessMeasurement
from shared.loudness.store import reset_connections, _connect
from shared.models import LibraryMetadata, Track
from shared.sqlite_changes import cursor, install_changes, changes_since
from shared.user_context import user_context


def model(count=40):
    return LibraryMetadata(1, [Track(
        id=str(i), title=f'Title {i}', artist='Artist', artists=['Artist'], album='Album',
        duration=180, file_hash=str(i), original_filename=f'{i}.mp3', compressed=False,
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
    monkeypatch.setattr(library, '_get_api', lambda: {'get_core': lambda: (lib, None, None)})
    app = Flask(__name__)
    app.register_blueprint(library.library_bp)
    yield app.test_client(), lib, library
    validators.clear()
    reset_connections()


def get_delta(client, base):
    return client.get('/api/library', query_string={'delta': '1', 'since': base.headers['ETag'][3:-1]},
                      headers={'If-None-Match': base.headers['ETag']})


@pytest.mark.parametrize('change', ['title', 'add', 'remove', 'order', 'headers', 'artwork', 'dimensions',
                                   'artwork_delete', 'loudness', 'loudness_delete', 'shared_hash'])
def test_partial_delta_equals_full_and_only_copies_changed_rows(endpoint, monkeypatch, change):
    client, lib, route = endpoint
    art = artwork_store()
    if change in {'artwork_delete', 'dimensions'}:
        art.bind('0', 'cover', 'manual')
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
    elif change == 'dimensions':
        with art.connect() as db:
            db.execute("INSERT INTO objects VALUES ('cover',800,600,'jpeg',1)")
    elif change == 'artwork_delete':
        with art.connect() as db: db.execute("DELETE FROM refs WHERE track_id='0'")
    elif change in {'loudness', 'shared_hash'}:
        LoudnessStore().put('0', 'stamp', LoudnessMeasurement(-12, -1, 4))
    elif change == 'loudness_delete': LoudnessStore().forget('0')
    if change in {'title', 'add', 'remove', 'order', 'headers'}:
        lib.db.replace_library(lib.metadata)
    original = Track.to_public_dict
    copied = []

    def copy(track):
        copied.append(track.id)
        return original(track)

    with monkeypatch.context() as patch:
        patch.setattr(LibraryMetadata, 'to_public_dict', lambda _: pytest.fail('full snapshot'))
        patch.setattr(Track, 'to_public_dict', copy)
        patch.setattr(route, 'compact_signature', lambda *_: pytest.fail('full hashing'), raising=False)
        patch.setattr(LoudnessStore, 'measured', lambda _: pytest.fail('full loudness scan'))
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
        patch.setattr(LibraryMetadata, 'to_public_dict', lambda _: pytest.fail('warm 304 copied library'))
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


@pytest.mark.parametrize('change', ['unsaved', 'raw_sql', 'missing_history', 'expired', 'gap', 'bulk', 'empty'])
def test_unprovable_or_large_changes_fall_back(endpoint, change):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    if change == 'unsaved': lib.metadata.tracks[0].title = 'Unsaved'
    elif change == 'raw_sql':
        with lib.db._get_connection() as db:
            db.execute("UPDATE tracks SET title='Outside writer' WHERE id='0'")
            db.commit()
        lib.metadata = lib.db.load_library_metadata()
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


def test_reloaded_model_and_disk_base_work_without_validator_memory(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Persisted'
    lib.db.replace_library(lib.metadata)
    lib.metadata = lib.db.load_library_metadata()
    validators.clear()
    with monkeypatch.context() as patch:
        patch.setattr(LibraryMetadata, 'to_public_dict', lambda _: pytest.fail('full copy after reload'))
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


def test_mutation_during_partial_copy_is_detected_even_if_live_model_reverts(endpoint, monkeypatch):
    client, lib, _ = endpoint
    first = client.get('/api/library?delta=1')
    lib.metadata.tracks[0].title = 'Saved'
    lib.db.replace_library(lib.metadata)
    original = Track.to_public_dict
    calls = []

    def temporary_copy(track):
        result = original(track)
        if not calls:
            result['title'] = 'Racing transient value'
        calls.append(track.id)
        return result

    monkeypatch.setattr(Track, 'to_public_dict', temporary_copy)
    response = get_delta(client, first)
    assert 'tracks' in response.get_json()
    assert response.get_json()['tracks'][0]['title'] == 'Saved'


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
    headers = {name: getattr(lib.metadata, name) for name in incremental.HEADER_FIELDS}
    for i in range(8): incremental.remember(account, str(i), proof, headers)
    with incremental.history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM incremental_bases WHERE account=?', (account,)).fetchone()[0] == 4
        assert db.execute('SELECT MAX(length(proof)) FROM incremental_bases').fetchone()[0] < 8192
    monkeypatch.setattr(incremental, 'MAX_BASES', 5)
    for i in range(8): incremental.remember(f'account-{i}', 'base', proof, headers)
    with incremental.history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM incremental_bases').fetchone()[0] == 5
        db.execute('UPDATE incremental_bases SET created=0')
    assert incremental.load_base('account-7', 'base') is None
    incremental.remember('new', 'new', proof, headers)
    with incremental.history.connection() as db:
        assert db.execute('SELECT COUNT(*) FROM incremental_bases').fetchone()[0] == 1


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
library._get_api=lambda:{'get_core':lambda:(lib,None,None)}
LibraryMetadata.to_public_dict=lambda _:(_ for _ in ()).throw(RuntimeError('full snapshot after restart'))
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

    def fail_after_journal(conn, metadata, order_changed):
        original(conn, metadata, order_changed)
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
