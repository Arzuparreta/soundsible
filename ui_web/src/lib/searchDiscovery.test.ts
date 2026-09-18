import { describe, expect, it } from 'vitest';
import { discoveryCatalogItem } from './searchDiscovery';

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
