import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from './i18n';
import {
  discoveryCatalogItem,
  discoveryEntityReason,
  discoveryHasVisible,
  discoveryShelfReason,
  discoveryShelfTitle,
  resolveDiscoveryTrackShelves,
} from './searchDiscovery';

beforeEach(async () => {
  await setLocale('en');
});

describe('discovery catalog rows', () => {
  it('keeps exact video and feedback identities without another resolution', () => {
    const item = discoveryCatalogItem({ id: 'youtube:abc', title: 'Song', artist: 'Channel', external_ids: { youtube_id: 'abc' }, recommendation_identity: 'yt:abc' });
    expect(item.source).toBe('youtube');
    expect(item.raw?.id).toBe('abc');
    expect(item.raw?.recommendation).toEqual({ identity: 'yt:abc', source: 'discover', reason: undefined });
  });
  it('preserves ownership and catalog album ids for local songs', () => {
    const item = discoveryCatalogItem({ id: 'library:one', track_id: 'one', title: 'Song', artist: 'Artist', external_ids: { deezer_album_id: '12' } });
    expect(item.type).toBe('library_track');
    expect(item.track_id).toBe('one');
    expect(item.external_ids?.deezer_album_id).toBe('12');
  });
});

describe('structured discovery shelves', () => {
  it('deduplicates section item_ids and falls back to flat items when sections have no matches', () => {
    const shelves = resolveDiscoveryTrackShelves({
      sections: [
        { id: 's1', title: 'More like Band', title_key: 'more_like', title_params: { artist: 'Band' }, reason_key: 'because_listen', item_ids: ['a', 'missing', 'a', 'b'] },
        { id: 'empty', title: 'Empty', item_ids: ['missing'] },
      ],
      items: [
        { id: 'a', title: 'A', artist: 'One' },
        { id: 'b', title: 'B', artist: 'Two' },
      ],
    }, items => [...items]);
    expect(shelves).toHaveLength(1);
    expect(shelves[0].items.map(item => item.id)).toEqual(['a', 'b']);
    expect(discoveryShelfTitle(shelves[0])).toBe('More like Band');
    expect(discoveryShelfReason(shelves[0])).toBe('Similar artists based on your listening');

    const fallback = resolveDiscoveryTrackShelves({
      sections: [{ id: 'empty', title: 'Empty', item_ids: ['missing'] }],
      items: Array.from({ length: 12 }, (_, idx) => ({ id: `t:${idx}`, title: `T${idx}`, artist: 'Art' })),
    }, items => [...items]);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].id).toBe('songs');
    expect(fallback[0].items).toHaveLength(10);
    expect(discoveryShelfTitle(fallback[0])).toBe('Songs you might like');
    expect(discoveryShelfReason(fallback[0])).toBe('');
  });

  it('handles missing titleParams, discoveryHasVisible, and discoveryEntityReason', async () => {
    const shelf = { id: 'x', title: 'Raw Title', titleKey: 'more_like', items: [{ id: '1', title: 'One', source: 'deezer', type: 'track' as const }] };
    expect(discoveryShelfTitle(shelf)).toBe('Raw Title');
    expect(discoveryHasVisible([], [shelf], 'x')).toBe(true);
    expect(discoveryHasVisible([], [shelf], 'other')).toBe(false);

    expect(discoveryEntityReason({ id: '1', type: 'artist', source: 'deezer', title: 'Marea', reason_artist: 'Extremoduro' }, true)).toBe('Similar to Extremoduro');
    expect(discoveryEntityReason({ id: '2', type: 'artist', source: 'deezer', title: 'Extremoduro', reason_artist: 'Extremoduro' }, true)).toBe('');
    await setLocale('es');
    expect(discoveryEntityReason({ id: '3', type: 'album', source: 'deezer', title: 'Disco', artist: 'Marea', reason_artist: 'Extremoduro' }, false)).toBe('Similar a Extremoduro');
  });
});
