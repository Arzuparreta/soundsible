import type { Track, LibrarySettings } from '../types/music';

/**
 * Cover track id for a playlist: the user-preferred cover if set and present,
 * else the first track that exists in the library. Ports the legacy
 * resolvePlaylistCoverTrack logic. `byId` is a prebuilt library index.
 */
export function pickPlaylistCoverId(
  name: string,
  trackIds: string[],
  byId: Map<string, Track>,
  settings: LibrarySettings,
): string | null {
  if (!trackIds.length || byId.size === 0) return null;
  const pref = settings.playlist_covers?.[name];
  if (pref && byId.has(pref) && trackIds.includes(pref)) return pref;
  for (const id of trackIds) if (byId.has(id)) return id;
  return null;
}
