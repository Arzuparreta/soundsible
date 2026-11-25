import { createMemo, createRoot } from 'solid-js';
import type { Navigator } from '@solidjs/router';
import { setNowPlayingOpen, state } from '../stores';
import type { CatalogAlbum, CatalogItem } from '../types/music';
import { artistKey } from './artistRoute';
import { playerDocked } from './playerDock';
import { albumDestination, artistDestination as linkedArtistDestination, catalogItemMusic, type MusicLinkIntent } from './musicLinks';

export type { MusicLinkIntent } from './musicLinks';
export { trackMusic, performerNames, albumDestination } from './musicLinks';

let navigator: Navigator | undefined;
/** The shell supplies its router, also to menus rendered outside route owners. */
export function registerMusicNavigator(value: Navigator): () => void {
  navigator = value;
  return () => { if (navigator === value) navigator = undefined; };
}

/** Go to a music page. A player over the app closes to show it; one docked
 * beside the app stays open, since the page opens next to it. */
export function navigateMusic(path: string): void {
  if (!playerDocked()) setNowPlayingOpen(false);
  if (navigator) navigator(path);
  else window.location.hash = path;
}

export function catalogMusic(item: CatalogItem): MusicLinkIntent {
  return catalogItemMusic(item, item.track_id ? state.library?.find((track) => track.id === item.track_id) : undefined);
}

export function albumMusic(album: CatalogAlbum): MusicLinkIntent {
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

export function artistDestination(meta: MusicLinkIntent, name: string): string {
  return linkedArtistDestination(meta, name, (key) => catalogArtistIds().get(key));
}

export function catalogDestination(item: CatalogItem): string | undefined {
  const music = catalogMusic(item);
  if (item.type === 'artist') return artistDestination({ ...music, artist: item.title }, item.title);
  if (item.type === 'album') return albumDestination(music);
  return undefined;
}
