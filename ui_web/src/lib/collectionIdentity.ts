import type { Track } from '../types/music';

/** Playlist membership belongs to the musical item, never its selected audio. */
export const collectionId = (track: Track): string => track.item_id ?? track.id;

/** Stable references plus legacy source aliases for older engine snapshots. */
export function collectionIndex(tracks: readonly Track[]): Map<string, Track> {
  const index = new Map<string, Track>();
  for (const track of tracks) index.set(collectionId(track), track);
  for (const track of tracks) if (!index.has(track.id)) index.set(track.id, track);
  return index;
}
