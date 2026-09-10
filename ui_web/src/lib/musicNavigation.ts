import type { Navigator } from '@solidjs/router';
import { setNowPlayingOpen, state } from '../stores';
import type { CatalogAlbum, CatalogItem, Track } from '../types/music';
import { albumPath, artistKey, artistPath } from './artistRoute';
import { isPodcastTrack } from './track';

export interface MusicMetadata {
  artist?: string;
  artists?: string[] | null;
  album?: string;
  albumArtist?: string | null;
  view: 'library' | 'discover';
  artistId?: string;
  albumId?: string;
  deezerArtistId?: string;
  deezerAlbumId?: string;
  linkable?: boolean;
}

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

export function trackMusic(track: Track): MusicMetadata {
  return {
    artist: track.artist, artists: track.artists, album: track.album, albumArtist: track.album_artist,
    view: track.source === 'preview' ? 'discover' : 'library',
    artistId: track.artist_id, albumId: track.album_id,
    deezerArtistId: track.deezer_artist_id, deezerAlbumId: track.deezer_album_id,
    linkable: !isPodcastTrack(track) && !track.artist_is_channel,
  };
}

export function catalogMusic(item: CatalogItem): MusicMetadata {
  const owned = item.track_id ? state.library?.find((track) => track.id === item.track_id) : undefined;
  if (owned) return { ...trackMusic(owned), view: item.type === 'library_track' ? 'library' : 'discover' };
  const id = (key: string) => {
    const value = item.external_ids?.[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  };
  return {
    artist: item.artist || (item.source !== 'youtube' ? item.subtitle : '') || '',
    artists: item.raw?.artists,
    album: item.type === 'album' ? item.title : item.album,
    albumArtist: item.raw?.album_artist,
    view: item.type === 'library_track' ? 'library' : 'discover',
    deezerArtistId: id('deezer_artist_id'), deezerAlbumId: id('deezer_album_id'),
    linkable: item.source !== 'youtube' && !isPodcastTrack(item.raw ?? {}),
  };
}

export function albumMusic(album: CatalogAlbum): MusicMetadata {
  return { artist: album.album_artist, artistId: album.album_artist_id ?? undefined,
    album: album.title, albumArtist: album.album_artist, albumId: album.id, view: 'library' };
}

export function performerNames(meta: MusicMetadata): string[] {
  const structured = meta.artists?.map((name) => name.trim()).filter(Boolean);
  return [...new Set(structured?.length ? structured : meta.artist?.trim() ? [meta.artist.trim()] : [])];
}

export function artistDestination(meta: MusicMetadata, name: string): string {
  // Only a unique catalog match is safe; never guess between homonyms.
  const matches = (state.catalog?.artists ?? []).filter((artist) => artistKey(artist.name) === artistKey(name));
  const primary = artistKey(name) === artistKey(meta.artist);
  return artistPath(name, { view: meta.view,
    artistId: (primary ? meta.artistId : undefined) ?? (matches.length === 1 ? matches[0].id : undefined),
    deezerId: primary ? meta.deezerArtistId : undefined });
}

export function albumDestination(meta: MusicMetadata): string {
  return albumPath(meta.album ?? '', meta.albumArtist || meta.artist || '', {
    view: meta.view, albumId: meta.albumId, deezerId: meta.deezerAlbumId,
  });
}

export function catalogDestination(item: CatalogItem): string | undefined {
  const music = catalogMusic(item);
  if (item.type === 'artist') return artistDestination({ ...music, artist: item.title }, item.title);
  if (item.type === 'album') return albumDestination(music);
  return undefined;
}
