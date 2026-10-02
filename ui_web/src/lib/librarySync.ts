import { abortable } from './lifetime';
/** Revision-fenced library pages. No page is published before the last page
 * has proved it belongs to the same snapshot. The cursor is committed with
 * the collection, so cancelled or failed reads cannot consume changes. */
import type { LibrarySettings, PlaylistMap, Track } from '../types/music';
import type { PodcastSubscription } from '../types/podcast';

export interface LibraryCursor { epoch: string; revision: number }
export interface LibraryQuery {
  epoch?: string;
  since?: number;
  revision?: number;
  cursor?: number;
  signal?: AbortSignal;
}
export interface LibraryPage {
  tracks?: Track[];
  playlists?: PlaylistMap;
  settings?: LibrarySettings;
  podcast_subscriptions?: PodcastSubscription[];
  epoch?: string;
  revision?: number;
  mode?: 'snapshot' | 'delta';
  positions?: Record<string, number>;
  removed?: string[];
  next_cursor?: number | null;
}

export function validateLibraryPage(value: unknown): LibraryPage {
  if (!value || typeof value !== 'object') throw new Error('Invalid library page');
  const page = value as LibraryPage;
  if (!Array.isArray(page.tracks) || page.tracks.some((track) => !track || typeof track.id !== 'string')
    || typeof page.epoch !== 'string' || !Number.isSafeInteger(page.revision)
    || !['snapshot', 'delta'].includes(page.mode ?? '')
    || !Array.isArray(page.removed) || page.removed.some((id) => typeof id !== 'string')
    || !page.positions || typeof page.positions !== 'object'
    || (page.next_cursor !== null && (!Number.isSafeInteger(page.next_cursor) || page.next_cursor! < 0))) {
    throw new Error('Invalid library page');
  }
  return page;
}

export async function readLibraryChanges(
  fetchPage: (query: LibraryQuery) => Promise<LibraryPage>,
  cursor: LibraryCursor | null,
  signal: AbortSignal,
): Promise<LibraryPage> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      let next = 0;
      let result: LibraryPage | undefined;
      do {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const page = await abortable(fetchPage({
          epoch: cursor?.epoch, since: cursor?.revision,
          revision: result?.revision, cursor: next, signal,
        }), signal);
        if (!result) result = { ...page, tracks: [...(page.tracks ?? [])], removed: [...(page.removed ?? [])], positions: { ...page.positions } };
        else {
          if (page.revision !== result.revision || page.epoch !== result.epoch || page.mode !== result.mode) {
            throw new Error('Library pages disagree');
          }
          result.tracks!.push(...(page.tracks ?? []));
          result.removed!.push(...(page.removed ?? []));
          Object.assign(result.positions!, page.positions);
        }
        if (page.next_cursor == null) return result;
        if (page.next_cursor <= next) throw new Error('Library cursor did not advance');
        next = page.next_cursor;
      } while (true);
    } catch (error) {
      if (attempt >= 2 || signal.aborted || (error as { status?: number }).status !== 409) throw error;
    }
  }
}

export function mergeLibraryPage(current: Track[], page: LibraryPage, positions: Map<string, number>): Track[] {
  if (page.mode !== 'delta') {
    positions.clear();
    for (const [index, track] of (page.tracks ?? []).entries()) positions.set(track.id, page.positions?.[track.id] ?? index);
    return page.tracks ?? [];
  }
  if (!page.tracks?.length && !page.removed?.length) return current;
  const tracks = new Map(current.map((track) => [track.id, track]));
  for (const id of page.removed ?? []) { tracks.delete(id); positions.delete(id); }
  for (const track of page.tracks ?? []) {
    tracks.set(track.id, track);
    positions.set(track.id, page.positions?.[track.id] ?? positions.size);
  }
  return [...tracks.values()].sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
}
