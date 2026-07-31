/**
 * Fetching the library and keeping the fetches from piling up.
 *
 * Refreshing means refetching the whole thing and replacing `state.library`,
 * which rebuilds the identity index and every derived list. That is fine once;
 * it is not fine once per finished download.
 */

import { api } from '../lib/api';
import { setState, state } from './core';

let inFlight = false;
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
}

export async function syncLibrary(): Promise<void> {
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  const syncVersion = ++version;
  setState('loading', true);
  try {
    const [lib, saved] = await Promise.all([
      api.getLibrary(),
      api.getSaved().catch(() => state.saved.slice()),
    ]);
    if (syncVersion !== version) return;
    setState({
      library: lib.tracks ?? [],
      playlists: lib.playlists ?? {},
      librarySettings: lib.settings ?? {},
      podcastSubscriptions: lib.podcast_subscriptions ?? [],
      saved,
      libraryError: false,
    });
  } catch {
    // Offline or engine down — keep whatever we have, but stop claiming it is
    // the whole story. An empty list after a failed fetch is not an empty
    // library, and the view says so.
    if (syncVersion === version) setState('libraryError', true);
  } finally {
    if (syncVersion === version) {
      setState('loading', false);
      // Settled either way: success means the list is the library, failure is
      // reported through `libraryError`. Both are answers, so stop making
      // callers wait on a sync that is over.
      setState('libraryReady', true);
    }
    inFlight = false;
    const runAgain = pending;
    pending = false;
    if (runAgain) queueMicrotask(() => void syncLibrary());
  }
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
