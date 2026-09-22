"""Fast revalidation must observe every public dependency, including dirty RAM."""
from copy import deepcopy
from types import SimpleNamespace
import sqlite3

from flask import Flask
import pytest

from shared.api.library_revision import fingerprint, validators
from shared.artwork import ArtworkStore, artwork_store
from shared.loudness import LoudnessMeasurement, LoudnessStore
from shared.loudness.store import loudness_db_path, reset_connections
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context


def model():
    return LibraryMetadata(1, [Track(
        id="song", title="Canción", artist="Artist", album="Album", duration=180,
        file_hash="hash", original_filename="song.mp3", compressed=False,
        file_size=1000, bitrate=320, format="mp3", artists=["Artist"],
    )], {"Playlist": ["song"]}, {"nested": {"flags": [True]}},
        podcast_subscriptions=[{"id": "feed"}], podcast_episode_cache={"feed": {"episodes": []}})


@pytest.fixture
def endpoint(monkeypatch):
    from shared.api.routes import library
    validators.clear()
    reset_connections()
    lib = SimpleNamespace(metadata=model(), refresh_if_stale=lambda: None)
    monkeypatch.setattr(library, "_get_api", lambda: {"get_core": lambda: (lib, None, None)})
    app = Flask(__name__)
    app.register_blueprint(library.library_bp)
    yield app.test_client(), lib, library
    reset_connections()
    validators.clear()


def test_fingerprint_matches_snapshot_and_ignores_only_private_fields():
    value = model()
    before = fingerprint(value)
    assert before == fingerprint(value.to_public_dict())
    value.tracks[0].local_path = '/private/file'
    value.tracks[0].local_mtime_ns = 42
    assert before == fingerprint(value)
    value.tracks[0].artists.append('Guest')
    assert before != fingerprint(value)
    assert fingerprint(value) == fingerprint(value.to_public_dict())


@pytest.mark.parametrize("empty", [False, True])
def test_warm_revalidation_skips_snapshot_annotations_and_json(endpoint, monkeypatch, empty):
    client, lib, route = endpoint
    if empty:
        lib.metadata.tracks.clear()
    first = client.get('/api/library')
    assert len(validators) == 1
    monkeypatch.setattr(LibraryMetadata, 'to_public_dict', lambda _: pytest.fail('public copy'))
    monkeypatch.setattr(route, 'annotate_tracks', lambda _: pytest.fail('loudness scan'))
    monkeypatch.setattr(artwork_store(), 'annotate', lambda _: pytest.fail('artwork query'))
    monkeypatch.setattr(route, 'jsonify', lambda _: pytest.fail('JSON serialization'))
    response = client.get('/api/library', headers={'If-None-Match': first.headers['ETag']})
    assert response.status_code == 304
    assert not response.data
    assert response.headers['ETag'] == first.headers['ETag']


@pytest.mark.parametrize('change', ['title', 'artists', 'add', 'remove', 'order', 'playlist', 'settings', 'podcasts', 'episodes', 'loudness', 'artwork', 'dimensions'])
def test_fast_path_invalidates_on_each_public_dependency(endpoint, change):
    client, lib, _ = endpoint
    art = artwork_store()
    art.bind('song', 'cover', 'manual')
    if change == 'order':
        other = deepcopy(lib.metadata.tracks[0])
        other.id = 'other'
        lib.metadata.tracks.append(other)
    first = client.get('/api/library')
    value = lib.metadata
    if change == 'title': value.tracks[0].title = 'Edited without a DB save'
    elif change == 'artists': value.tracks[0].artists.append('Guest')
    elif change == 'add':
        added = deepcopy(value.tracks[0])
        added.id = 'new'
        value.tracks.append(added)
    elif change == 'remove': value.tracks.clear()
    elif change == 'order': value.tracks.reverse()
    elif change == 'playlist': value.playlists['Playlist'].clear()
    elif change == 'settings': value.settings['nested']['flags'].append(False)
    elif change == 'podcasts': value.podcast_subscriptions.clear()
    elif change == 'episodes': value.podcast_episode_cache['feed']['episodes'].append({'title': 'New'})
    elif change == 'loudness': LoudnessStore().put('hash', 'stamp', LoudnessMeasurement(-12, -1, 4))
    elif change == 'artwork': art.bind('song', 'different', 'manual')
    elif change == 'dimensions':
        with art.connect() as db:
            db.execute("INSERT INTO objects VALUES ('cover', 800, 600, 'jpeg', 5000)")
    second = client.get('/api/library', headers={'If-None-Match': first.headers['ETag']})
    assert second.status_code == 200
    assert second.headers['ETag'] != first.headers['ETag']
    assert client.get('/api/library', headers={'If-None-Match': second.headers['ETag']}).status_code == 304


def test_validators_are_account_scoped_and_cache_misses_send_full_snapshot(endpoint):
    client, _, _ = endpoint
    with user_context('alice'):
        first = client.get('/api/library')
        assert client.get('/api/library').status_code == 200
    with user_context('bob'):
        second = client.get('/api/library', headers={'If-None-Match': first.headers['ETag']})
        assert second.status_code == 200
        assert second.headers['ETag'] != first.headers['ETag']
    validators.clear()
    with user_context('alice'):
        # Eviction/restart affects only performance, not HTTP semantics.
        assert client.get('/api/library', headers={'If-None-Match': first.headers['ETag']}).status_code == 304


def test_mutation_during_copy_does_not_cache_the_wrong_source(endpoint, monkeypatch):
    client, lib, _ = endpoint
    original = LibraryMetadata.to_public_dict

    def changing_copy(self):
        self.tracks[0].title = 'Changed during copy'
        return original(self)

    monkeypatch.setattr(LibraryMetadata, 'to_public_dict', changing_copy)
    response = client.get('/api/library')
    assert response.status_code == 200
    assert len(validators) == 1
    monkeypatch.setattr(LibraryMetadata, 'to_public_dict', original)
    lib.metadata.tracks[0].title = 'Canción'
    # The validator was cached for the detached edited content, not the old
    # metadata observed before copying. Restoring old metadata must send 200.
    restored = client.get('/api/library', headers={'If-None-Match': response.headers['ETag']})
    assert restored.status_code == 200
    assert restored.get_json()['tracks'][0]['title'] == 'Canción'


def test_annotation_commit_during_response_does_not_cache_mixed_versions(endpoint, monkeypatch):
    client, _, _ = endpoint
    art = artwork_store()
    annotate = art.annotate

    def changed(tracks):
        annotate(tracks)
        art.bind('song', 'new', 'manual')

    monkeypatch.setattr(art, 'annotate', changed)
    first = client.get('/api/library')
    assert len(validators) == 0
    monkeypatch.setattr(art, 'annotate', annotate)
    assert client.get('/api/library', headers={'If-None-Match': first.headers['ETag']}).status_code == 200


def test_loudness_failure_cannot_install_an_incomplete_validator(endpoint, monkeypatch):
    client, _, _ = endpoint
    original = LoudnessStore.measured
    monkeypatch.setattr(LoudnessStore, 'measured', lambda _: (_ for _ in ()).throw(sqlite3.OperationalError('busy')))
    first = client.get('/api/library')
    assert first.status_code == 200
    assert len(validators) == 0
    monkeypatch.setattr(LoudnessStore, 'measured', original)
    LoudnessStore().put('hash', 'stamp', LoudnessMeasurement(-12, -1, 4))
    assert client.get('/api/library', headers={'If-None-Match': first.headers['ETag']}).status_code == 200


def test_unavailable_revision_falls_back_to_full_validation(endpoint, monkeypatch):
    client, _, route = endpoint
    first = client.get('/api/library')
    copies = []
    original = LibraryMetadata.to_public_dict
    monkeypatch.setattr(LibraryMetadata, 'to_public_dict', lambda self: (copies.append(1), original(self))[1])
    monkeypatch.setattr(route, '_annotation_revisions', lambda _: (_ for _ in ()).throw(sqlite3.OperationalError('busy')))
    assert client.get('/api/library', headers={'If-None-Match': first.headers['ETag']}).status_code == 304
    assert copies == [1]


def test_artwork_revision_is_transactional_persistent_and_tracks_external_writes(tmp_path):
    art = ArtworkStore(tmp_path / 'art', tmp_path / 'cache')
    initial = art.public_revision()
    with art.connect() as db:
        db.execute("INSERT INTO refs VALUES ('song', 'cover', 'manual', 1)")
        db.rollback()
    assert art.public_revision() == initial
    art.bind('song', 'cover', 'manual')
    committed = art.public_revision()
    assert committed != initial
    reopened = ArtworkStore(art.root, art.cache)
    assert reopened.public_revision() == committed
    with sqlite3.connect(art.root / 'index.sqlite3') as db:
        db.execute("UPDATE refs SET hash='external' WHERE track_id='song'")
    assert art.public_revision() != committed
    after_external = art.public_revision()
    with art.connect() as db:
        db.execute("INSERT INTO recovery(track_id, state) VALUES ('song', 'pending')")
    assert art.public_revision() == after_external
    art.remap({'song': 'alias'})
    assert art.public_revision() != after_external


def test_loudness_revision_covers_external_update_delete_and_survives_reopen():
    reset_connections()
    store = LoudnessStore()
    initial = store.public_revision()
    store.put('hash', 'stamp', LoudnessMeasurement(-12, -1, 4))
    written = store.public_revision()
    assert written != initial
    reset_connections()
    assert store.public_revision() == written
    with sqlite3.connect(loudness_db_path()) as db:
        db.execute('UPDATE track_loudness SET lufs=-20')
    updated = store.public_revision()
    assert updated != written
    with sqlite3.connect(loudness_db_path()) as db:
        db.execute('DELETE FROM track_loudness')
    assert store.public_revision() != updated
    reset_connections()
