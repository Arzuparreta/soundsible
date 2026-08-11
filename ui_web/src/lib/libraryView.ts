import { createSignal } from 'solid-js';
import type { CatalogArtist, Track } from '../types/music';
import {
  DEFAULT_ALBUM_SORT,
  decodeAlbumFilter,
  encodeAlbumFilter,
  resolveAlbumSort,
  type AlbumFilter,
  type AlbumSort,
} from './albumBrowse';
import { t as tr } from './i18n';

export type SortMode = 'recent' | 'az' | 'fav';

function persisted(key: string, def: string) {
  const [get, set] = createSignal(localStorage.getItem(key) ?? def);
  const setP = (v: string) => {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
    set(v);
  };
  return [get, setP] as const;
}

/** Persisted library browse preferences (shared so they survive navigation). */
export const [librarySort, setLibrarySort] = persisted('library:sort', 'recent');
export const [libraryTab, setLibraryTab] = persisted('library:tab', 'songs');
export const [libraryFilter, setLibraryFilter] = persisted('library:filter', 'all');

/* The album grid's own two preferences. Stored as text and read back through
 * the pure helpers in `albumBrowse.ts`, so a value written by an older release
 * — or by hand — resolves to something the grid can actually render instead of
 * an empty screen. */
const [storedAlbumSort, setStoredAlbumSort] = persisted('library:albumSort', DEFAULT_ALBUM_SORT);
const [storedAlbumFilter, setStoredAlbumFilter] = persisted('library:albumFilter', '');

export const albumSort = (): AlbumSort => resolveAlbumSort(storedAlbumSort());
export const setAlbumSort = (next: AlbumSort): void => setStoredAlbumSort(next);
export const albumFilter = (): AlbumFilter => decodeAlbumFilter(storedAlbumFilter());
export const setAlbumFilter = (next: AlbumFilter): void =>
  setStoredAlbumFilter(encodeAlbumFilter(next));

/** Sort a track list by the chosen mode. 'recent' keeps the engine's order. */
export function sortTracks(tracks: Track[], mode: string, favSet: Set<string>): Track[] {
  if (mode === 'az') return [...tracks].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  if (mode === 'fav') {
    return [...tracks].sort((a, b) => (favSet.has(b.id) ? 1 : 0) - (favSet.has(a.id) ? 1 : 0));
  }
  // 'recent' — newest first (backend sends oldest → newest)
  return [...tracks].reverse();
}

/** Narrow a track list to what the chosen filter allows. 'downloaded' keeps
 * only songs that own a file — `source: 'preview'` is a saved song still
 * streaming, the same test `identity.ts` uses to split files from streaming. */
export function filterTracks(tracks: Track[], filter: string): Track[] {
  if (filter === 'downloaded') return tracks.filter((t) => t.source !== 'preview');
  return tracks;
}

export interface ArtistEntry {
  /** The engine's catalog id — what lets a page ask whose songs these are
   * instead of matching a display name. */
  id: string;
  name: string;
  count: number;
  /** A track id to source the avatar cover from. */
  coverId: string;
}

/**
 * Catalog artists in the shape the grids and the local search already read.
 *
 * This used to group the flat track list by its `artist` string, which made
 * "Björk & Rosalía" one performer and "Earth, Wind & Fire" a plausible three.
 * Who performs on a track is `track_artists` in the engine's catalog, and the
 * only honest way to render it is to ask.
 *
 * The order is not the engine's. SQLite sorts names by code point, which files
 * every accented name after Z; collation is a presentation question and this is
 * where it gets answered.
 */
export function catalogArtists(rows: CatalogArtist[]): ArtistEntry[] {
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name || tr('libraryView.unknownArtist'),
      count: row.track_count,
      coverId: row.cover_track_id || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
