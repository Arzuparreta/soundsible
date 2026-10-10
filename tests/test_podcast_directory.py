"""Country selection, real rankings and exact episode resolution."""
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask
import requests

from shared.api.routes import podcasts_directory as directory
from shared.api.routes import discovery
from shared.models import LibraryMetadata


@pytest.fixture
def client():
    app = Flask(__name__)
    app.register_blueprint(directory.discovery_bp)
    directory._podcast_top_memo.clear()
    directory._episode_chart_memo.clear()
    directory._episode_lookup_memo.clear()
    with patch.object(directory, 'load_discovery_settings', return_value={'podcast_country': 'es'}):
        yield app.test_client()


def response(payload):
    value = MagicMock()
    value.json.return_value = payload
    return value


def test_search_uses_saved_country_and_accepts_explicit_override(client):
    with patch.object(directory.requests, 'get', return_value=response({'results': []})) as get:
        assert client.get('/api/discovery/podcasts/search?q=historia').status_code == 200
        assert get.call_args.kwargs['params']['country'] == 'es'
        client.get('/api/discovery/podcasts/search?q=historia&country=mx')
        assert get.call_args.kwargs['params']['country'] == 'mx'


def test_show_chart_keeps_rank_and_resolves_in_same_country(client):
    chart = {'feed': {'results': [
        {'id': '2', 'name': 'Second id ranked first', 'genres': [{'genreId': '1303', 'name': 'Comedy'}]}, {'id': '1', 'name': 'First id ranked second'}]}}
    lookup = {'results': [{'kind': 'podcast', 'collectionId': i, 'feedUrl': f'https://feeds.example/{i}'} for i in (1, 2)]}
    with patch.object(directory.requests, 'get', side_effect=[response(chart), response(lookup)]) as get:
        data = client.get('/api/discovery/podcasts/top?limit=10').get_json()
    assert data['country'] == 'es'
    assert data['results'][0]['genres'] == [{'id': '1303', 'name': 'Comedy'}]
    assert [r['itunes_collection_id'] for r in data['results']] == ['2', '1']
    assert '/api/v2/es/podcasts/top/10/podcasts.json' in get.call_args_list[0].args[0]
    assert get.call_args_list[1].kwargs['params']['country'] == 'es'


def test_failed_chart_never_masquerades_as_search_ranking(client):
    with patch.object(directory.requests, 'get', side_effect=requests.RequestException('offline')), \
            patch.object(directory, '_top_podcasts_itunes_search_fallback') as fallback:
        assert client.get('/api/discovery/podcasts/top').status_code == 502
        fallback.assert_not_called()


def test_recommendation_exploration_uses_saved_country(client):
    lib = MagicMock(metadata=LibraryMetadata(version=1, tracks=[], playlists={}, settings={}))
    with patch.object(directory, '_get_api', return_value={'get_core': lambda: (lib, None, None)}), \
            patch.object(directory, '_podcast_top_results', return_value=[]) as top, \
            patch.object(directory, 'build_podcast_recommendations', return_value={'items': []}):
        assert client.get('/api/discovery/podcasts/recommendations?limit=5').status_code == 200
    top.assert_called_once_with('es', 5, 'explicit')


def test_episode_chart_identifies_show_and_retains_order(client):
    chart = {'feed': {'results': [{'id': '900', 'name': 'Chapter', 'artistName': 'Host',
              'url': 'https://podcasts.apple.com/es/podcast/chapter/id123?i=900'}]}}
    with patch.object(directory.requests, 'get', return_value=response(chart)), \
            patch.object(directory, '_lookup_feed_urls', return_value={'123': 'https://example.com/rss'}) as lookup:
        data = client.get('/api/discovery/podcasts/top-episodes').get_json()
    assert data['country'] == 'es'
    assert data['results'][0]['episode_id'] == '900'
    assert data['results'][0]['itunes_collection_id'] == '123'
    lookup.assert_called_once_with(['123'], 'es', strict=True)


def test_episode_feed_lookup_failure_is_retryable_instead_of_empty_chart(client):
    chart = {'feed': {'results': [{'id': '900', 'name': 'Chapter',
              'url': 'https://podcasts.apple.com/es/podcast/chapter/id123?i=900'}]}}
    lookup = {'results': [{'kind': 'podcast', 'collectionId': 123, 'feedUrl': 'https://example.com/rss'}]}
    with patch.object(directory.requests, 'get', side_effect=[
            response(chart), requests.RequestException('offline'), response(chart), response(lookup)]):
        failed = client.get('/api/discovery/podcasts/top-episodes')
        assert failed.status_code == 502
        assert failed.get_json()['error'] == 'Directory unreachable'
        recovered = client.get('/api/discovery/podcasts/top-episodes')
        assert recovered.status_code == 200
        assert recovered.get_json()['results'][0]['episode_id'] == '900'


def test_episode_resolution_plays_only_exact_audio_match(client):
    rows = [
        {'kind': 'podcast', 'collectionId': 123, 'collectionName': 'Show', 'feedUrl': 'https://example.com/rss'},
        {'kind': 'podcast-episode', 'collectionId': 123, 'trackId': 900, 'trackName': 'Chapter',
         'episodeContentType': 'audio', 'episodeUrl': 'https://example.com/900.mp3', 'episodeGuid': 'guid-900', 'trackTimeMillis': 42000}]
    with patch.object(directory.requests, 'get', return_value=response({'results': rows})) as get:
        data = client.get('/api/discovery/podcasts/episode?show_id=123&episode_id=900').get_json()
        assert data['episode']['guid'] == 'guid-900'
        assert data['episode']['duration_sec'] == 42
        assert data['episode']['enclosure_url'] == 'https://example.com/900.mp3'
        assert get.call_args.kwargs['params']['country'] == 'es'
        assert client.get('/api/discovery/podcasts/episode?show_id=123&episode_id=901').status_code == 404
        assert get.call_count == 1  # Same show's lookup is cached.
        assert client.get('/api/discovery/podcasts/episode?show_id=invalid&episode_id=900').status_code == 400


@pytest.mark.parametrize('country', ['xx', '', 123, None, 'es/../../us'])
def test_settings_reject_unsupported_country_without_writing(client, country):
    with patch.object(discovery, 'save_discovery_settings') as save:
        assert client.patch('/api/discovery/settings', json={'podcast_country': country}).status_code == 400
        save.assert_not_called()


def test_country_only_patch_does_not_invalidate_music_recommendations(client):
    with patch.object(discovery, 'save_discovery_settings', return_value={'podcast_country': 'mx'}) as save, \
            patch.object(discovery, '_invalidate_personalized_cache') as invalidate:
        assert client.patch('/api/discovery/settings', json={'podcast_country': 'mx'}).get_json()['podcast_country'] == 'mx'
        save.assert_called_once_with({'podcast_country': 'mx'})
        invalidate.assert_not_called()
