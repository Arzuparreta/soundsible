"""Bookmarks survive media/catalog loss, retries, account switches and backups."""
import json

import pytest

from player import saved_entities as store
from shared.library_lifecycle import LibraryPersistenceError
from shared.user_context import user_context, user_config_dir


def album(identity='42', name='Greatest Hits'):
    return {'kind': 'album', 'name': name, 'artist': 'Artist',
            'destination': f'/album/{name}?deezer_id={identity}&view=discover'}


def test_idempotence_order_and_homonyms(isolated_runtime):
    with user_context('owner'):
        first = store.set_saved(album(), True)[0]
        store.set_saved(album('43'), True)
        entries = store.set_saved(album(name='Renamed'), True)
        assert len(entries) == 2
        assert entries[1]['id'] == first['id']
        assert entries[1]['added_at'] == first['added_at']
        assert entries[1]['name'] == 'Renamed'
        assert store.set_saved(album(), False) == entries[:1]
        assert store.set_saved(album(), False) == entries[:1]


def test_accounts_and_no_track_dependency(isolated_runtime):
    with user_context('alice'):
        saved = store.set_saved(album(), True)
    with user_context('bob'):
        assert store.get_entries() == []
        store.set_saved(album('7'), True)
    with user_context('alice'):
        assert store.get_entries() == saved
        assert not (user_config_dir() / 'favourites.json').exists()
        assert not (user_config_dir() / 'library.db').exists()


def test_unresolved_references_never_merge_with_provider_identity(isolated_runtime):
    with user_context('owner'):
        unresolved = {**album(), 'destination': '/album/Greatest%20Hits?artist=Artist'}
        store.set_saved(unresolved, True)
        assert len(store.set_saved(album(), True)) == 2
        assert len(store.set_saved(unresolved, True)) == 2


def test_failed_publication_preserves_previous_collection(isolated_runtime, monkeypatch):
    with user_context('owner'):
        before = store.set_saved(album(), True)
        monkeypatch.setattr(store, 'publish', lambda *args: (_ for _ in ()).throw(OSError('full disk')))
        with pytest.raises(LibraryPersistenceError):
            store.set_saved(album('43'), True)
        assert store.get_entries() == before


def test_corrupt_file_is_not_overwritten(isolated_runtime):
    with user_context('owner'):
        path = user_config_dir() / 'saved_entities.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{broken')
        with pytest.raises(LibraryPersistenceError):
            store.set_saved(album(), True)
        assert path.read_text() == '{broken'


@pytest.mark.parametrize('patch', [
    {'kind': 'song'}, {'name': ''}, {'destination': 'https://example.org/album/a'},
    {'destination': '/artist/a'}, {'destination': '/album/a?deezer_id=1&deezer_id=2'},
])
def test_invalid_entry(patch):
    with pytest.raises(ValueError):
        store.normalise({**album(), **patch})


def test_backup_restores_bookmarks(isolated_runtime, tmp_path):
    from shared.instance_backup import create_backup, restore_backup
    with user_context('owner'):
        entries = store.set_saved(album(), True)
    roots = {'config': isolated_runtime.config_dir, 'data': isolated_runtime.data_dir}
    backup = create_backup(tmp_path / 'backup', roots)
    restored = restore_backup(backup, tmp_path / 'restored')
    payload = json.loads((restored / 'config/users/owner/saved_entities.json').read_text())
    assert payload['entities'] == entries


def test_api_persists_before_notifying_and_rejects_invalid_data(isolated_runtime, monkeypatch):
    from flask import Flask
    from shared.api.routes.library import library_bp
    from shared.api.errors import register_error_handlers
    import shared.api
    import shared.hardening

    app = Flask(__name__)
    app.register_blueprint(library_bp)
    register_error_handlers(app)
    monkeypatch.setattr(shared.hardening, 'get_request_auth_context', lambda **kw: {'kind': 'owner'})
    events = []
    monkeypatch.setattr(shared.api, 'emit_to_user', lambda event: events.append((event, store.get_entries())))
    client = app.test_client()
    endpoint = '/api/library/saved-entities'
    assert client.get(endpoint).json == {'entities': []}
    assert client.put(endpoint, json={'entry': album(), 'saved': True}).status_code == 200
    assert events[0][0] == 'saved_entities_updated'
    assert len(events[0][1]) == 1
    assert len(client.get(endpoint).json['entities']) == 1
    assert client.put(endpoint, json={'entry': album(), 'saved': 'false'}).status_code == 400
    assert client.put(endpoint, json=[]).status_code == 400
    monkeypatch.setattr(store, 'publish', lambda *args: (_ for _ in ()).throw(OSError('full disk')))
    assert client.put(endpoint, json={'entry': album(), 'saved': False}).status_code == 503
    assert len(events) == 1
    assert len(client.get(endpoint).json['entities']) == 1
    monkeypatch.setattr(shared.hardening, 'get_request_auth_context', lambda **kw: {'kind': 'agent', 'scopes': []})
    assert client.put(endpoint, json={'entry': album(), 'saved': False}).status_code == 403


def test_repeat_save_without_provider_metadata_keeps_snapshot(isolated_runtime):
    with user_context('owner'):
        store.set_saved({**album(), 'cover': 'https://example.org/cover.jpg'}, True)
        entries = store.set_saved(album(), True)
        assert entries[0]['cover'] == 'https://example.org/cover.jpg'


SILHOUETTE = 'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg'


def test_deezer_silhouette_is_no_cover_and_a_later_picture_fills_it(isolated_runtime):
    with user_context('owner'):
        assert store.set_saved({**album(), 'cover': SILHOUETTE}, True)[0]['cover'] == ''
        entries = store.set_saved({**album(), 'cover': 'https://example.org/cover.jpg'}, True)
        assert entries[0]['cover'] == 'https://example.org/cover.jpg'


def test_silhouette_saved_earlier_is_read_as_no_cover(isolated_runtime):
    with user_context('owner'):
        store.set_saved(album(), True)
        path = user_config_dir() / 'saved_entities.json'
        payload = json.loads(path.read_text(encoding='utf-8'))
        payload['entities'][0]['cover'] = SILHOUETTE
        path.write_text(json.dumps(payload), encoding='utf-8')
        assert store.get_entries()[0]['cover'] == ''
