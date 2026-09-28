"""Bookmark persistence, identity and account isolation through the HTTP API."""
from unittest.mock import patch

import pytest
from flask import Flask

from shared.api.routes.album_bookmarks import album_bookmarks_bp
from shared.user_context import user_context


@pytest.fixture
def client(tmp_path):
    app = Flask(__name__)
    app.register_blueprint(album_bookmarks_bp)
    with patch('shared.user_context.get_data_dir', return_value=tmp_path), patch(
        'shared.hardening.get_request_auth_context', return_value={'kind': 'owner'}
    ):
        yield app.test_client()


def test_persistence_idempotence_and_account_isolation(client):
    album = {'title': 'Álbum', 'artist': 'Artist', 'albumId': 'one', 'view': 'library'}
    with user_context('alice'):
        first = client.put('/api/album-bookmarks', json=album)
        assert first.status_code == 200
        saved = first.json['album']
        client.put('/api/album-bookmarks', json=album)
        assert client.get('/api/album-bookmarks').json['albums'] == [saved]
    with user_context('bob'):
        assert client.get('/api/album-bookmarks').json['albums'] == []
        client.delete('/api/album-bookmarks/' + saved['id'])
    with user_context('alice'):
        assert len(client.get('/api/album-bookmarks').json['albums']) == 1
        for _ in range(2):
            assert client.delete('/api/album-bookmarks/' + saved['id']).status_code == 200
        assert client.get('/api/album-bookmarks').json['albums'] == []


def test_distinct_editions_and_unicode_names(client):
    with user_context('alice'):
        for identifier in ('one', 'two'):
            client.put('/api/album-bookmarks', json={'title': 'Hits', 'artist': 'Band', 'deezerId': identifier})
        for title in ('ÁLBUM', 'a\u0301lbum'):
            client.put('/api/album-bookmarks', json={'title': title, 'artist': 'Band'})
        assert len(client.get('/api/album-bookmarks').json['albums']) == 3


@pytest.mark.parametrize('payload', [None, [], {'title': 'Unknown'}, {'title': 7}, {'title': 'A', 'artist': ['B']}, {'title': 'A', 'artist': 'B', 'cover': 'x' * 4097}])
def test_invalid_payload(client, payload):
    with user_context('alice'):
        assert client.put('/api/album-bookmarks', json=payload).status_code == 400
        assert client.get('/api/album-bookmarks').json['albums'] == []



def test_writes_require_library_scope(client):
    with user_context('alice'), patch('shared.hardening.get_request_auth_context', return_value=None):
        assert client.put('/api/album-bookmarks', json={'title': 'A', 'artist': 'B'}).status_code == 403
        assert client.delete('/api/album-bookmarks/anything').status_code == 403
