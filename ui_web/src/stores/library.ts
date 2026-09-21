/**
 * Fetching the library and keeping the fetches from piling up.
 *
 * Changed snapshots replace `state.library`; unchanged revisions leave it intact.
 * Replacing the array rebuilds the identity index and every derived list. That is fine once;
 * it is not fine once per finished download.
 */

import { api } from '../lib/api';
import { registerArtworkMetadata } from '../lib/media';
import { invalidateCatalogSync, syncCatalog } from './catalog';
import { setState, state } from './core';

interface SyncFlight { pending: boolean; promise: Promise<void> }
let inFlight: SyncFlight | undefined;
let version = 0;
let revision: string | undefined;
let catalogRevision: string | undefined;
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
  revision = undefined;
  catalogRevision = undefined;
  // A different account/storage must not wait behind the abandoned request.
  inFlight = undefined;
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = undefined;
  // The catalog is a projection of the same manifest, so a reply that is wrong
  // for one is wrong for the other.
  invalidateCatalogSync();
}

export function syncLibrary(): Promise<void> {
  if (inFlight) {
    inFlight.pending = true;
    return inFlight.promise;
  }
  const flight: SyncFlight = { pending: false, promise: Promise.resolve() };
  inFlight = flight;
  // Defer execution until the shared promise is assigned, including reentrant
  // callers triggered by a state update. All callers await the queued refresh.
  flight.promise = Promise.resolve().then(async () => {
    try {
      do {
        if (inFlight !== flight) return;
        flight.pending = false;
        await syncOnce();
      } while (inFlight === flight && flight.pending);
    } finally {
      if (inFlight === flight) inFlight = undefined;
    }
  });
  return flight.promise;
}

async function syncOnce(): Promise<void> {
  const syncVersion = ++version;
  setState('loading', true);
  try {
    const [lib, saved] = await Promise.all([
      api.getLibrary(revision),
      api.getSaved().catch(() => state.saved.slice()),
    ]);
    if (syncVersion !== version) return;
    if (lib !== null) {
      // Only an accepted snapshot may update artwork metadata or its validator.
      registerArtworkMetadata(lib.tracks ?? []);
      setState({
        library: lib.tracks ?? [],
        playlists: lib.playlists ?? {},
        librarySettings: lib.settings ?? {},
        podcastSubscriptions: lib.podcast_subscriptions ?? [],
      });
      revision = lib.revision;
    }
    setState({ saved, libraryError: false });
    // Retry failed projection fetches even when the manifest is unchanged.
    // Older engines without validators keep the previous full-refresh behavior.
    if (!revision || catalogRevision !== revision) {
      const targetRevision = revision;
      void syncCatalog().then(success => {
        if (success && syncVersion === version) catalogRevision = targetRevision;
      });
    }
  } catch {
    // Preserve the last accepted snapshot and validator on transient failures.
    if (syncVersion === version) setState('libraryError', true);
  } finally {
    if (syncVersion === version) {
      setState('loading', false);
      setState('libraryReady', true);
    }
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
