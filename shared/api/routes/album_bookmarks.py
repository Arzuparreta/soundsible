"""Durable, account-scoped album bookmarks, independent of downloads."""
import hashlib
import json
import sqlite3
import unicodedata
from contextlib import closing

from flask import Blueprint, jsonify, request

from shared.hardening import SCOPE_LIBRARY_WRITE, require_scope
from shared.user_context import user_data_dir

album_bookmarks_bp = Blueprint('album_bookmarks', __name__)


def normalize_album(data):
    if not isinstance(data, dict):
        raise ValueError('Album must be an object')
    album = {}
    for field in ('title', 'artist', 'cover', 'albumId', 'deezerId', 'view'):
        value = data.get(field, '')
        if not isinstance(value, str) or len(value) > 4096:
            raise ValueError('Invalid album field')
        album[field] = unicodedata.normalize('NFC', value.strip())
    if not album['title'] or not (album['artist'] or album['albumId'] or album['deezerId']):
        raise ValueError('Album title and artist or identifier required')
    if album['view'] not in ('library', 'discover'):
        album['view'] = 'discover'
    # Explicit identifiers distinguish editions; never collapse known IDs by title.
    identity = ('deezer', album['deezerId']) if album['deezerId'] else (
        ('library', album['albumId']) if album['albumId'] else
        ('name', *(unicodedata.normalize('NFKC', album[k]).casefold() for k in ('artist', 'title')))
    )
    album['id'] = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()
    return album


def database():
    db = sqlite3.connect(user_data_dir() / 'album_bookmarks.sqlite3', timeout=10)
    db.execute('CREATE TABLE IF NOT EXISTS bookmarks (id TEXT PRIMARY KEY, album TEXT NOT NULL, created INTEGER NOT NULL)')
    return db


@album_bookmarks_bp.get('/api/album-bookmarks')
def list_bookmarks():
    with closing(database()) as db:
        albums = [json.loads(row[0]) for row in db.execute('SELECT album FROM bookmarks ORDER BY created DESC, rowid DESC')]
    return jsonify({'albums': albums})


@album_bookmarks_bp.put('/api/album-bookmarks')
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
def save_bookmark():
    try:
        album = normalize_album(request.get_json(silent=True))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    with closing(database()) as db, db:
        db.execute("INSERT INTO bookmarks VALUES (?, ?, unixepoch()) ON CONFLICT(id) DO UPDATE SET album=excluded.album", (album['id'], json.dumps(album)))
    return jsonify({'album': album})


@album_bookmarks_bp.delete('/api/album-bookmarks/<bookmark_id>')
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
def remove_bookmark(bookmark_id):
    with closing(database()) as db, db:
        db.execute('DELETE FROM bookmarks WHERE id=?', (bookmark_id,))
    return jsonify({'status': 'success'})
