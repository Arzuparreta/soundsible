/**
 * Fetching the library and keeping the fetches from piling up.
 *
 * Changed snapshots replace `state.library`; unchanged revisions leave it intact.
 * Replacing the array rebuilds the identity index and every derived list. That is fine once;
 * it is not fine once per finished download.
 */

import { api } from '../lib/api';
import { batch } from 'solid-js';
import { reconcile, unwrap } from 'solid-js/store';
import { applyLibraryDelta } from '../lib/libraryDelta';
import { registerArtworkMetadata, patchArtworkMetadata } from '../lib/media';
import { invalidateCatalogSync, syncCatalog } from './catalog';
import { setState, state } from './core';

interface SyncFlight { pending: boolean; promise: Promise<void> }
let inFlight: SyncFlight | undefined;
let version = 0;
let generation = 0;
let revision: string | undefined;
let catalogRevision: string | undefined;
let catalogSync: Promise<boolean> | undefined;
let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
/** Replies that replaced library data; `endLibraryEdit` compares against it. */
let applied = 0;
/** A local edit abandoned a sync that nothing has restarted yet. */
let owed = false;

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
  generation += 1;
  catalogSync = undefined;
  revision = undefined;
  catalogRevision = undefined;
  // A different account/storage must not wait behind the abandoned request.
  inFlight = undefined;
  owed = false;
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = undefined;
  // The catalog is a projection of the same manifest, so a reply that is wrong
  // for one is wrong for the other.
  invalidateCatalogSync();
}

/**
 * A local edit changed the library under whatever sync is in flight.
 *
 * Replies fetched before it are stale, and nobody should wait behind them, so
 * the flight is abandoned as on a switch. Unlike a switch, the refreshes
 * already asked for still stand: a download that finished a second ago must
 * still appear. So the abandoned sync is owed until another one starts, and a
 * scheduled refresh still fires.
 */
function supersedeLibrarySync(): void {
  version += 1;
  generation += 1;
  catalogSync = undefined;
  revision = undefined;
  catalogRevision = undefined;
  if (inFlight) {
    inFlight = undefined;
    owed = true;
  }
  invalidateCatalogSync();
}

/** Before an optimistic edit. Pass the result to `endLibraryEdit`. */
export function beginLibraryEdit(): number {
  supersedeLibrarySync();
  return applied;
}

/**
 * After the engine answered an edit: pay an abandoned sync back. With the mark
 * from `beginLibraryEdit`, a reply applied while the request was out may have
 * predated the write and overwritten the optimistic change, so fetch again.
 */
export function endLibraryEdit(mark?: number): void {
  supersedeLibrarySync();
  if (owed || (mark !== undefined && mark !== applied)) void syncLibrary();
}

export function syncLibrary(): Promise<void> {
  if (inFlight) {
    inFlight.pending = true;
    return inFlight.promise;
  }
  const flight: SyncFlight = { pending: false, promise: Promise.resolve() };
  inFlight = flight;
  owed = false;
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
    let [lib, saved] = await Promise.all([
      api.getLibrary(revision),
      api.getSaved().catch(() => state.saved.slice()),
    ]);
    if (syncVersion !== version) return;
    if (lib !== null && 'kind' in lib && lib.kind === 'delta') {
      try {
        const next = applyLibraryDelta(unwrap(state.library), lib, revision);
        batch(() => {
          if (next.tracks !== unwrap(state.library)) setState('library', reconcile(next.tracks, { key: 'id' }));
          if ('playlists' in next.fields) setState('playlists', reconcile(next.fields.playlists ?? {}));
          if ('settings' in next.fields) setState('librarySettings', reconcile(next.fields.settings ?? {}));
          if ('podcast_subscriptions' in next.fields) setState('podcastSubscriptions', reconcile(next.fields.podcast_subscriptions ?? []));
          patchArtworkMetadata(next.upserts, next.removed);
          revision = next.revision;
        });
        applied += 1;
        lib = null;
      } catch {
        // One unconditional retry; never partially apply an invalid delta.
        lib = await api.getLibrary();
        if (syncVersion !== version) return;
        if (!lib || 'kind' in lib) throw new Error('Expected full library snapshot');
      }
    }
    if (lib !== null && !('kind' in lib)) {
      const full = lib;
      // Only an accepted snapshot may update artwork metadata or its validator.
      registerArtworkMetadata(full.tracks ?? []);
      batch(() => {
        setState('library', reconcile(full.tracks ?? [], { key: 'id' }));
        setState('playlists', reconcile(full.playlists ?? {}));
        setState('librarySettings', reconcile(full.settings ?? {}));
        setState('podcastSubscriptions', reconcile(full.podcast_subscriptions ?? []));
      });
      revision = lib.revision;
      applied += 1;
    }
    setState({ saved, libraryError: false });
    // Retry failed projection fetches even when the manifest is unchanged.
    // Older engines without validators keep the previous full-refresh behavior.
    // Even an already acknowledged revision must supersede other pending
    // work (A -> B -> A). Otherwise B could publish after the return to A.
    if (!revision || catalogRevision !== revision || catalogSync) {
      const targetRevision = revision;
      const targetGeneration = generation;
      const syncing = syncCatalog(targetRevision);
      catalogSync = syncing;
      void syncing.then(success => {
        if (catalogSync === syncing) catalogSync = undefined;
        // Another unchanged manifest refresh does not invalidate this success.
        if (success && targetGeneration === generation && targetRevision === revision) {
          catalogRevision = targetRevision;
        }
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
