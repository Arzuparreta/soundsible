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

interface CatalogFlight {
  generation: number;
  targetRevision: string | undefined;
  request: number;
  promise: Promise<boolean>;
}
let inFlight: CatalogFlight | undefined;
let generation = 0;

/** Detach old account/storage work immediately. Its requests may still finish,
 * but neither their payload nor their cleanup belongs to the new generation. */
export function invalidateCatalogSync(): void {
  generation += 1;
  inFlight = undefined;
  // Invalidation also follows playlist edits with no immediate refetch. Keep
  // the last accepted catalog available; account teardown owns clearing data.
  setState('catalog', 'loading', false);
}

/** All callers await the latest requested projection. Revisions are opaque
 * equality tokens, not ordered numbers. Without a token, another request must
 * conservatively require a follow-up if a round has already started. */
export function syncCatalog(targetRevision?: string): Promise<boolean> {
  if (inFlight) {
    if (targetRevision === undefined || targetRevision !== inFlight.targetRevision) {
      inFlight.targetRevision = targetRevision;
      inFlight.request += 1;
    }
    return inFlight.promise;
  }
  const flight: CatalogFlight = {
    generation, targetRevision, request: 0, promise: Promise.resolve(false),
  };
  inFlight = flight;
  const current = () => inFlight === flight && generation === flight.generation;
  // Assign the shared promise before any state write can trigger reentrant
  // subscribers. A synchronous invalidation also prevents the first request.
  flight.promise = Promise.resolve().then(async () => {
    try {
      if (!current()) return false;
      setState('catalog', 'loading', true);
      while (current()) {
        const requested = flight.request;
        // A quick failure must not let a new round overlap the two slower
        // requests. Wrap invocation too, so synchronous errors settle normally.
        const [artists, genres, years] = await Promise.allSettled([
          Promise.resolve().then(() => api.getLibraryArtists()),
          Promise.resolve().then(() => api.getLibraryGenres()),
          Promise.resolve().then(() => api.getLibraryYears()),
        ]);
        if (!current()) return false;
        if (requested !== flight.request) continue;
        if (artists.status !== 'fulfilled' || genres.status !== 'fulfilled' || years.status !== 'fulfilled') {
          return false;
        }
        setState('catalog', prev => ({
          ...prev,
          artists: artists.value,
          genres: genres.value,
          years: years.value,
          revision: prev.revision + 1,
        }));
        // Publishing can itself request another revision or switch accounts.
        if (!current()) return false;
        if (requested === flight.request) return true;
      }
      return false;
    } finally {
      if (current()) {
        inFlight = undefined;
        setState('catalog', { loading: false, ready: true });
      }
    }
  });
  return flight.promise;
}
