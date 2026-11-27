import { createSignal } from 'solid-js';
import { filterLocalCollection, normalizeLibraryQuery } from '../lib/librarySearch';
import type { CatalogAlbum, CatalogItem, PlaylistMap, Track } from '../types/music';

export type TvLibraryTab = 'playlists' | 'albums' | 'songs';

export interface TvSearchResultSet {
  albums: CatalogAlbum[];
  catalogAlbums: CatalogItem[];
  tracks: Track[];
  catalogTracks: CatalogItem[];
  playlists: string[];
}

const emptySearchResults = (): TvSearchResultSet => ({
  albums: [],
  catalogAlbums: [],
  tracks: [],
  catalogTracks: [],
  playlists: [],
});

const [searchQuery, setSearchQuery] = createSignal('');
const [searchSubmittedQuery, setSearchSubmittedQuery] = createSignal('');
const [searchStatus, setSearchStatus] = createSignal<'idle' | 'loading' | 'ready' | 'error'>('idle');
const [searchResults, setSearchResults] = createSignal<TvSearchResultSet>(emptySearchResults());
const [libraryTab, setLibraryTab] = createSignal<TvLibraryTab>();
const [libraryAlbums, setLibraryAlbums] = createSignal<CatalogAlbum[]>([]);
const [libraryAlbumsHasMore, setLibraryAlbumsHasMore] = createSignal(false);
const [libraryAlbumsNextOffset, setLibraryAlbumsNextOffset] = createSignal(0);
const [libraryAlbumsRevision, setLibraryAlbumsRevision] = createSignal<number | null>(null);
const [queueOpen, setQueueOpen] = createSignal(false);
const [dimActive, setDimActive] = createSignal(false);
const [tvNotice, setTvNotice] = createSignal<string | null>(null);

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let searchGeneration = 0;

export function showTvNotice(message: string, durationMs = 3000): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  setTvNotice(message);
  noticeTimer = setTimeout(() => {
    setTvNotice(null);
    noticeTimer = null;
  }, durationMs);
}

export function nextSearchGeneration(): number {
  searchGeneration += 1;
  return searchGeneration;
}

export function currentSearchGeneration(): number {
  return searchGeneration;
}

export function resetTvState(): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  searchGeneration += 1;
  setSearchQuery('');
  setSearchSubmittedQuery('');
  setSearchStatus('idle');
  setSearchResults(emptySearchResults());
  setLibraryTab(undefined);
  setLibraryAlbums([]);
  setLibraryAlbumsHasMore(false);
  setLibraryAlbumsNextOffset(0);
  setLibraryAlbumsRevision(null);
  setQueueOpen(false);
  setDimActive(false);
  setTvNotice(null);
}

export function filterPlaylistsByQuery(playlists: PlaylistMap, query: string): string[] {
  const q = normalizeLibraryQuery(query);
  if (!q) return [];
  return filterLocalCollection(Object.keys(playlists), q, name => [name]);
}

export {
  searchQuery,
  setSearchQuery,
  searchSubmittedQuery,
  setSearchSubmittedQuery,
  searchStatus,
  setSearchStatus,
  searchResults,
  setSearchResults,
  libraryTab,
  setLibraryTab,
  libraryAlbums,
  setLibraryAlbums,
  libraryAlbumsHasMore,
  setLibraryAlbumsHasMore,
  libraryAlbumsNextOffset,
  setLibraryAlbumsNextOffset,
  libraryAlbumsRevision,
  setLibraryAlbumsRevision,
  queueOpen,
  setQueueOpen,
  dimActive,
  setDimActive,
  tvNotice,
  emptySearchResults,
};
