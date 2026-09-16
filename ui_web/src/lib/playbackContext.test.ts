import { describe, expect, it } from 'vitest';
import { contextDestination, favouritesContext, libraryContext, playlistContext } from './playbackContext';

describe('where the context card leads', () => {
  it('uses the page the context was played from', () => {
    expect(contextDestination({
      id: 'album:record', kind: 'album', label: 'Record', destination: '/album/Record?artist=Band&view=discover&deezer_id=9',
    })).toBe('/album/Record?artist=Band&view=discover&deezer_id=9');
    expect(contextDestination(libraryContext('Library'))).toBe('/');
    expect(contextDestination(favouritesContext('Favourites'))).toBe('/favourites');
  });

  it('works the page out for a context restored from an older session', () => {
    expect(contextDestination({ id: 'playlist:Road Trip', kind: 'playlist', label: 'Road Trip' }))
      .toBe('/playlists/Road%20Trip');
    expect(contextDestination({ id: 'artist:Björk', kind: 'artist', label: 'Björk' }, { id: 't', title: 't', artist: 'Björk' }))
      .toBe('/artist/Bj%C3%B6rk?view=library');
    expect(contextDestination(
      { id: 'album:Homogenic', kind: 'album', label: 'Homogenic' },
      { id: 'yt', title: 'Joga', artist: 'Björk', source: 'preview', deezer_album_id: '42' },
    )).toBe('/album/Homogenic?artist=Bj%C3%B6rk&view=discover&deezer_id=42');
  });

  it('offers no page for a collection that has none', () => {
    expect(contextDestination({ id: 'selection', kind: 'search', label: '' })).toBeUndefined();
    expect(contextDestination({ id: 'single', kind: 'single', label: '' })).toBeUndefined();
  });
});

describe('playlist contexts', () => {
  it('carry the artwork the playlist grid shows', () => {
    const tracks = [
      { id: 'saved', title: 'Saved', artist: 'A', source: 'preview' as const },
      { id: 'owned', title: 'Owned', artist: 'A' },
    ];
    const context = playlistContext('Mix', tracks, {});
    expect(context).toMatchObject({ id: 'playlist:Mix', kind: 'playlist', label: 'Mix', destination: '/playlists/Mix' });
    expect(context.cover).toContain('/api/static/cover/owned');
    expect(playlistContext('Mix', tracks, { playlist_covers: { Mix: 'saved' } }).cover).toBeUndefined();
  });
});
