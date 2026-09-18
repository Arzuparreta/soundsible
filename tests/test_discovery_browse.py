from collections import Counter
from types import SimpleNamespace

from shared.discovery_browse import build_browse_sections
from shared.providers import deezer


def artist(aid, name=None):
    return {"id": aid, "name": name or f"Artist {aid}", "picture_big": f"https://image.test/{aid}"}


def test_personalized_entities_are_interleaved_unique_and_navigable(monkeypatch):
    def get(path, params=None, **kwargs):
        if path == "search/artist":
            return {"data": [artist(int(params["q"].split()[-1]))]}
        if path.endswith("/related"):
            aid = int(path.split('/')[1])
            return {"data": [artist(10 + aid), artist(99), artist(aid), artist(20 + aid)]}
        if path.endswith("/albums"):
            aid = int(path.split('/')[1])
            return {"data": [{"id": aid * 100 + i, "title": f"Album {i}", "record_type": "single" if i == 0 else "album"} for i in range(5)]}
        raise AssertionError(path)
    monkeypatch.setattr(deezer, 'get', get)
    body = build_browse_sections(['Artist 1', 'Artist 2'])
    artists, albums = body['browse_sections']
    assert [r['title'] for r in artists['items']][:3] == ['Artist 11', 'Artist 12', 'Artist 99']
    assert len({r['id'] for r in artists['items']}) == len(artists['items'])
    assert artists['items'][0]['reason_artist'] == 'Artist 1'
    assert not artists['popular']
    assert len(albums['items']) == 10
    counts = Counter(r['external_ids']['deezer_artist_id'] for r in albums['items'])
    assert max(counts.values()) == 2
    assert all(r['external_ids']['deezer_album_id'] for r in albums['items'])
    assert not any(r['title'] == 'Album 0' for r in albums['items'])
    assert not body['browse_error']


def test_cold_start_uses_popular_entities_without_personalized_reasons(monkeypatch):
    def get(path, params=None, **kwargs):
        if path.endswith('artists'):
            return {'data': [artist(1), artist(1), {'name': 'Invalid'}]}
        return {'data': [{'id': i, 'title': f'Album {i}', 'artist': artist(i % 3 + 1)} for i in range(1, 12)]}
    monkeypatch.setattr(deezer, 'get', get)
    body = build_browse_sections([])
    assert all(s['popular'] for s in body['browse_sections'])
    assert len(body['browse_sections'][0]['items']) == 1
    assert len(body['browse_sections'][1]['items']) == 6
    assert all(not i['reason_artist'] for s in body['browse_sections'] for i in s['items'])


def test_partial_provider_failure_keeps_other_section(monkeypatch):
    def get(path, params=None, **kwargs):
        if path.endswith('artists'):
            raise TimeoutError()
        return {'data': [{'id': 10, 'title': 'Still available', 'artist': artist(1)}]}
    monkeypatch.setattr(deezer, 'get', get)
    body = build_browse_sections([])
    assert body['browse_error']
    assert [s['id'] for s in body['browse_sections']] == ['albums']


def test_does_not_attribute_approximate_artist_match_to_listener(monkeypatch):
    calls = []
    def get(path, params=None, **kwargs):
        calls.append(path)
        return {'data': [artist(1, 'Different Artist')]}
    monkeypatch.setattr(deezer, 'get', get)
    assert build_browse_sections(['Wanted Artist'])['browse_sections'] == []
    assert calls == ['search/artist']


def test_seed_selection_uses_listening_without_library_and_respects_disabled_learning(monkeypatch):
    from shared.api.routes import discovery_feed as route
    from shared.discovery_intelligence import emit_discovery_event, save_discovery_settings
    metadata = SimpleNamespace(tracks=[], playlists={})
    emit_discovery_event('music_played_30s', {'title': 'Song', 'artist': 'Listened Artist'})
    assert route._top_taste_artists(metadata, []) == ['Listened Artist']
    save_discovery_settings({'learning_enabled': False})
    assert route._top_taste_artists(metadata, []) == []


def test_feed_cache_reports_inflight_and_keeps_accounts_separate(monkeypatch):
    from flask import Flask
    from shared.api.routes import discovery_feed as route
    from shared.user_context import user_context
    import time

    monkeypatch.setattr(route, '_DISCOVERY_FEED_CACHE', {
        'discovery-feed-v4:alice:10': (time.time() + 180, time.time() + 3600, {'browse_sections': [{'id': 'artists', 'items': [{'title': 'Alice artist'}]}]}),
        'discovery-feed-v4:bob:10': (time.time() + 180, time.time() + 3600, {'browse_sections': [{'id': 'artists', 'items': [{'title': 'Bob artist'}]}]}),
    })
    monkeypatch.setattr(route, '_DISCOVERY_FEED_INFLIGHT', {'discovery-feed-v4:alice:10'})
    app = Flask(__name__)
    for user_id, expected_busy in [('alice', True), ('bob', False)]:
        with app.test_request_context('/api/discovery/music/feed?limit=10'), user_context(user_id):
            body = route.discovery_music_feed.__wrapped__().get_json()
        assert body['revalidating'] is expected_busy
        assert body['browse_sections'][0]['items'][0]['title'] == f'{user_id.title()} artist'


def test_failed_enrichment_preserves_cached_entities(monkeypatch):
    from shared.api.routes import discovery_feed as route
    key = 'discovery-feed-v4:testuser:10'
    old = {'id': 'artists', 'items': [{'title': 'Existing'}]}
    monkeypatch.setattr(route, '_DISCOVERY_FEED_CACHE', {key: (0, 9999999999, {'browse_sections': [old]})})
    monkeypatch.setattr(route, '_DISCOVERY_FEED_INFLIGHT', {key})
    monkeypatch.setattr(route, '_build_discovery_feed_body', lambda *args, **kwargs: {'browse_error': True, 'browse_sections': []})
    route._refresh_discovery_feed_cache(key, 'testuser', 10)
    assert route._DISCOVERY_FEED_CACHE[key][2]['browse_sections'] == [old]
    assert key not in route._DISCOVERY_FEED_INFLIGHT
