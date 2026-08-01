/**
 * Short-lived results cache shared by the search surfaces.
 *
 * The Search route kept its YouTube results in a `Map` declared inside the
 * component, so the cache died with the route: search, open an artist, come
 * back, and the app re-ran a query it had answered seconds earlier. Catalog
 * results had no cache at all. Module scope outlives navigation; the TTL keeps
 * a stale answer from outliving its usefulness.
 *
 * Nothing clears this on sign-out because signing out reloads the page (see
 * `lib/session.ts`), which drops the module along with every other cache.
 */

const TTL_MS = 60_000;
/** Distinct queries kept per namespace before the oldest are dropped. */
const MAX_ENTRIES = 40;

type Entry<T> = { value: T; storedAt: number };

const buckets = new Map<string, Map<string, Entry<unknown>>>();

function bucket(namespace: string): Map<string, Entry<unknown>> {
  let existing = buckets.get(namespace);
  if (!existing) {
    existing = new Map();
    buckets.set(namespace, existing);
  }
  return existing;
}

/** A cached result for this query, or null when absent or expired. */
export function readSearchCache<T>(namespace: string, query: string): T | null {
  const entry = bucket(namespace).get(query) as Entry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    bucket(namespace).delete(query);
    return null;
  }
  return entry.value;
}

/**
 * Drop everything. Module scope outlives a test file the way it outlives a
 * navigation, so a suite that does not reset this reads the previous test's
 * answer and never calls the API it is asserting on.
 */
export function clearSearchCache(): void {
  buckets.clear();
}

export function writeSearchCache<T>(namespace: string, query: string, value: T): void {
  const store = bucket(namespace);
  // Re-insert so iteration order stays least-recently-written first.
  store.delete(query);
  store.set(query, { value, storedAt: Date.now() });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}
