import { describe, expect, it } from 'vitest';
import { ENTITY_LIMIT, panelResults } from './playerSearchResults';
import type { CatalogItem, CatalogSection, SearchResult } from '../types/music';

const item = (id: string, type: string, title = id) => ({ id, type, title, artist: 'Artist' }) as unknown as CatalogItem;
const base = { query: 'massive', items: [] as CatalogItem[], sections: [] as CatalogSection[], youtube: [] as SearchResult[], direct: null, playlistNames: [] as string[] };

describe('panelResults', () => {
  it('leads with an artist the server ranks first and lists songs after it', () => {
    const artist = item('ar', 'artist', 'Massive Attack');
    const songs = [item('s1', 'track'), item('s2', 'library_track')];
    const result = panelResults({
      ...base,
      items: [artist, ...songs],
      sections: [
        { id: 'top', item_ids: ['ar'] },
        { id: 'songs', item_ids: ['s1', 's2'] },
        { id: 'artists', item_ids: ['ar'] },
      ] as CatalogSection[],
    });
    expect(result.lead).toBe(artist);
    expect(result.songs).toEqual(songs.map((song) => ({ item: song })));
    // The lead is not repeated among the entities.
    expect(result.entities).toEqual([]);
  });

  it('puts a top song first among the songs and caps each kind of entity', () => {
    const albums = Array.from({ length: ENTITY_LIMIT + 2 }, (_, index) => item(`al${index}`, 'album'));
    const result = panelResults({
      ...base,
      items: [item('top', 'track'), item('s1', 'track'), ...albums],
      sections: [
        { id: 'top', item_ids: ['top'] },
        { id: 'songs', item_ids: ['s1', 'top'] },
        { id: 'albums', item_ids: albums.map((album) => album.id) },
      ] as CatalogSection[],
    });
    expect(result.lead).toBeNull();
    expect(result.songs.map((song) => 'item' in song && song.item.id)).toEqual(['top', 's1']);
    expect(result.entities).toHaveLength(ENTITY_LIMIT);
  });

  it('lists YouTube results as songs when the catalog has none', () => {
    const result = panelResults({ ...base, youtube: [{ id: 'yt1', title: 'Clip', channel: 'Channel' }] });
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0]).toMatchObject({ track: { id: 'yt1', title: 'Clip', source: 'preview' } });
  });

  it('answers a pasted link with that video alone', () => {
    const result = panelResults({ ...base, items: [item('s1', 'track')], direct: { id: 'yt9', title: 'Linked', channel: 'C' } });
    expect(result.songs).toEqual([{ track: expect.objectContaining({ id: 'yt9' }) }]);
    expect(result.entities).toEqual([]);
  });

  it('matches the listener’s own playlists by name', () => {
    const result = panelResults({ ...base, query: 'run', playlistNames: ['Running', 'Night', 'Morning run'] });
    expect(result.playlists).toEqual(['Running', 'Morning run']);
  });
});
