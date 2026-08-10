/**
 * Turning the catalog's track ids into playable tracks.
 *
 * `/api/library/albums/<id>` answers with ids because the store already holds
 * every track, with its favourite mark, loudness reading and download state
 * attached; a second copy of the same songs would be a second answer to a
 * question that already has one.
 *
 * The order is the engine's — disc, then track, then title — and it is kept.
 * Sorting again here would mean deciding a second time what "in order" means.
 */

import { musicLibrary } from '../stores';
import type { Track } from '../types/music';

/**
 * Resolve catalog track ids against the library, dropping what it cannot place.
 *
 * A miss is normal rather than a fault: the catalog indexes files, and a song
 * saved without downloading it has no row there — the two lists are allowed to
 * disagree at the edges, and the shorter answer is the honest one.
 *
 * Builds its index per call. Callers reach this on a navigation or a menu, not
 * on every frame, and a `Map` of the library costs less than keeping a third
 * derived index in sync with the other two.
 */
export function tracksByIds(ids: readonly string[]): Track[] {
  if (ids.length === 0) return [];
  const byId = new Map<string, Track>();
  for (const track of musicLibrary()) byId.set(track.id, track);
  const resolved: Track[] = [];
  for (const id of ids) {
    const track = byId.get(id);
    if (track) resolved.push(track);
  }
  return resolved;
}
