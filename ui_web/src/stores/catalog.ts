/**
 * Fetching the library's structure — records, credits, genres, years.
 *
 * The engine owns the rules that turn a pile of tracks into a catalog: which
 * release a track belongs to, who performs on it, when a record came out
 * (`shared/library_catalog.py`). Deriving any of that in the browser means
 * writing those rules a second time, in a second language, where they drift.
 * So this fetches the answer instead.
 *
 * Artists, genres and years arrive together: they are three views of one
 * projection, they change at the same moment — a scan, a download, an edit —
 * and asking for them separately would mean a screen where the genre list knows
 * about a record the year list has not heard of yet.
 *
 * Albums are not here. The grid asks for them ordered and narrowed, which only
 * the engine can do across a whole library, so it owns that request and watches
 * `revision` to know when to repeat it. Holding a second, unfiltered copy here
 * would mean fetching every album twice to render one grid.
 *
 * Nothing calls this on its own schedule. It rides `syncLibrary` (see
 * `stores/library.ts`), because every write that changes the catalog changes
 * the manifest too, and one refresh path cannot desynchronise from itself.
 */

import { api } from '../lib/api';
import { setState } from './core';

let inFlight = false;
let pending = false;
let version = 0;

/** Abandon whatever fetch is in flight — after an account switch its answer
 * describes somebody else's shelf. */
export function invalidateCatalogSync(): void {
  version += 1;
}

export async function syncCatalog(): Promise<void> {
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  const syncVersion = ++version;
  setState('catalog', 'loading', true);
  try {
    const [artists, genres, years] = await Promise.all([
      api.getLibraryArtists(),
      api.getLibraryGenres(),
      api.getLibraryYears(),
    ]);
    if (syncVersion !== version) return;
    setState('catalog', (prev) => ({
      ...prev,
      artists,
      genres,
      years,
      revision: prev.revision + 1,
    }));
  } catch {
    // Keep the last good catalog on screen. A failed fetch is not news that the
    // library lost its albums, and `libraryError` already tells the user the
    // station is unreachable.
  } finally {
    if (syncVersion === version) {
      setState('catalog', { loading: false, ready: true });
    }
    inFlight = false;
    const runAgain = pending;
    pending = false;
    if (runAgain) queueMicrotask(() => void syncCatalog());
  }
}
