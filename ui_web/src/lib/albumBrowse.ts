/**
 * How the album grid is ordered and narrowed.
 *
 * The orderings are the engine's own — the same table `getAlbumList2` serves
 * over Subsonic (`DatabaseManager.ALBUM_ORDERINGS`) — so the grid here and a
 * grid in Symfonium put the same records in the same sequence. Offering a
 * fourth ordering that only exists in this file is exactly the drift this
 * whole surface is here to remove.
 *
 * The filter is a separate axis: a genre or a year narrows what is on screen
 * without changing what "sorted by year" means, and the engine reconciles the
 * two.
 */

import type { CatalogAlbum } from '../types/music';

/** The orderings the player offers, in the order it offers them. */
export const ALBUM_SORTS = ['newest', 'alphabeticalByName', 'alphabeticalByArtist', 'byYear', 'frequent'] as const;

export type AlbumSort = (typeof ALBUM_SORTS)[number];

export const DEFAULT_ALBUM_SORT: AlbumSort = 'alphabeticalByName';

/** A stored preference is only as good as the release that wrote it. */
export function resolveAlbumSort(stored: string | null | undefined): AlbumSort {
  return (ALBUM_SORTS as readonly string[]).includes(stored ?? '')
    ? (stored as AlbumSort)
    : DEFAULT_ALBUM_SORT;
}

/** What the grid is narrowed to. At most one axis: a genre *and* a year would
 * be a query builder, and this is a shelf. */
export type AlbumFilter =
  | { kind: 'none' }
  | { kind: 'genre'; value: string }
  | { kind: 'year'; value: number };

export const NO_ALBUM_FILTER: AlbumFilter = { kind: 'none' };

/** Serialize a filter for `localStorage`. */
export function encodeAlbumFilter(filter: AlbumFilter): string {
  if (filter.kind === 'genre') return `genre:${filter.value}`;
  if (filter.kind === 'year') return `year:${filter.value}`;
  return '';
}

export function decodeAlbumFilter(stored: string | null | undefined): AlbumFilter {
  const raw = stored ?? '';
  if (raw.startsWith('genre:')) {
    const value = raw.slice('genre:'.length);
    return value ? { kind: 'genre', value } : NO_ALBUM_FILTER;
  }
  if (raw.startsWith('year:')) {
    const value = Number.parseInt(raw.slice('year:'.length), 10);
    return Number.isFinite(value) ? { kind: 'year', value } : NO_ALBUM_FILTER;
  }
  return NO_ALBUM_FILTER;
}

/** The query `api.getLibraryAlbums` is called with. */
export function albumBrowseQuery(sort: AlbumSort, filter: AlbumFilter) {
  return {
    sort,
    genre: filter.kind === 'genre' ? filter.value : undefined,
    year: filter.kind === 'year' ? filter.value : undefined,
  };
}

/**
 * Put an alphabetical page in the reader's alphabet.
 *
 * SQLite orders text by code point, so "Ángeles" lands after "Zappa" — wrong in
 * every language this player is translated into. Only the alphabetical modes
 * are touched: "newest" and "most played" are facts about the library that the
 * engine alone can order, and re-sorting those here would discard the answer.
 */
export function collateAlbums(albums: CatalogAlbum[], sort: AlbumSort): CatalogAlbum[] {
  if (sort === 'alphabeticalByName') {
    return [...albums].sort(
      (a, b) => a.title.localeCompare(b.title) || a.album_artist.localeCompare(b.album_artist),
    );
  }
  if (sort === 'alphabeticalByArtist') {
    return [...albums].sort(
      (a, b) => a.album_artist.localeCompare(b.album_artist) || a.title.localeCompare(b.title),
    );
  }
  return albums;
}
