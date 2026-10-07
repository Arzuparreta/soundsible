"""Explicit edits retain canonical references and existing read projections."""
from copy import deepcopy
from pathlib import Path

import pytest

from player.library import LibraryManager
from shared.library_fingerprint import fingerprint
from shared.library_lifecycle import LibraryPersistenceError
from scripts.benchmark_library_export import library


@pytest.fixture
def manager(monkeypatch):
    target = LibraryManager(silent=True)
    target.metadata = library(12)
    target.metadata.playlists = {'Mix': [t.id for t in target.metadata.tracks[:3]]}
    monkeypatch.setattr(target, '_export_committed', lambda: None)
    assert target._save_metadata()
    return target


@pytest.mark.parametrize('changes', [
    {'title': 'Edited'}, {'artist': 'New artist', 'album': 'New album', 'album_artist': 'Album artist'},
    {'metadata_modified_by_user': True, 'cover_source': 'manual'},
])
def test_edit_matches_full_writer_without_staging_unrelated_rows(manager, changes, tmp_path, monkeypatch):
    from shared.database import DatabaseManager
    expected = deepcopy(manager.metadata)
    for name, value in changes.items():
        setattr(expected.tracks[0], name, value)
    reference = DatabaseManager(str(tmp_path / 'reference.db'))
    reference.replace_library(deepcopy(manager.metadata))
    reference.replace_library(expected)
    track_id = manager.metadata.tracks[0].id
    monkeypatch.setattr(manager.db, 'replace_library', lambda *a, **k: pytest.fail('whole-library write'))
    previous = manager._library_revision
    assert manager.patch_track_metadata(track_id, changes)
    assert manager._library_revision == previous + 1
    actual = manager.db.load_library_metadata()
    expected_stored = reference.load_library_metadata()
    # Dates are claimed independently in the two fixture databases.
    for a, b in zip(actual.tracks, expected_stored.tracks):
        b.added_at = a.added_at
    assert actual.to_public_dict() == expected_stored.to_public_dict()
    assert manager.db.public_source()['fingerprint'] == fingerprint(manager.metadata)
    with manager.db._get_connection() as conn:
        assert conn.execute('SELECT valid FROM library_search_state').fetchone()[0] == 1


def test_failed_edit_never_leaks_into_live_model(manager, monkeypatch):
    before = deepcopy(manager.metadata)
    def failed(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(manager.db, 'patch_track_metadata', failed)
    with pytest.raises(LibraryPersistenceError):
        manager.patch_track_metadata(before.tracks[0].id, {'title': 'Must not appear'})
    assert manager.metadata.tracks[0].title == before.tracks[0].title
    assert manager.db.load_library_metadata().tracks[0].title == before.tracks[0].title


def test_undeclared_unsaved_changes_are_not_committed(manager):
    manager.metadata.tracks[1].title = 'Unrelated dirty edit'
    with pytest.raises(LibraryPersistenceError):
        manager.patch_track_metadata(manager.metadata.tracks[0].id, {'title': 'Declared'})
    assert manager.db.load_library_metadata().tracks[1].title != 'Unrelated dirty edit'


def test_unknown_fields_and_missing_track_are_refused(manager):
    with pytest.raises(ValueError):
        manager.patch_track_metadata(manager.metadata.tracks[0].id, {'id': 'replacement'})
    assert not manager.patch_track_metadata('missing', {'title': 'No song'})


def test_edit_after_new_manager_load(manager, monkeypatch):
    other = LibraryManager(silent=True)
    other._reload_canonical()
    monkeypatch.setattr(other, '_export_committed', lambda: None)
    assert other.patch_track_metadata(other.metadata.tracks[0].id, {'title': 'After restart'})


def test_external_sql_invalidates_proof_and_uses_canonical_fallback(manager):
    track_id = manager.metadata.tracks[0].id
    other_id = manager.metadata.tracks[1].id
    with manager.db._get_connection() as conn:
        conn.execute('UPDATE tracks SET title=? WHERE id=?', ('External change', other_id))
    assert manager.db.public_source() is None
    assert manager.patch_track_metadata(track_id, {'title': 'Declared change'})
    stored = manager.db.load_library_metadata()
    assert stored.tracks[0].title == 'Declared change'
    assert stored.tracks[1].title == 'External change'
    assert manager.db.public_source() is not None


def test_projection_failure_rolls_back_track_and_revision(manager, monkeypatch):
    before = manager._library_revision
    title = manager.metadata.tracks[0].title
    def fail(*args, **kwargs):
        raise OSError('projection failed')
    monkeypatch.setattr('shared.library_search.sync', fail)
    with pytest.raises(LibraryPersistenceError):
        manager.patch_track_metadata(manager.metadata.tracks[0].id, {'title': 'Never committed'})
    assert manager.db.get_library_revision() == before
    assert manager.db.load_library_metadata().tracks[0].title == title


def test_metadata_route_fallback_commits_declared_fields(manager, monkeypatch):
    import inspect
    import shared.api as api
    from shared.api.routes import library as routes
    from flask import Flask
    track_id = manager.metadata.tracks[0].id
    monkeypatch.setattr(manager, 'update_track', lambda *a, **k: False)
    monkeypatch.setattr(api, '_mirror_track_into_pool', lambda *a, **k: None)
    monkeypatch.setattr(api, 'emit_to_user', lambda *a, **k: None)
    monkeypatch.setattr(routes, '_get_api', lambda: {
        'get_core': lambda: (manager, None, None),
        'get_track_by_id': lambda lib, key: lib.metadata.get_track_by_id(key),
        '_mark_track_metadata_updated': api._mark_track_metadata_updated,
    })
    app = Flask(__name__)
    with app.test_request_context(json={'title': 'Route edit'}):
        response = inspect.unwrap(routes.update_track_metadata)(track_id)
    assert response.json == {'status': 'success', 'fallback': 'metadata_only'}
    saved = manager.db.load_library_metadata().tracks[0]
    assert saved.title == 'Route edit'
    assert saved.metadata_modified_by_user


def test_unsupported_embedded_tags_keep_confirmed_library_edits_and_artwork(manager, tmp_path, monkeypatch):
    import io
    import wave
    from PIL import Image
    from shared.artwork import ArtworkStore

    track = manager.metadata.tracks[0]
    track.format = 'wav'
    assert manager._save_metadata()
    audio = tmp_path / 'source.wav'
    with wave.open(str(audio), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b'\0\0' * 1600)
    original = audio.read_bytes()
    image = io.BytesIO()
    Image.new('RGB', (16, 16), 'green').save(image, 'PNG')
    cover = tmp_path / 'cover.png'
    cover.write_bytes(image.getvalue())
    artwork = ArtworkStore(tmp_path / 'artwork', tmp_path / 'variants')
    monkeypatch.setattr('shared.artwork.artwork_store', lambda: artwork)
    monkeypatch.setattr('player.library.resolve_local_track_path', lambda _: str(audio))
    manager._cache = None
    manager._cache_unavailable = True
    manager.provider = None

    assert manager.update_track(track, {'title': 'Edited WAV', 'album_artist': None}, str(cover))
    stored = manager.db.load_library_metadata().get_track_by_id(track.id)
    assert stored.title == 'Edited WAV'
    assert stored.album_artist is None
    assert audio.read_bytes() == original
    assert Path(artwork.path(track.id)).read_bytes() == image.getvalue()
    assert manager.db.public_source()['fingerprint'] == fingerprint(manager.metadata)


@pytest.mark.parametrize('format_name', ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'mp4', 'wav'])
def test_stable_label_routes_never_rewrite_audio_or_membership(manager, tmp_path, monkeypatch, format_name):
    import inspect
    import io
    from flask import Flask
    from PIL import Image
    import shared.api as api
    from shared.api.routes import library as routes
    from shared.artwork import ArtworkStore

    track = manager.metadata.tracks[0]
    track.format = format_name
    track.album_artist = 'Original artist'
    assert manager._save_metadata()
    ids = [row.id for row in manager.metadata.tracks]
    membership = deepcopy(manager.metadata.playlists)
    artwork = ArtworkStore(tmp_path / 'artwork', tmp_path / 'variants')
    monkeypatch.setattr('shared.artwork.artwork_store', lambda: artwork)
    monkeypatch.setattr(api, '_mirror_track_into_pool', lambda *a, **k: None)
    monkeypatch.setattr(api, 'emit_to_user', lambda *a, **k: None)
    def forbidden(*args, **kwargs):
        pytest.fail('Stable label editing must not rewrite or fetch audio')
    monkeypatch.setattr(manager, 'update_track', forbidden)
    monkeypatch.setattr(routes, 'resolve_local_track_path', forbidden)
    monkeypatch.setattr(routes, '_get_api', lambda: {
        'get_core': lambda: (manager, None, None),
        'get_track_by_id': lambda lib, key: lib.metadata.get_track_by_id(key),
        '_mark_track_metadata_updated': api._mark_track_metadata_updated,
        'emit_to_user': api.emit_to_user,
    })
    app = Flask(__name__)
    with app.test_request_context(json={'title': 'Stable title', 'album_artist': None}):
        reply = inspect.unwrap(routes.update_track_labels)(track.id)
    assert reply.json == {'status': 'success', 'storage': 'library', 'id': track.id}
    assert manager.db.load_library_metadata().get_track_by_id(track.id).title == 'Stable title'
    assert manager.db.load_library_metadata().get_track_by_id(track.id).album_artist is None
    image = io.BytesIO()
    Image.new('RGB', (16, 16), 'green').save(image, 'PNG')
    with app.test_request_context(method='POST', data={'file': (io.BytesIO(image.getvalue()), 'cover.png')}):
        reply = inspect.unwrap(routes.upload_track_label_cover)(track.id)
    assert reply.json['storage'] == 'library'
    assert Path(artwork.path(track.id)).read_bytes() == image.getvalue()
    with app.test_request_context(method='POST'):
        reply = inspect.unwrap(routes.clear_track_label_cover)(track.id)
    assert reply.json['storage'] == 'library'
    assert artwork.path(track.id) is None
    assert [row.id for row in manager.metadata.tracks] == ids
    assert manager.metadata.playlists == membership
    assert manager.db.load_library_metadata().get_track_by_id(track.id).format == format_name


@pytest.mark.parametrize('body', [None, [], {}, {'title': None}, {'title': 1}, {'cover_url': 'https://example.com'}, {'title': 'x' * 4097}, {'album_artist': []}])
def test_stable_label_edit_rejects_invalid_payload_without_mutation(manager, monkeypatch, body):
    import inspect
    from flask import Flask
    from shared.api.routes import library as routes
    before = manager.db.load_library_metadata().tracks[0].title
    monkeypatch.setattr(routes, '_get_api', lambda: {
        'get_core': lambda: (manager, None, None),
        'get_track_by_id': lambda lib, key: lib.metadata.get_track_by_id(key),
    })
    with Flask(__name__).test_request_context(json=body):
        reply, status = inspect.unwrap(routes.update_track_labels)(manager.metadata.tracks[0].id)
    assert status == 400
    assert manager.db.load_library_metadata().tracks[0].title == before


@pytest.mark.parametrize('fail_save', [False, True])
def test_stable_cover_rejects_bad_image_or_failed_commit_before_publication(manager, tmp_path, monkeypatch, fail_save):
    import inspect
    import io
    from flask import Flask
    from PIL import Image
    from shared.api.routes import library as routes
    from shared.artwork import ArtworkStore
    artwork = ArtworkStore(tmp_path / 'artwork', tmp_path / 'variants')
    image = io.BytesIO()
    Image.new('RGB', (16, 16), 'red').save(image, 'PNG')
    track = manager.metadata.tracks[0]
    artwork.bind(track.id, artwork.put(image.getvalue()), 'manual')
    before = artwork.ref(track.id)
    monkeypatch.setattr('shared.artwork.artwork_store', lambda: artwork)
    def reject(*args, **kwargs):
        raise LibraryPersistenceError('library_storage_unavailable')
    monkeypatch.setattr(routes, '_get_api', lambda: {
        'get_core': lambda: (manager, None, None),
        'get_track_by_id': lambda lib, key: lib.metadata.get_track_by_id(key),
        '_mark_track_metadata_updated': reject,
    })
    if fail_save:
        image = io.BytesIO()
        Image.new('RGB', (16, 16), 'green').save(image, 'PNG')
        data = image.getvalue()
    else:
        data = b'not an image'
    with Flask(__name__).test_request_context(method='POST', data={'file': (io.BytesIO(data), 'cover.png')}):
        if fail_save:
            with pytest.raises(LibraryPersistenceError):
                inspect.unwrap(routes.upload_track_label_cover)(track.id)
        else:
            reply, status = inspect.unwrap(routes.upload_track_label_cover)(track.id)
            assert status == 400
    assert artwork.ref(track.id) == before
