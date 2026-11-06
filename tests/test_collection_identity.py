"""The collection survives changes in where its audio comes from."""
import json
from dataclasses import replace

import pytest

from shared.collection import Collection
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track


VIDEO = '7N3rFdE3u3Y'


def file(track_id='file', **fields):
    return Track(id=track_id, file_hash=track_id, title='Autorretrato', artist='Extremoduro',
                 album='Canciones Prohibidas', duration=444, original_filename='song.m4a',
                 file_size=10, bitrate=128, format='m4a', youtube_id=VIDEO, **fields)


def library(*tracks, playlists=None):
    return LibraryMetadata(version=1, tracks=list(tracks), playlists=playlists or {'Mix': []}, settings={})


def test_one_item_survives_stream_download_repair_and_source_removal(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = library()
    db.replace_library(metadata, playlist_entry=('Mix', {
        'keys': [f'yt:{VIDEO}'], 'title': 'Autorretrato', 'artist': 'Extremoduro',
        'added_at': '2020-01-01T00:00:00', 'favourite': True,
    }))
    item_id = metadata.playlists['Mix'][0]
    assert item_id != VIDEO
    before = Collection(db).snapshot()
    assert before['items'][0]['item_id'] == item_id
    assert before['items'][0]['id'] == VIDEO

    metadata.add_track(file())
    db.replace_library(metadata)
    assert metadata.tracks[0].item_id == item_id
    assert metadata.playlists == {'Mix': [item_id]}
    assert Collection(db).snapshot()['items'][0]['id'] == 'file'

    metadata.tracks = [replace(metadata.tracks[0], id='repaired', file_hash='repaired')]
    db.replace_library(metadata, id_replacements={'file': 'repaired'})
    assert metadata.tracks[0].item_id == item_id
    assert metadata.playlists == {'Mix': [item_id]}

    metadata.tracks = []
    db.replace_library(metadata)
    after = Collection(DatabaseManager(str(tmp_path / 'library.db'))).snapshot()
    assert after['playlists'] == before['playlists']
    assert len(after['items']) == 1
    assert after['items'][0]['item_id'] == item_id
    assert after['items'][0]['id'] == VIDEO
    assert after['saved'][0]['added_at'] == before['saved'][0]['added_at']
    assert after['saved'][0]['favourite']


def test_legacy_preview_and_file_reference_migrate_once_without_losing_occurrences(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    old = {'version': '3.0', 'saved': [{
        'keys': [f'yt:{VIDEO}', 'lib:file'], 'title': 'Autorretrato', 'favourite': True,
        'added_at': '2020-01-01T00:00:00', 'favourited_at': '2020-02-01T00:00:00',
    }]}
    path = tmp_path / 'favourites.json'
    path.write_text(json.dumps(old))
    metadata = library(file(), playlists={'Mix': ['file', VIDEO, VIDEO]})
    metadata.settings['playlist_covers'] = {'Mix': VIDEO}
    db.replace_library(metadata)
    assert metadata.playlists == {'Mix': ['file', 'file', 'file']}
    assert metadata.settings['playlist_covers'] == {'Mix': 'file'}
    path.write_text('{broken later legacy JSON')
    restarted = Collection(DatabaseManager(str(tmp_path / 'library.db'))).snapshot()
    assert restarted['playlists'] == metadata.playlists
    assert restarted['saved'][0]['favourite']
    assert restarted['saved'][0]['favourited_at'] == '2020-02-01T00:00:00'


def test_ambiguous_files_are_not_merged_and_video_membership_remains_visible(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = library(file('one'), file('two'), playlists={'Mix': [VIDEO]})
    db.replace_library(metadata)
    assert metadata.tracks[0].item_id != metadata.tracks[1].item_id
    snapshot = Collection(db).snapshot()
    assert len(snapshot['items']) == 3
    assert snapshot['playlists']['Mix'] == [VIDEO]
    assert any(track['item_id'] == VIDEO and track['id'] == VIDEO for track in snapshot['items'])


def test_failed_playlist_commit_cannot_leave_a_saved_or_phantom_song(tmp_path, monkeypatch):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = library()
    db.replace_library(metadata)
    def fail(*args):
        raise RuntimeError('disk failed')
    monkeypatch.setattr(db, '_replace_catalog_projection', fail)
    metadata.tracks = [file()]
    with pytest.raises(RuntimeError, match='disk failed'):
        db.replace_library(metadata, playlist_entry=('Mix', {'keys': [f'yt:{VIDEO}'], 'title': 'Song'}))
    assert Collection(db).snapshot()['items'] == []
    assert Collection(db).snapshot()['saved'] == []
    assert Collection(db).snapshot()['playlists'] == {'Mix': []}


def test_missing_legacy_identity_is_visible_without_inventing_an_audio_source(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    db.replace_library(library(playlists={'Mix': ['unknown-old-hash']}))
    snapshot = Collection(db).snapshot()
    assert snapshot['items'][0]['item_id'] == 'unknown-old-hash'
    assert snapshot['items'][0]['unavailable'] is True
    assert snapshot['playlists']['Mix'] == ['unknown-old-hash']


def test_migration_rolls_back_instead_of_dropping_unreadable_saved_songs(tmp_path):
    path = tmp_path / 'favourites.json'
    path.write_text('{incomplete')
    db = DatabaseManager(str(tmp_path / 'library.db'))
    with pytest.raises(json.JSONDecodeError):
        db.replace_library(library(file()))
    with db._get_connection() as conn:
        assert conn.execute('SELECT count(*) FROM collection_state').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM collection_items').fetchone()[0] == 0
