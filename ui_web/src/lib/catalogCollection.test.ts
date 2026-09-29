import { beforeEach, describe, expect, it } from 'vitest';
import { setState } from '../stores/core';
import { setSavedEntities } from './savedEntities';
import { catalogCollectionLabel, catalogInLibrary, prioritizeDiscoveries } from './catalogCollection';
import { setLocale } from './i18n';
import type { CatalogItem, Track } from '../types/music';

const album = (id: string): CatalogItem => ({ id: `album:${id}`, type: 'album', source: 'deezer', title: 'Same title', artist: 'Artist', external_ids: { deezer_album_id: id } });
beforeEach(() => { setLocale('en'); setState('library', []); setState('saved', []); setSavedEntities([]); });
describe('discovery membership', () => {
  it('distinguishes bookmarks from song holdings and keeps different editions apart', () => {
    setSavedEntities([{ kind: 'album', name: 'Same title', artist: 'Artist', destination: '/album/Same%20title?deezer_id=1' }]);
    expect(catalogInLibrary(album('1'))).toBe(false);
    expect(catalogCollectionLabel(album('1'))).toBe('Saved');
    setState('library', [{ id: 'song', title: 'Song', artist: 'Artist', deezer_album_id: '1' } as Track]);
    expect(catalogCollectionLabel(album('1'))).toBe('Saved · In your library');
    expect(catalogInLibrary(album('2'))).toBe(false);
  });
  it('prefers discoveries without excluding or shuffling the known results', () => {
    const known = { ...album('1'), action_state: { in_library: true } };
    const items = [known, album('2'), album('3')];
    expect(prioritizeDiscoveries(items).map(item => item.id)).toEqual(['album:2', 'album:3', 'album:1']);
    expect(items[0]).toBe(known);
  });
});
