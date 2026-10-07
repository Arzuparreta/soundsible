import { createMemo, createRoot } from 'solid-js';
import type { Navigator } from '@solidjs/router';
import { setNowPlayingOpen, state } from '../stores';
import type { CatalogAlbum, CatalogItem, Track } from '../types/music';
import { artistKey } from './artistRoute';
import { albumDestination, artistDestination as linkedArtistDestination, catalogItemMusic, trackMusic, type MusicMetadata } from './musicLinks';

export type { MusicMetadata } from './musicLinks';
export { trackMusic, performerNames, albumDestination } from './musicLinks';

let navigator: Navigator | undefined;
/** The shell supplies its router, also to menus rendered outside route owners. */
export function registerMusicNavigator(value: Navigator): () => void {
  navigator = value;
  return () => { if (navigator === value) navigator = undefined; };
}

export function navigateMusic(path: string): void {
  setNowPlayingOpen(false);
  if (navigator) navigator(path);
  else window.location.hash = path;
}

/** A song shown inside a library list stays in the library. The row can still
 * hold a preview — a search result the user has not downloaded yet — and its
 * artist and album have to lead back to the library pages the list belongs to
 * rather than to Discover. Every such list asks for this instead of correcting
 * `trackMusic` by hand, so a list added later cannot forget the correction. */
export function libraryTrackMusic(track: Track): MusicMetadata {
  return { ...trackMusic(track), view: 'library' };
}

export function catalogMusic(item: CatalogItem): MusicMetadata {
  return catalogItemMusic(item, item.track_id ? state.library?.find((track) => track.id === item.track_id) : undefined);
}

export function albumMusic(album: CatalogAlbum): MusicMetadata {
  return { artist: album.album_artist, artistId: album.album_artist_id ?? undefined,
    album: album.title, albumArtist: album.album_artist, albumId: album.id, view: 'library' };
}

/** Catalog artist ids by comparison key, rebuilt once per catalog change.
 * Only a unique catalog match is safe, so a key two artists share resolves to
 * nothing: never guess between homonyms. A virtualized list can hold hundreds
 * of artist links at once, and each one asking the catalog directly meant
 * re-scanning every artist per link on every revision. */
const catalogArtistIds = createRoot(() => createMemo(() => {
  const ids = new Map<string, string | undefined>();
  for (const artist of state.catalog?.artists ?? []) {
    const key = artistKey(artist.name);
    ids.set(key, ids.has(key) ? undefined : artist.id);
  }
  return ids;
}));

export function artistDestination(meta: MusicMetadata, name: string): string {
  return linkedArtistDestination(meta, name, (key) => catalogArtistIds().get(key));
}

export function catalogDestination(item: CatalogItem): string | undefined {
  const music = catalogMusic(item);
  if (item.type === 'artist') return artistDestination({ ...music, artist: item.title }, item.title);
  if (item.type === 'album') return albumDestination(music);
  return undefined;
}
