/**
 * Fetching the library and keeping the fetches from piling up.
 *
 * The initial snapshot is paged. Later refreshes apply a revision delta and
 * leave the track collection untouched for playlist-only changes.
 */

import { api } from '../lib/api';
import { mergeLibraryPage, readLibraryChanges, type LibraryCursor } from '../lib/librarySync';
import { invalidateCatalogSync, syncCatalog } from './catalog';
import { setState, state } from './core';

let inFlight: Promise<void> | null = null;
let aborter: AbortController | null = null;
let cursor: LibraryCursor | null = null;
const positions = new Map<string, number>();
let pending = false;
let version = 0;
let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Delay before a background refresh actually fires.
 *
 * Downloads finish one per track, so an album used to trigger a burst of full
 * refetches on the same device that is decoding audio. Bursts collapse into one
 * refresh; anything the user asked for directly still awaits `syncLibrary()`
 * and stays immediate.
 */
const COALESCE_MS = 1500;

/**
 * Abandon whatever sync is in flight.
 *
 * Its response describes the account or storage that was current when it was
 * issued, so after a switch it is not late — it is wrong.
 */
export function invalidateLibrarySync(): void {
  version += 1;
  cursor = null;
  aborter?.abort();
  // The catalog is a projection of the same manifest, so a reply that is wrong
  // for one is wrong for the other.
  invalidateCatalogSync();
}

export function syncLibrary(): Promise<void> {
  pending = true;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    while (pending) {
      pending = false;
      await syncOnce();
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

async function syncOnce(): Promise<void> {
  const syncVersion = ++version;
  aborter = new AbortController();
  setState('loading', true);
  try {
    const [lib, saved] = await Promise.all([
      readLibraryChanges(api.getLibrary, cursor, aborter.signal),
      api.getSaved().catch(() => state.saved.slice()),
    ]);
    if (syncVersion !== version) return;
    const tracks = mergeLibraryPage(state.library, lib, positions);
    if (tracks !== state.library) setState('library', tracks);
    setState({
      playlists: lib.playlists ?? {},
      librarySettings: lib.settings ?? {},
      podcastSubscriptions: lib.podcast_subscriptions ?? [],
      saved,
      libraryError: false,
    });
    cursor = lib.epoch != null && lib.revision != null ? { epoch: lib.epoch, revision: lib.revision } : null;
    if (tracks !== state.library || lib.mode !== 'delta' || lib.tracks?.length || lib.removed?.length) void syncCatalog();
  } catch {
    if (syncVersion === version) setState('libraryError', true);
  } finally {
    if (syncVersion === version) {
      setState('loading', false);
      setState('libraryReady', true);
    }
    aborter = null;
  }
}

/** Release pending work on account changes or application teardown. */
export function disposeLibrarySync(): void {
  invalidateLibrarySync();
  pending = false;
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = undefined;
}

/**
 * Ask for a library refresh soon, collapsing a burst into one.
 *
 * For refreshes the engine prompts — a finished download, a file-watcher
 * event — where being a second late costs nothing and refetching per event
 * costs a full library payload and index rebuild each time.
 */
export function syncLibrarySoon(): void {
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = setTimeout(() => {
    coalesceTimer = undefined;
    void syncLibrary();
  }, COALESCE_MS);
}
