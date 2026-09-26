"""Provider boundaries must retain musical metadata without extra lookups."""
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from shared import request_scope
from shared.api.routes import auto_mode, catalog
from shared.music_identity import (
    adapt_youtube_rows,
    canonical_music_identity,
    synced_lyrics_safe,
    youtube_music_metadata,
)

VIDEO = '43S_qfT6vpo'
TITLE = 'La vereda de la puerta de atrás'


@pytest.mark.parametrize('channel', ['Extremoduro (Oficial)', 'Extremoduro Oficial', 'Extremoduro - Topic'])
def test_legacy_mix_and_fresh_adaptation_agree(channel):
    raw = {'id': VIDEO, 'title': TITLE, 'artist': channel, 'channel': channel}
    music = youtube_music_metadata(raw)
    assert music['artist'] == 'Extremoduro'
    assert music['source_artist'] == channel
    assert music['artist_is_channel'] is False
    assert youtube_music_metadata({**raw, **music}) == music
    assert adapt_youtube_rows([raw]) == [{**raw, **music}]
    assert auto_mode._planner_item_from_related(raw)['artist'] == 'Extremoduro'


def test_explicit_artist_and_title_survive_a_label_channel():
    row = {'id': VIDEO, 'artist': 'An Artist (Official)', 'title': 'One - Two (Live)', 'channel': 'Record Label'}
    result = auto_mode._planner_item_from_related(row)
    assert result['artist'] == row['artist']
    assert result['title'] == row['title']
    assert result['source_artist'] == 'Record Label'
    assert result['playback_source_kind'] == 'unverified'


def test_unknown_channel_does_not_certify_itself_or_lose_its_video():
    result = auto_mode._planner_item_from_related({'id': VIDEO, 'title': 'Demo', 'channel': 'Music Mirror'})
    assert result['youtube_id'] == VIDEO
    assert result['artist_is_channel'] is True
    assert result['playback_source_kind'] == 'unverified'


def test_cleaning_the_title_keeps_the_upload_classified_as_a_video():
    """A music video is not album audio just because its song title is clean.

    Album-timed lyrics are only safe on audio uploads, and the source upgrade
    only replaces an upload with a better class of one.
    """
    row = {'id': VIDEO, 'title': 'Extremoduro - So Payaso (Official Music Video)',
           'channel': 'Extremoduro (Oficial)'}
    item = auto_mode._planner_item_from_related(row)
    assert (item['artist'], item['title']) == ('Extremoduro', 'So Payaso')
    again = auto_mode._planner_item_from_feed(item, pool='discovery')
    for adapted in (item, again):
        assert adapted['playback_source_kind'] == 'official_video'
        assert not synced_lyrics_safe(adapted['playback_source_kind'])


def test_official_video_still_upgrades_to_the_artists_audio():
    item = auto_mode._planner_item_from_related({
        'id': 'video000001', 'title': 'KREAM - Arrival (Official Music Video)', 'channel': 'KREAM',
        'duration': 180,
    })
    best = {'id': 'audio000001', 'title': 'KREAM - Arrival (Audio)', 'channel': 'KREAM',
            'duration': 180, 'confidence': 0.95}
    with patch('shared.api.routes.catalog._resolve_candidates', return_value=(best, [best])):
        resolved = auto_mode._resolve_generated_playback(item, None)
    assert resolved['youtube_id'] == 'audio000001'
    assert resolved['playback_source_kind'] == 'artist_audio'
    assert (resolved['artist'], resolved['title']) == ('KREAM', 'Arrival')


def _deezer_row(track_id, title):
    return {'id': track_id, 'title': title, 'duration': 243,
            'artist': {'id': 4163, 'name': 'Extremoduro'},
            'album': {'id': 89128, 'title': 'Yo, Minoría Absoluta'}}


def test_deezer_track_keeps_navigation_ids_without_a_lookup(monkeypatch):
    get = Mock(side_effect=AssertionError('No network needed'))
    monkeypatch.setattr(catalog.deezer, 'get', get)
    item = catalog._deezer_track_to_catalog_item(_deezer_row(707777, TITLE))
    assert item['raw'] == {'deezer_id': '707777', 'deezer_artist_id': '4163', 'deezer_album_id': '89128'}
    get.assert_not_called()


def test_search_keeps_every_song_by_one_deezer_artist():
    """Artist and album ids are shared by a whole discography, so they must
    never become a song's identity keys."""
    items = [catalog._deezer_track_to_catalog_item(_deezer_row(707777 + n, f'Song {n}')) for n in range(3)]
    for rank, item in enumerate(items):
        item['_rank'] = rank
    assert len(catalog._collapse_duplicates(items)) == 3


def test_deezer_seed_keeps_catalog_metadata_through_audio_resolution():
    seed = {'id': 'deezer:707777', 'title': 'Starman - 2012 Remaster', 'artist': 'David Bowie',
            'duration': 258, 'external_ids': {'deezer_id': '707777'}, 'artist_is_channel': False,
            'deezer_artist_id': '997', 'deezer_album_id': '6575789'}
    best = {'id': 'bowie000001', 'title': 'David Bowie – Starman (Official Video)', 'channel': 'David Bowie'}
    with patch('shared.api.routes.catalog._resolve_candidates', return_value=(best, [best])):
        item = auto_mode._planner_resolve_artist_candidate(seed, None)
    assert (item['artist'], item['title']) == ('David Bowie', 'Starman - 2012 Remaster')
    assert (item['deezer_artist_id'], item['deezer_album_id']) == ('997', '6575789')
    assert item['artist_is_channel'] is False
    assert item['youtube_id'] == 'bowie000001'


def local(identifier='local', artist='My edited artist'):
    return SimpleNamespace(id=identifier, youtube_id=VIDEO, artist=artist, title='My - edited title',
                           album='Album', duration=244, artists=[artist], cover_art_key='cover')


def test_library_reconciliation_preserves_policy_and_account_edits():
    item = auto_mode._planner_item_from_related({'id': VIDEO, 'title': TITLE, 'channel': 'Extremoduro (Oficial)'})
    a = SimpleNamespace(tracks=[local()])
    b = SimpleNamespace(tracks=[local(artist='Other account')])
    with request_scope.request_scope():
        result = auto_mode._reconcile_library_sources(a, [item])[0]
        other = auto_mode._reconcile_library_sources(b, [item])[0]
    assert result['track_id'] == 'local'
    assert result['artist'] == 'My edited artist'
    assert result['title'] == 'My - edited title'
    assert other['artist'] == 'Other account'
    for key in ['youtube_id', 'discovery_youtube_id', 'source_pool', 'score', 'recommendation_identity']:
        assert result[key] == item[key]
    assert item['source'] == 'preview'
    again = auto_mode._planner_item_from_feed(result, pool='related')
    assert again['title'] == result['title']
    assert again['artist'] == result['artist']


def test_reconciled_video_and_library_track_are_one_song_to_the_planner():
    item = auto_mode._planner_item_from_related({'id': VIDEO, 'title': TITLE, 'channel': 'Extremoduro (Oficial)'})
    track = local()
    reconciled = auto_mode._reconcile_library_sources(SimpleNamespace(tracks=[track]), [item])[0]
    library = auto_mode._planner_local_item(track, semantic_score=0.8, basis='same_artist', favourite=False)
    assert reconciled['canonical_identity'] == library['canonical_identity']


def test_ambiguous_library_video_is_not_chosen_arbitrarily():
    item = auto_mode._planner_item_from_related({'id': VIDEO, 'title': TITLE, 'channel': 'Extremoduro (Oficial)'})
    metadata = SimpleNamespace(tracks=[local(), local('second', 'Different')])
    assert auto_mode._reconcile_library_sources(metadata, [item]) == [item]
    explicit = {**item, 'track_id': 'second'}
    assert auto_mode._reconcile_library_sources(metadata, [explicit]) == [explicit]


def test_graph_reuses_library_metadata_before_selection(monkeypatch):
    raw = {'id': VIDEO, 'title': TITLE, 'channel': 'Extremoduro (Oficial)'}
    db = Mock()
    db.get_related_mixes.return_value = {VIDEO: [raw]}
    monkeypatch.setattr(auto_mode, 'instance_db', lambda: db)
    fetch = Mock(side_effect=AssertionError('Cached graph must not fetch'))
    monkeypatch.setattr(auto_mode, '_planner_related_future', fetch)
    walk = auto_mode._planner_context_related(SimpleNamespace(tracks=[local()]), [{'youtube_id': VIDEO}], personalise=False)
    assert walk.items[0]['track_id'] == 'local'
    assert walk.items[0]['artist'] == 'My edited artist'
    fetch.assert_not_called()


def test_authoritative_names_are_not_channel_suffixes():
    identity = canonical_music_identity('Artist (Official)', 'A - B', authoritative=True)
    assert identity.artist == 'Artist (Official)'
    assert identity.title == 'A - B'
