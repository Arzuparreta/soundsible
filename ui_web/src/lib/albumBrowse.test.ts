import { describe, expect, it } from 'vitest';
import {
  ALBUM_SORTS,
  DEFAULT_ALBUM_SORT,
  albumBrowseQuery,
  collateAlbums,
  decodeAlbumFilter,
  encodeAlbumFilter,
  resolveAlbumSort,
  NO_ALBUM_FILTER,
} from './albumBrowse';
import type { CatalogAlbum } from '../types/music';

const album = (over: Partial<CatalogAlbum> = {}): CatalogAlbum => ({
  id: 'al-1',
  title: 'Album',
  album_artist: 'Artist',
  is_compilation: false,
  track_count: 10,
  duration: 1800,
  ...over,
});

describe('album orderings', () => {
  it('offers only orderings the engine actually serves', async () => {
    // The engine's table is the contract (`DatabaseManager.ALBUM_ORDERINGS`).
    // An ordering that exists only in this file is a grid nobody else can
    // reproduce — and a 400 from the route the moment it is asked for.
    const engineOrderings = [
      'newest',
      'alphabeticalByName',
      'alphabeticalByArtist',
      'byYear',
      'byGenre',
      'random',
      'frequent',
      'recent',
      'highest',
    ];
    for (const sort of ALBUM_SORTS) expect(engineOrderings).toContain(sort);
  });

  it('falls back when the stored preference is not one we offer', () => {
    expect(resolveAlbumSort('byYear')).toBe('byYear');
    expect(resolveAlbumSort('byVibes')).toBe(DEFAULT_ALBUM_SORT);
    expect(resolveAlbumSort(null)).toBe(DEFAULT_ALBUM_SORT);
  });
});

describe('album filter', () => {
  it('round-trips a genre and a year through storage', () => {
    for (const filter of [
      NO_ALBUM_FILTER,
      { kind: 'genre', value: 'Rock & Roll' } as const,
      { kind: 'year', value: 1994 } as const,
    ]) {
      expect(decodeAlbumFilter(encodeAlbumFilter(filter))).toEqual(filter);
    }
  });

  it('treats a stored value it cannot read as no filter at all', () => {
    // A grid silently narrowed by something unreadable reads as a shrunken
    // library, which is the one thing an empty screen must never mean.
    expect(decodeAlbumFilter('year:nineteen-ninety-four')).toEqual(NO_ALBUM_FILTER);
    expect(decodeAlbumFilter('genre:')).toEqual(NO_ALBUM_FILTER);
    expect(decodeAlbumFilter('something-else')).toEqual(NO_ALBUM_FILTER);
  });

  it('sends at most one narrowing axis to the engine', () => {
    expect(albumBrowseQuery('byYear', { kind: 'year', value: 1994 })).toEqual({
      sort: 'byYear',
      genre: undefined,
      year: 1994,
    });
    expect(albumBrowseQuery('newest', { kind: 'genre', value: 'Jazz' })).toEqual({
      sort: 'newest',
      genre: 'Jazz',
      year: undefined,
    });
  });
});

describe('collateAlbums', () => {
  it('puts an alphabetical grid in the reader’s alphabet', () => {
    const rows = [
      album({ id: 'z', title: 'Zoo' }),
      album({ id: 'a', title: 'Ámbar' }),
      album({ id: 'b', title: 'Bravo' }),
    ];
    expect(collateAlbums(rows, 'alphabeticalByName').map((a) => a.title)).toEqual([
      'Ámbar',
      'Bravo',
      'Zoo',
    ]);
  });

  it('breaks a shared title on the artist, so two records stay in a stable order', () => {
    const rows = [
      album({ id: '1', title: 'Greatest Hits', album_artist: 'Queen' }),
      album({ id: '2', title: 'Greatest Hits', album_artist: 'ABBA' }),
    ];
    expect(collateAlbums(rows, 'alphabeticalByName').map((a) => a.album_artist)).toEqual([
      'ABBA',
      'Queen',
    ]);
  });

  it('leaves an ordering only the engine can compute exactly as it arrived', () => {
    // "Recently added" and "most played" are facts about the library. Re-sorting
    // them here would throw away the answer and invent one from the page.
    const rows = [album({ id: 'z', title: 'Zoo' }), album({ id: 'a', title: 'Ámbar' })];
    for (const sort of ['newest', 'byYear', 'frequent'] as const) {
      expect(collateAlbums(rows, sort)).toBe(rows);
    }
  });

  it('does not mutate the page it was given', () => {
    const rows = [album({ id: 'z', title: 'Zoo' }), album({ id: 'a', title: 'Ámbar' })];
    collateAlbums(rows, 'alphabeticalByName');
    expect(rows.map((a) => a.title)).toEqual(['Zoo', 'Ámbar']);
  });
});
