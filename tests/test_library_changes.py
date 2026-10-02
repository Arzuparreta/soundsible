import pytest
from shared.library_repository import LibraryConflict
from tests.test_library_transactions import database, command
from tests.test_sqlite_canonical_library import _track


def test_initial_snapshot_is_bounded_and_preserves_order(tmp_path):
    db = database(tmp_path, 12)
    page = db.library_page(limit=5)
    tracks = page['tracks'][:]
    assert page['mode'] == 'snapshot'
    assert len(tracks) == 5
    while page['next_cursor'] is not None:
        page = db.library_page(limit=5, revision=page['revision'], cursor=page['next_cursor'])
        tracks.extend(page['tracks'])
    assert [track['id'] for track in tracks] == [f't{i}' for i in range(12)]


def test_delta_carries_updated_added_deleted_tracks_and_rekeys(tmp_path):
    db = database(tmp_path, 3)
    before = db.library_page()
    metadata = db.load_library_metadata()
    metadata.tracks.pop(1)
    metadata.tracks[0].title = 'Changed'
    metadata.tracks[0].id = 'rekeyed'
    metadata.tracks.append(_track('new'))
    db.replace_library(metadata, id_replacements={'t0': 'rekeyed'})
    delta = db.library_page(since=before['revision'], epoch=before['epoch'])
    assert set(delta['removed']) == {'t0', 't1'}
    assert {track['id'] for track in delta['tracks']} == {'rekeyed', 't2', 'new'}
    assert delta['playlists'] == {'Mix': ['rekeyed']}
    assert 'local_path' not in delta['tracks'][0]


def test_writer_between_pages_requires_retry(tmp_path):
    db = database(tmp_path, 10)
    first = db.library_page(limit=2)
    command(db, 'create', name='Concurrent')
    with pytest.raises(LibraryConflict):
        db.library_page(revision=first['revision'], cursor=first['next_cursor'])


def test_pruned_or_foreign_cursor_gets_a_fresh_snapshot(tmp_path):
    db = database(tmp_path)
    first = db.library_page()
    with db._get_connection() as conn:
        conn.execute('UPDATE library_sync SET floor=?', (first['revision']+1,))
    assert db.library_page(since=first['revision'], epoch=first['epoch'])['mode'] == 'snapshot'
    assert db.library_page(since=first['revision'], epoch='different-account')['mode'] == 'snapshot'


def test_playlist_only_delta_does_not_ship_any_tracks(tmp_path):
    db = database(tmp_path)
    first = db.library_page()
    command(db, 'add', 'Mix', track_id='preview-not-downloaded')
    delta = db.library_page(since=first['revision'], epoch=first['epoch'])
    assert delta['tracks'] == []
    assert delta['removed'] == []
    assert delta['playlists']['Mix'] == ['t0', 'preview-not-downloaded']
