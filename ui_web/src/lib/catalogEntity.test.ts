import { expect, it } from 'vitest';
import { catalogEntityBookmark, catalogEntityDestination, catalogEntityHeld, catalogEntityHoldings, prioritizeCatalogItems } from './catalogEntity';
import { sameEntity } from './savedEntityIdentity';
import type { CatalogItem, Track } from '../types/music';
const album = (id: string): CatalogItem => ({ id: `album:${id}`, type: 'album', source: 'deezer', title: 'Same record', artist: 'Guest',
  raw: { album_artist: 'Various Artists' }, external_ids: { deezer_album_id: id } });
it('keeps namesake editions distinct and compilation credits through navigation and bookmarks', () => {
  expect(catalogEntityDestination(album('1'))).toBe('/album/Same%20record?artist=Various+Artists&view=discover&deezer_id=1');
  expect(sameEntity(catalogEntityBookmark(album('1'))!, catalogEntityBookmark(album('2'))!)).toBe(false);
  expect(catalogEntityDestination({ ...album('1'), type: 'track' })).toBeUndefined();
});
it('infers holdings only from exact ids and preserves order without hiding known results', () => {
  const holdings = catalogEntityHoldings([{ id: 'song', title: 'Song', artist: 'Guest', deezer_album_id: '1' } as Track]);
  expect(catalogEntityHeld(album('1'), holdings)).toBe(true);
  expect(catalogEntityHeld(album('2'), holdings)).toBe(false);
  const items = [album('1'), album('2'), album('3')];
  expect(prioritizeCatalogItems(items, item => catalogEntityHeld(item, holdings)).map(item => item.id)).toEqual(['album:2', 'album:3', 'album:1']);
  expect(items[0].id).toBe('album:1');
});
it('preserves Unicode and local catalog ids instead of resolving homonyms by name', () => {
  const item: CatalogItem = { id: 'local-artist', source: 'library', type: 'artist', title: 'Björk', raw: { artist_id: 'local-artist' } };
  expect(catalogEntityDestination(item)).toBe('/artist/Bj%C3%B6rk?view=library&artist_id=local-artist');
  expect(catalogEntityHeld(item, new Set())).toBe(true);
});
