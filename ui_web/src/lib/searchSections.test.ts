import { describe, expect, it } from 'vitest';
import {
  bodySections,
  itemsForTypes,
  resolveSections,
  topResultItem,
} from './searchSections';
import type { CatalogItem, CatalogSection } from '../types/music';

function item(id: string, type: string, title = id): CatalogItem {
  return { id, type, source: 'deezer', title } as CatalogItem;
}

describe('resolveSections', () => {
  it('follows the server order rather than a fixed one', () => {
    const items = [item('a1', 'album', 'In Rainbows'), item('t1', 'track', '15 Step')];
    const sections: CatalogSection[] = [
      { id: 'albums', layout: 'grid', item_ids: ['a1'], total: 1 },
      { id: 'songs', layout: 'rows', item_ids: ['t1'], total: 61 },
    ];

    expect(resolveSections(items, sections).map((s) => s.id)).toEqual(['albums', 'songs']);
  });

  it('keeps the pre-cap total so "see all N" needs no second request', () => {
    const sections: CatalogSection[] = [
      { id: 'songs', layout: 'rows', item_ids: ['t1'], total: 61 },
    ];

    expect(resolveSections([item('t1', 'track')], sections)[0].total).toBe(61);
  });

  it('drops ids the payload no longer carries instead of rendering holes', () => {
    const sections: CatalogSection[] = [
      { id: 'songs', layout: 'rows', item_ids: ['t1', 'gone'], total: 2 },
    ];

    expect(resolveSections([item('t1', 'track')], sections)[0].items.map((i) => i.id)).toEqual(['t1']);
  });

  it('omits a section whose every id is missing', () => {
    const sections: CatalogSection[] = [
      { id: 'songs', layout: 'rows', item_ids: ['t1'], total: 1 },
      { id: 'albums', layout: 'grid', item_ids: ['gone'], total: 1 },
    ];

    expect(resolveSections([item('t1', 'track')], sections).map((s) => s.id)).toEqual(['songs']);
  });

  it('falls back to the old grouping when a response carries no sections', () => {
    // An older server, or a cached body from before this contract existed. The
    // page still renders; it just loses the ordering intelligence.
    const items = [
      item('ar1', 'artist'),
      item('t1', 'track'),
      item('al1', 'album'),
    ];

    const resolved = resolveSections(items, []);

    expect(resolved.map((s) => s.id)).toEqual(['songs', 'artists', 'albums']);
    expect(resolved[0].layout).toBe('rows');
    expect(resolved[1].layout).toBe('grid_round');
  });

  it('infers a layout for a section that declares none', () => {
    const sections = [{ id: 'artists', item_ids: ['ar1'] }] as CatalogSection[];

    expect(resolveSections([item('ar1', 'artist')], sections)[0].layout).toBe('grid_round');
  });
});

describe('topResultItem', () => {
  it('returns the hero when the server named one', () => {
    const resolved = resolveSections(
      [item('ar1', 'artist', 'Radiohead'), item('t1', 'track')],
      [
        { id: 'top', layout: 'hero', item_ids: ['ar1'], total: 1 },
        { id: 'songs', layout: 'rows', item_ids: ['t1'], total: 1 },
      ],
    );

    expect(topResultItem(resolved)?.title).toBe('Radiohead');
    expect(bodySections(resolved).map((s) => s.id)).toEqual(['songs']);
  });

  it('returns nothing when the server was not confident enough', () => {
    const resolved = resolveSections(
      [item('t1', 'track')],
      [{ id: 'songs', layout: 'rows', item_ids: ['t1'], total: 1 }],
    );

    expect(topResultItem(resolved)).toBeNull();
  });
});

describe('itemsForTypes', () => {
  it('slices the one response a tab is a view of', () => {
    const items = [item('t1', 'track'), item('l1', 'library_track'), item('ar1', 'artist')];

    expect(itemsForTypes(items, ['track', 'library_track']).map((i) => i.id)).toEqual(['t1', 'l1']);
    expect(itemsForTypes(items, ['artist']).map((i) => i.id)).toEqual(['ar1']);
  });
});
