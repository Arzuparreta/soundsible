import { collectionIndex, resolveCollectionTracks } from '../lib/collectionIdentity';
import { artworkUrl } from '../lib/config';
import { coverUrl, trackCoverUrl } from '../lib/media';
import { pickPlaylistCoverTrack } from '../lib/playlists';
import type { CatalogAlbum, LibrarySettings, PlaylistMap, Track } from '../types/music';

export function buildTrackIndex(
  primary: readonly Track[],
  secondary: readonly Track[] = [],
): Map<string, Track> {
  const index = collectionIndex(secondary);
  for (const [key, track] of collectionIndex(primary)) index.set(key, track);
  return index;
}

export function resolvePlaylistTracks(
  playlistName: string,
  playlists: PlaylistMap,
  index: ReadonlyMap<string, Track>,
): Track[] {
  return resolveCollectionTracks(playlists[playlistName] ?? [], index);
}

export function playlistCoverUrl(
  playlistName: string,
  playlists: PlaylistMap,
  index: ReadonlyMap<string, Track>,
  settings: LibrarySettings,
): string | undefined {
  const ids = playlists[playlistName] ?? [];
  const track = pickPlaylistCoverTrack(playlistName, ids, index, settings);
  return track ? trackCoverUrl(track, 'thumb') : undefined;
}

export function albumCoverUrl(album: Pick<CatalogAlbum, 'cover_track_id'>): string | undefined {
  return album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined;
}

/**
 * Fallback album grouping when a station has tracks in memory before or without
 * a populated `/api/library/albums` index response.
 */
export function deriveAlbumsFromTracks(tracks: readonly Track[]): CatalogAlbum[] {
  const buckets = new Map<string, { album: CatalogAlbum; latestMs: number }>();
  for (const track of tracks) {
    const title = (track.album || '').trim();
    if (!title) continue;
    const artist = (track.album_artist || track.artist || '').trim();
    const id = track.album_id || `${artist.toLowerCase()}::${title.toLowerCase()}`;
    const ms = track.added_at ? Date.parse(track.added_at) || 0 : 0;
    const existing = buckets.get(id);
    if (existing) {
      existing.album.track_count += 1;
      existing.album.duration += Number.isFinite(track.duration) ? track.duration || 0 : 0;
      if (!existing.album.cover_track_id && track.id) {
        existing.album.cover_track_id = track.id;
      }
      if (ms > existing.latestMs) existing.latestMs = ms;
    } else {
      buckets.set(id, {
        latestMs: ms,
        album: {
          id,
          title,
          album_artist: artist,
          year: track.year ?? null,
          genre: track.genre ?? null,
          is_compilation: false,
          track_count: 1,
          duration: Number.isFinite(track.duration) ? track.duration || 0 : 0,
          cover_track_id: track.id || null,
        },
      });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => b.latestMs - a.latestMs || a.album.title.localeCompare(b.album.title))
    .map((entry) => entry.album);
}

export function matchAlbumTracks(
  album: Partial<Pick<CatalogAlbum, 'id' | 'title' | 'album_artist'>>,
  trackIds: readonly string[] | undefined,
  tracks: readonly Track[],
  fallbackLibrary: readonly Track[],
): Track[] {
  const index = buildTrackIndex(tracks, fallbackLibrary);
  if (trackIds && trackIds.length > 0) {
    const ordered = resolveCollectionTracks(trackIds, index);
    if (ordered.length > 0) return ordered;
  }
  const byId = album.id
    ? tracks.filter((t) => t.album_id && t.album_id === album.id)
    : [];
  if (byId.length > 0) return sortAlbumTracks(byId);

  const wantedTitle = (album.title || '').trim().toLowerCase();
  if (!wantedTitle) return [];
  const wantedArtist = (album.album_artist || '').trim().toLowerCase();
  const byMeta = tracks.filter((t) => {
    const tAlbum = (t.album || '').trim().toLowerCase();
    if (tAlbum !== wantedTitle) return false;
    if (!wantedArtist) return true;
    const tArtist = (t.album_artist || t.artist || '').trim().toLowerCase();
    return tArtist === wantedArtist;
  });
  return sortAlbumTracks(byMeta);
}

function sortAlbumTracks(list: Track[]): Track[] {
  return [...list].sort(
    (a, b) =>
      (a.disc_number ?? 1) - (b.disc_number ?? 1) ||
      (a.track_number ?? 9999) - (b.track_number ?? 9999),
  );
}

export function safeExternalCover(cover?: string | null): string | undefined {
  return artworkUrl(cover);
}
