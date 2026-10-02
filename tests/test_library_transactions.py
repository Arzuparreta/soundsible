import inspect
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from flask import Flask

from player.library import LibraryManager
from player.library_exports import flush_exports
from shared.api.routes import library as routes
from shared.database import DatabaseManager
from shared.library_mutations import apply_playlist_command, LibraryMutationError
from shared.library_repository import LibraryConflict
from shared.models import LibraryMetadata
from shared.request_scope import request_scope
from tests.test_sqlite_canonical_library import _track


def database(tmp_path, count=2):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    db.replace_library(LibraryMetadata(version=1, tracks=[_track(f't{i}') for i in range(count)], playlists={'Mix': ['t0']}, settings={}))
    return db


def command(db, kind, playlist=None, **data):
    return db.mutate_playlists(lambda metadata: apply_playlist_command(metadata, kind, playlist, data))


def test_invalid_multi_field_update_changes_neither_memory_nor_disk(tmp_path):
    db = database(tmp_path)
    before = db.load_library_metadata().to_json()
    revision = db.get_library_revision()
    with pytest.raises(LibraryMutationError):
        command(db, 'update', 'Mix', name='Renamed', cover_track_id=123)
    assert db.load_library_metadata().to_json() == before
    assert db.get_library_revision() == revision


def test_failed_commit_rolls_back_every_field(tmp_path):
    db = database(tmp_path)
    with db._get_connection() as conn:
        conn.execute("CREATE TRIGGER reject_playlist BEFORE UPDATE ON library_state BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        command(db, 'update', 'Mix', name='Renamed')
    assert db.load_library_metadata().playlists == {'Mix': ['t0']}


def test_route_does_not_publish_failed_commit(monkeypatch):
    manager = LibraryManager(silent=True)
    manager.sync_library()
    events = []
    monkeypatch.setattr(routes, '_get_api', lambda: {'get_core': lambda: (manager, None, None), 'emit_to_user': lambda *args: events.append(args)})
    with manager.db._get_connection() as conn:
        conn.execute("CREATE TRIGGER reject_playlist BEFORE UPDATE ON library_state BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    app = Flask(__name__)
    app.add_url_rule('/playlists', view_func=inspect.unwrap(routes.create_playlist), methods=['POST'])
    response = app.test_client().post('/playlists', json={'name': 'Never saved'})
    assert response.status_code == 503
    assert events == []
    assert manager.metadata.playlists == {}
    assert manager.db.load_library_metadata().playlists == {}


def test_two_independent_writers_preserve_both_playlist_changes(tmp_path):
    db = database(tmp_path)
    def write(name):
        with request_scope():
            peer = DatabaseManager(str(db.db_path))
            command(peer, 'create', name=name)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(write, ['First', 'Second']))
    assert set(db.load_library_metadata().playlists) == {'Mix', 'First', 'Second'}


def test_stale_snapshot_cannot_erase_a_concurrent_playlist(tmp_path):
    db = database(tmp_path)
    stale = db.load_library_metadata()
    revision = db.get_library_revision()
    command(db, 'create', name='New')
    with pytest.raises(LibraryConflict):
        db.replace_library(stale, expected_revision=revision)
    assert 'New' in db.load_library_metadata().playlists


def test_playlist_write_cost_does_not_grow_with_track_count(tmp_path):
    costs = []
    for count in (10, 1000):
        folder = tmp_path / str(count)
        db = database(folder, count)
        conn = db._get_connection()
        before = conn.total_changes
        command(db, 'add', 'Mix', track_id='t1')
        costs.append(conn.total_changes - before)
    assert costs[1] == costs[0]
    assert costs[0] < 20


def test_unchanged_snapshot_does_not_rewrite_tracks_or_fts(tmp_path):
    db = database(tmp_path, 20)
    snapshot = db.load_library_metadata()
    # Prime fingerprints with the normalized round-trip representation.
    db.replace_library(snapshot)
    first = db.library_page()
    snapshot.playlists['Mix'].append('t1')
    db.replace_library(snapshot)
    delta = db.library_page(since=first['revision'], epoch=first['epoch'])
    assert delta['mode'] == 'delta'
    assert delta['tracks'] == []
    assert delta['playlists']['Mix'] == ['t0', 't1']


def test_exports_follow_latest_committed_playlist():
    manager = LibraryManager(silent=True)
    manager.sync_library()
    for name in ('First', 'Second'):
        manager.mutate_playlists(lambda metadata, name=name: apply_playlist_command(metadata, 'create', None, {'name': name}))
    flush_exports()
    assert json.loads(manager.manifest_path.read_text())['playlists'] == {'First': [], 'Second': []}


def test_reorder_cannot_silently_delete_an_unlisted_playlist(tmp_path):
    db = database(tmp_path)
    with pytest.raises(LibraryMutationError):
        command(db, 'reorder', order=[])
    assert db.load_library_metadata().playlists == {'Mix': ['t0']}


def test_targeted_metadata_edit_does_not_rewrite_unrelated_tracks(tmp_path):
    db = database(tmp_path, 50)
    metadata = db.load_library_metadata()
    db.replace_library(metadata)
    first = db.library_page()
    metadata.tracks[0].title = 'Edited'
    db.replace_library(metadata, changed_ids={'t0'}, expected_revision=db.get_library_revision())
    delta = db.library_page(since=first['revision'], epoch=first['epoch'])
    assert [track['id'] for track in delta['tracks']] == ['t0']
    assert delta['tracks'][0]['title'] == 'Edited'


def test_direct_sql_write_invalidates_the_track_comparison_cache(tmp_path):
    db = database(tmp_path)
    snapshot = db.load_library_metadata()
    db.replace_library(snapshot)
    with db._get_connection() as conn:
        conn.execute("UPDATE tracks SET title='External' WHERE id='t0'")
    db.replace_library(snapshot)
    assert db.load_library_metadata().tracks[0].title == snapshot.tracks[0].title
