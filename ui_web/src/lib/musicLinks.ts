import type { CatalogItem, Track } from '../types/music';
import { albumPath, artistKey, artistPath } from './artistRoute';
import { isPodcastTrack } from './track';

/** Where a song's artist and album pages are, without any store or router: shared by web and native menus. */
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

export function trackMusic(track: Track): MusicMetadata {
  return {
    artist: track.artist, artists: track.artists, album: track.album, albumArtist: track.album_artist,
    view: track.source === 'preview' ? 'discover' : 'library',
    artistId: track.artist_id, albumId: track.album_id,
    deezerArtistId: track.deezer_artist_id, deezerAlbumId: track.deezer_album_id,
    linkable: !isPodcastTrack(track) && !track.artist_is_channel,
  };
}

export function performerNames(meta: MusicMetadata): string[] {
  const structured = meta.artists?.map((name) => name.trim()).filter(Boolean);
  return [...new Set(structured?.length ? structured : meta.artist?.trim() ? [meta.artist.trim()] : [])];
}

/** `catalogId` may name a library artist by comparison key; only the primary artist uses the track's own ids. */
export function artistDestination(meta: MusicMetadata, name: string, catalogId?: (key: string) => string | undefined): string {
  const primary = artistKey(name) === artistKey(meta.artist);
  return artistPath(name, { view: meta.view,
    artistId: (primary ? meta.artistId : undefined) ?? catalogId?.(artistKey(name)),
    deezerId: primary ? meta.deezerArtistId : undefined });
}

export function albumDestination(meta: MusicMetadata): string {
  return albumPath(meta.album ?? '', meta.albumArtist || meta.artist || '', {
    view: meta.view, albumId: meta.albumId, deezerId: meta.deezerAlbumId,
  });
}

/** One link per performer, then the record: the order and wording every song menu uses. */
export function musicLinks(meta: MusicMetadata, catalogId?: (key: string) => string | undefined):
  Array<{ kind: 'artist'; name: string; path: string; several: boolean } | { kind: 'album'; path: string }> {
  if (meta.linkable === false) return [];
  const performers = performerNames(meta);
  return [
    ...performers.map((name) => ({ kind: 'artist' as const, name, path: artistDestination(meta, name, catalogId), several: performers.length > 1 })),
    ...(meta.album?.trim() ? [{ kind: 'album' as const, path: albumDestination(meta) }] : []),
  ];
}

/** A catalog row's links; `owned` is the library track it already resolved to, if any. */
export function catalogItemMusic(item: CatalogItem, owned?: Track): MusicMetadata {
  if (owned) return { ...trackMusic(owned), view: item.type === 'library_track' ? 'library' : 'discover' };
  // An artist or album row is that entity; a song only points at its pages.
  const id = (key: string) => {
    const value = item.external_ids?.[key] ?? item.raw?.[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  };
  return {
    artist: item.artist || (item.source !== 'youtube' ? item.subtitle : '') || '',
    artists: item.raw?.artists,
    album: item.type === 'album' ? item.title : item.album,
    albumArtist: item.raw?.album_artist,
    view: item.type === 'library_track' ? 'library' : 'discover',
    deezerArtistId: id('deezer_artist_id'), deezerAlbumId: id('deezer_album_id'),
    linkable: (item.source !== 'youtube' || item.raw?.artist_is_channel === false) && !isPodcastTrack(item.raw ?? {}),
  };
}
