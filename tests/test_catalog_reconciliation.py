from copy import deepcopy
from dataclasses import replace
from unittest.mock import Mock

import pytest
from flask import Flask

from player.library import LibraryManager
from shared.api.routes import catalog
from shared.catalog_reconciliation import annotate_owned_recordings, reconcile_album, recording_match
from shared.database import StaleLibraryWrite, instance_db
from shared.library_lifecycle import LibraryPersistenceError
from shared.models import LibraryMetadata, Track
from shared.user_context import user_context


def song(**changes):
    return Track.from_dict({**Track(
        id='audio-hash', file_hash='audio-hash', title='Contra Todos', artist='Robe', album='',
        duration=420, original_filename='Robe - Contra Todos.m4a', format='m4a',
        file_size=6858482, bitrate=127, youtube_id='4Rh2Hzz24xc', year=20150609,
        track_number=1, added_at='2026-10-17T12:27:13',
    ).to_dict(), **changes})


def profile():
    return {'title': 'Lo Que Aletea en Nuestras Cabezas', 'artist': 'Robe', 'cover': 'cover', 'genre': 'Rock',
            'year': 2015, 'tracklist': [catalog._catalog_item(
                item_id='deezer:track:3240262871', item_type='track', source='deezer',
                title='Contra Todos', artist='Robe', duration=427,
                album='Lo Que Aletea en Nuestras Cabezas', external_ids={'isrc': 'ES71G1502918'},
                raw={'track_number': 8, 'disc_number': 1, 'year': 2015, 'album_artist': 'Robe'})]}


@pytest.fixture
def cached():
    db = instance_db()
    db.set_cached_resolution('Robe', 'Contra Todos', {
        'id': '4Rh2Hzz24xc', 'duration': 421, 'confidence': .85,
        'confidence_reason': 'title_artist_duration', 'requested_duration': 427,
    })
    return db


@pytest.fixture
def lib(monkeypatch):
    lib = LibraryManager(silent=True)
    monkeypatch.setattr(lib, '_export_committed', Mock())
    lib.metadata = LibraryMetadata(1, [song()], {'Mix': ['audio-hash']}, {})
    assert lib._save_metadata()
    lib._cache_unavailable = True
    return lib


def test_album_read_finds_orphan_without_mutating_public_profile_or_library(cached):
    public = profile()
    before = deepcopy(public)
    track = song()
    result = annotate_owned_recordings(public, [track], cached)
    assert result['tracklist'][0]['track_id'] == track.id
    assert result['tracklist'][0]['action_state'] == {
        'in_library': True, 'playable': True, 'downloadable': False, 'needs_resolution': False}
    assert result['in_library'] and result['reconciliation_needed']
    assert track.album == ''
    assert public == before
    assert not annotate_owned_recordings(public, [], cached)['in_library']


@pytest.mark.parametrize('changes', [
    {'duration': 469}, {'duration': 0}, {'title': 'Contra Todos (Directo)'},
    {'artist': 'Another Robe'}, {'youtube_id': 'other000001'},
    {'isrc': 'ES71G1871914'}, {'media_kind': 'podcast_episode'},
])
def test_conflicting_or_uncorroborated_recordings_are_not_linked(cached, changes):
    assert recording_match(profile()['tracklist'][0], [song(**changes)], cached) is None


def test_name_and_duration_alone_do_not_certify_a_recording():
    assert recording_match(profile()['tracklist'][0], [song()], None) is None


def test_deezer_short_title_does_not_erase_a_live_version(cached):
    item = catalog._deezer_track_to_catalog_item({
        'id': 1, 'title': 'Contra Todos (Directo Mérida, Teatro Romano)', 'title_short': 'Contra Todos',
        'duration': 427, 'artist': {'name': 'Robe'}, 'album': {'title': 'Live'},
    })
    assert item['title'] == 'Contra Todos (Directo Mérida, Teatro Romano)'
    assert recording_match(item, [song()], cached) is None


def test_ambiguous_audio_and_low_confidence_cache_are_not_linked(cached):
    item = profile()['tracklist'][0]
    assert recording_match(item, [song(), song(id='duplicate')], cached) is None
    cached.set_cached_resolution('Robe', 'Contra Todos', {'id': '4Rh2Hzz24xc', 'confidence': .5})
    assert recording_match(item, [song()], cached) is None
    assert recording_match(item, [song(isrc='es71g-1502918')], cached).id == 'audio-hash'


def test_repair_is_durable_idempotent_and_preserves_audio_and_personal_references(lib, cached):
    before = lib.db.get_track('audio-hash').to_dict()
    assert reconcile_album(lib, profile()['tracklist'], cached) == ['audio-hash']
    stored = lib.db.load_library_metadata()
    after = stored.tracks[0].to_dict()
    expected = {**before, 'album': profile()['title'], 'album_artist': 'Robe', 'track_number': 8,
                'disc_number': 1, 'year': 2015, 'isrc': 'ES71G1502918'}
    assert after == expected
    assert stored.playlists == {'Mix': ['audio-hash']}
    assert lib.db.get_tracks_by_album_id(lib.db.get_albums_page()[0]['id'])[0].id == 'audio-hash'
    revision = lib.db.get_library_revision()
    assert reconcile_album(lib, profile()['tracklist'], cached) == []
    assert lib.db.get_library_revision() == revision


@pytest.mark.parametrize('changes', [{'metadata_modified_by_user': True}, {'album': 'My single'}])
def test_existing_records_and_manual_edits_remain_authoritative(lib, cached, changes):
    lib.metadata.tracks[0] = replace(lib.metadata.tracks[0], **changes)
    assert lib._save_metadata()
    before = lib.db.load_library_metadata().to_public_dict()
    assert reconcile_album(lib, profile()['tracklist'], cached) == []
    assert lib.db.load_library_metadata().to_public_dict() == before


def test_ambiguous_release_positions_are_not_persisted(lib, cached):
    first = profile()['tracklist'][0]
    second = {**first, 'raw': {**first['raw'], 'track_number': 2}}
    assert reconcile_album(lib, [first, second], cached) == []
    assert lib.db.get_track('audio-hash').album == ''
    assert not annotate_owned_recordings({'tracklist': [first, second]}, [song()], cached)['reconciliation_needed']


def test_failed_commit_keeps_previous_canonical_state(lib, cached, monkeypatch):
    monkeypatch.setattr(lib.db, 'replace_library', Mock(side_effect=OSError('disk full')))
    with pytest.raises(LibraryPersistenceError, match='persist'):
        reconcile_album(lib, profile()['tracklist'], cached)
    assert lib.metadata.tracks[0].album == ''
    assert lib.db.get_track('audio-hash').album == ''


def test_stale_commit_is_reported_as_conflict(lib, cached, monkeypatch):
    monkeypatch.setattr(lib.db, 'replace_library', Mock(side_effect=StaleLibraryWrite(1, 2)))
    with pytest.raises(LibraryPersistenceError) as error:
        reconcile_album(lib, profile()['tracklist'], cached)
    assert error.value.status == 409
    assert lib.metadata.tracks[0].album == ''


def test_repair_reloads_edits_committed_by_another_writer(lib, cached):
    latest = lib.db.load_library_metadata()
    latest.tracks[0].metadata_modified_by_user = True
    lib.db.replace_library(latest, expected_revision=lib._library_revision)
    assert reconcile_album(lib, profile()['tracklist'], cached) == []
    assert lib.db.get_track('audio-hash').metadata_modified_by_user


def test_other_accounts_do_not_receive_the_repair(lib, cached):
    with user_context('other'):
        other = LibraryManager(silent=True)
        other._export_committed = Mock()
        other.metadata = LibraryMetadata(1, [song()], {}, {})
        assert other._save_metadata()
    reconcile_album(lib, profile()['tracklist'], cached)
    assert other.db.get_track('audio-hash').album == ''


def test_album_route_read_then_authenticated_repair(lib, cached, monkeypatch):
    import shared.api as api
    monkeypatch.setattr(catalog, '_get_api', lambda: {'get_core': lambda: (lib, None, None)})
    monkeypatch.setattr(catalog, '_deezer_album_profile', lambda *args: profile())
    emit = Mock()
    monkeypatch.setattr(api, 'emit_to_user', emit)
    catalog._album_memo.clear()
    app = Flask(__name__)
    app.register_blueprint(catalog.catalog_bp)
    client = app.test_client()
    read = client.get('/api/catalog/album?name=Record&artist=Robe&deezer_id=715226121')
    assert read.status_code == 200
    assert read.json['reconciliation_needed']
    assert lib.db.get_track('audio-hash').album == ''
    response = client.post('/api/catalog/album/reconcile', json={'deezer_id': '715226121', 'album': 'Forged'})
    assert response.status_code == 200
    assert not response.json['reconciliation_needed']
    assert lib.db.get_track('audio-hash').album == profile()['title']
    emit.assert_called_once_with('library_updated')
    assert client.post('/api/catalog/album/reconcile', json={'deezer_id': '../bad'}).status_code == 400


def test_read_only_client_cannot_repair(lib, cached, monkeypatch):
    from shared import hardening
    monkeypatch.setattr(hardening, 'get_request_auth_context', lambda **kw: {
        'kind': 'agent', 'scopes': {'library:read'},
    })
    app = Flask(__name__)
    app.register_blueprint(catalog.catalog_bp)
    response = app.test_client().post('/api/catalog/album/reconcile', json={'deezer_id': '715226121'})
    assert response.status_code == 403
    assert lib.db.get_track('audio-hash').album == ''
