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
    assert db.set_track_rating('file', 5)
    assert db.record_track_play('file', 100)

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
    assert db.get_track_user_state(item_id) == {'play_count': 1, 'rating': 5, 'last_played_at': 100}
    metadata.add_track(file('another-download'))
    db.replace_library(metadata)
    assert db.get_track_user_state('another-download') == {'play_count': 1, 'rating': 5, 'last_played_at': 100}


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


def test_retries_of_a_direct_stream_do_not_choose_between_ambiguous_file_editions(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = library(file('one'), file('two'))
    db.replace_library(metadata)
    entry = {'keys': [f'yt:{VIDEO}'], 'title': 'Autorretrato', 'artist': 'Extremoduro'}
    db.replace_library(metadata, playlist_entry=('Mix', dict(entry)))
    item_id = metadata.playlists['Mix'][0]
    db.replace_library(metadata, playlist_entry=('Mix', dict(entry)))
    snapshot = Collection(db).snapshot()
    assert snapshot['playlists'] == {'Mix': [item_id]}
    assert len(snapshot['items']) == 3
    assert next(row for row in snapshot['items'] if row['item_id'] == item_id)['source'] == 'preview'


def test_two_saved_managers_cannot_overwrite_each_others_changes():
    from player.favourites_manager import FavouritesManager
    first, second = FavouritesManager(), FavouritesManager()
    first.set_saved([{'keys': ['yt:7N3rFdE3u3Y'], 'title': 'First'}], True)
    second.set_saved([{'keys': ['yt:kJoC5KDWtAI'], 'title': 'Second'}], True)
    assert {row['title'] for row in first.get_entries()} == {'First', 'Second'}


def test_migrated_undated_files_keep_their_existing_newest_first_order(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    tracks = [file('first'), file('second'), file('third')]
    for index, track in enumerate(tracks):
        track.youtube_id = f'video-{index}'
    db.replace_library(library(*tracks))
    assert [row['id'] for row in Collection(db).snapshot()['items']] == ['third', 'second', 'first']


def test_unsaving_after_the_last_file_leaves_is_independent_of_historical_file_keys():
    from player.favourites_manager import FavouritesManager
    db = DatabaseManager()
    metadata = library(file())
    db.replace_library(metadata, playlist_entry=('Mix', {'keys': [f'yt:{VIDEO}'], 'title': 'Autorretrato'}))
    item_id = metadata.playlists['Mix'][0]
    metadata.tracks = []
    metadata.playlists['Mix'] = []
    db.replace_library(metadata)
    manager = FavouritesManager()
    entry = manager.get_entries()[0]
    assert entry['item_id'] == item_id
    assert 'lib:file' in entry['keys']
    manager.set_saved([entry], False)
    assert Collection(db).snapshot()['items'] == []


def test_catalog_references_are_current_account_annotations_not_provider_cache(tmp_path, monkeypatch):
    from flask import Flask, jsonify
    from shared.api.routes.catalog import collection_references
    from shared.user_context import current_user_id, user_context
    from shared import database

    databases = {name: DatabaseManager(str(tmp_path / f'{name}.db')) for name in ('alice', 'bob')}
    for name, db in databases.items():
        db.replace_library(library(file(name)))
    monkeypatch.setattr(database, 'user_db', lambda: databases[current_user_id()])
    cached_provider_body = {'items': [{'type': 'track', 'id': 'youtube:track:video',
        'external_ids': {'youtube_id': VIDEO}, 'raw': {'id': VIDEO}}]}
    app = Flask(__name__)
    app.after_request(collection_references)
    app.add_url_rule('/api/catalog/search', view_func=lambda: jsonify(cached_provider_body))
    client = app.test_client()
    for name in ('alice', 'bob'):
        with user_context(name):
            response = client.get('/api/catalog/search')
            assert response.get_json()['items'][0]['item_id'] == name
            assert response.headers['Cache-Control'] == 'private, no-cache'
            assert 'Cookie' in response.vary
    assert 'item_id' not in cached_provider_body['items'][0]
    databases['alice'].replace_library(library(file('alice'), file('another-edition')))
    with user_context('alice'):
        # The same cached provider result is now ambiguous; it cannot choose a file.
        assert 'item_id' not in client.get('/api/catalog/search').get_json()['items'][0]


def test_car_playlist_uses_stable_rows_and_separate_audio_sources(tmp_path, monkeypatch):
    from flask import Flask
    from types import SimpleNamespace
    from shared.api.routes import car
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = library()
    entry = {'keys': [f'yt:{VIDEO}'], 'title': 'Autorretrato', 'artist': 'Extremoduro'}
    db.replace_library(metadata, playlist_entry=('Mix', entry))
    item_id = entry['item_id']
    lib = SimpleNamespace(db=db, metadata=metadata, refresh_if_stale=lambda: None)
    monkeypatch.setattr(car, '_get_api', lambda: {'get_core': lambda: (lib, None, None)})
    app = Flask(__name__)
    app.register_blueprint(car.car_bp)
    client = app.test_client()
    streamed = client.get('/api/car/items/playlist:Mix').get_json()['items'][0]
    assert streamed['id'] == item_id
    assert streamed['stream_url'] == f'/api/preview/stream/{VIDEO}'
    metadata.add_track(file())
    db.replace_library(metadata)
    downloaded = client.get('/api/car/items/playlist:Mix').get_json()['items'][0]
    assert downloaded['id'] == item_id
    assert downloaded['track_id'] == 'file'
    assert downloaded['stream_url'] == '/api/static/stream/file'


@pytest.mark.parametrize('document', [{}, {'saved': {}}, {'saved': [{'title': 'Missing identity'}]}])
def test_invalid_legacy_shapes_cannot_silently_complete_an_empty_migration(tmp_path, document):
    (tmp_path / 'favourites.json').write_text(json.dumps(document))
    db = DatabaseManager(str(tmp_path / 'library.db'))
    with pytest.raises(ValueError):
        db.replace_library(library(file()))
    with db._get_connection() as conn:
        assert conn.execute('SELECT count(*) FROM collection_state').fetchone()[0] == 0


def test_saved_source_repair_keeps_history_for_already_prepared_audio():
    from player.favourites_manager import FavouritesManager
    db = DatabaseManager()
    metadata = library()
    entry = {'keys': [f'yt:{VIDEO}'], 'title': 'Autorretrato'}
    db.replace_library(metadata, playlist_entry=('Mix', entry))
    item_id = entry['item_id']
    metadata.add_track(file('before'))
    db.replace_library(metadata)
    metadata.tracks = [replace(metadata.tracks[0], id='after', file_hash='after')]
    db.replace_library(metadata, id_replacements={'before': 'after'})
    manager = FavouritesManager()
    assert manager.remap_library_id('before', 'after') is False  # already admitted by the source write
    metadata.tracks = []
    db.replace_library(metadata)
    assert db.record_track_play('before', 123)
    assert db.get_track_user_state(item_id)['play_count'] == 1


def test_car_radio_offers_one_seed_for_an_item_with_several_acquired_sources(tmp_path, monkeypatch):
    from flask import Flask
    from types import SimpleNamespace
    from shared.api.routes import car
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = library(file('first-source'))
    db.replace_library(metadata)
    item_id = metadata.tracks[0].item_id
    metadata.add_track(replace(metadata.tracks[0], id='second-source', file_hash='second-source'))
    db.replace_library(metadata)
    lib = SimpleNamespace(db=db, metadata=metadata, refresh_if_stale=lambda: None)
    monkeypatch.setattr(car, '_get_api', lambda: {'get_core': lambda: (lib, None, None)})
    app = Flask(__name__)
    app.register_blueprint(car.car_bp)
    rows = app.test_client().get('/api/car/items/radio').get_json()['items']
    assert [(row['id'], row['track_id'], row['kind']) for row in rows] == [(item_id, 'first-source', 'radio_seed')]
