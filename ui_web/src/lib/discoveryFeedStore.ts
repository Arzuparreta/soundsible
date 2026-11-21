import { createMemo, createRoot, createSignal } from 'solid-js';
import { api, type DiscoveryBrowseSection, type DiscoveryMusicFeed } from './api';
import { prioritizeDiscoveries } from './catalogCollection';
import { onDiscoveryFeedReady } from './discoveryEvents';
import { clearSearchCache, readSearchCache, writeSearchCache } from './searchCache';
import { resolveDiscoveryTrackShelves, type DiscoveryTrackShelf } from './searchDiscovery';
import { userKey } from './session';
import type { CatalogItem } from '../types/music';

const CACHE = 'search-discovery';
const REVALIDATE_FALLBACK_MS = 15_000;
const MAX_REVALIDATE_ATTEMPTS = 4;
const EXPLORE_MAX_ITEMS = 24;

const [feed, setFeed] = createSignal<DiscoveryMusicFeed>({});
const [loading, setLoading] = createSignal(true);
const [refreshing, setRefreshing] = createSignal(false);
const [error, setError] = createSignal(false);
const [dismissed, setDismissed] = createSignal<Set<string>>(new Set());

let activeKey = '';
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
let epoch = 0;
let inflight: Promise<void> | undefined;
let inflightRefresh = false;
let listeningPush = false;
let activeConsumers = 0;
let hasRetainedConsumer = false;

function attachPushListener(): void {
  if (listeningPush) return;
  listeningPush = true;
  onDiscoveryFeedReady(() => {
    if (hasRetainedConsumer && activeConsumers === 0) {
      clearSearchCache(CACHE);
      return;
    }
    if (!activeKey) return;
    if (feed().revalidating || refreshing() || !Object.keys(feed()).length) {
      clearTimeout(timer);
      void load(false, true);
    }
  });
}

function hydrateFromCache(): DiscoveryMusicFeed | null {
  const key = userKey('home');
  const cached = readSearchCache<DiscoveryMusicFeed>(CACHE, key);
  if (key !== activeKey) {
    activeKey = key;
    controller?.abort();
    clearTimeout(timer);
    timer = undefined;
    inflight = undefined;
    inflightRefresh = false;
    attempts = 0;
    epoch += 1;
    setDismissed(new Set<string>());
    setError(false);
    setRefreshing(false);
    setFeed(cached ?? {});
    setLoading(!cached);
    return cached;
  }
  if (cached && loading()) {
    setFeed(cached);
    setLoading(false);
  }
  return cached;
}

async function load(refresh = false, force = false): Promise<void> {
  attachPushListener();
  const key = userKey('home');
  if (key !== activeKey) hydrateFromCache();
  if (!force && inflight && (!refresh || inflightRefresh)) return inflight;

  clearTimeout(timer);
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const requestEpoch = ++epoch;
  if (refresh) setRefreshing(true);

  let task!: Promise<void>;
  task = (async () => {
    try {
      const next = await api.getDiscoveryMusicFeed(request.signal, refresh);
      if (request.signal.aborted || requestEpoch !== epoch || userKey('home') !== key) return;
      setFeed(next);
      writeSearchCache(CACHE, key, next);
      setError(!!next.browse_error || !!next.error);
      if (next.revalidating) {
        setRefreshing(true);
        if (hasRetainedConsumer && activeConsumers === 0) return;
        if (attempts++ < MAX_REVALIDATE_ATTEMPTS) {
          timer = setTimeout(() => void load(false, true), REVALIDATE_FALLBACK_MS);
        } else {
          setError(true);
          setRefreshing(false);
        }
      } else {
        setRefreshing(false);
      }
    } catch {
      if (!request.signal.aborted && requestEpoch === epoch && userKey('home') === key) {
        setError(true);
        setRefreshing(false);
      }
    } finally {
      if (inflight === task) {
        inflight = undefined;
        inflightRefresh = false;
      }
      if (!request.signal.aborted && requestEpoch === epoch && userKey('home') === key) {
        setLoading(false);
      }
    }
  })();

  inflight = task;
  inflightRefresh = refresh;
  return task;
}

export function filterDiscoveryTrackShelves(
  shelves: DiscoveryTrackShelf[],
  hidden: ReadonlySet<string>,
): DiscoveryTrackShelf[] {
  if (!hidden.size) return shelves;
  return shelves
    .map((shelf) => ({ ...shelf, items: shelf.items.filter((item) => !hidden.has(item.id)) }))
    .filter((shelf) => shelf.items.length > 0);
}

export const discoveryFeed = feed;
export const discoveryLoading = loading;
export const discoveryRefreshing = refreshing;
export const discoveryError = error;
export const discoveryDismissed = dismissed;

const { browseSections, trackShelves, exploreItems } = createRoot(() => {
  const browseSections = createMemo<DiscoveryBrowseSection[]>(() =>
    (feed().browse_sections ?? []).map((section) => ({
      ...section,
      items: prioritizeDiscoveries(section.items),
    })),
  );

  const rawTrackShelves = createMemo<DiscoveryTrackShelf[]>(() =>
    resolveDiscoveryTrackShelves(feed(), prioritizeDiscoveries),
  );

  const trackShelves = createMemo<DiscoveryTrackShelf[]>(() =>
    filterDiscoveryTrackShelves(rawTrackShelves(), dismissed()),
  );

  /**
   * Interleave track shelves round-robin for compact panels (Now Playing Explore),
   * preferring fresh external discoveries first and falling back to library shelves.
   */
  const exploreItems = createMemo<CatalogItem[]>(() => {
    const shelves = trackShelves();
    if (!shelves.length) return [];

    const roundRobin = (lists: CatalogItem[][]): CatalogItem[] => {
      const out: CatalogItem[] = [];
      const seen = new Set<string>();
      const maxLen = lists.reduce((max, list) => Math.max(max, list.length), 0);
      for (let idx = 0; idx < maxLen && out.length < EXPLORE_MAX_ITEMS; idx += 1) {
        for (const list of lists) {
          const item = list[idx];
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id);
          out.push(item);
          if (out.length >= EXPLORE_MAX_ITEMS) break;
        }
      }
      return out;
    };

    const external = roundRobin(shelves.map((shelf) => shelf.items.filter((item) => item.type !== 'library_track')));
    if (external.length >= EXPLORE_MAX_ITEMS) return external;
    if (external.length > 0) {
      const seen = new Set(external.map((item) => item.id));
      const local = roundRobin(shelves.map((shelf) => shelf.items.filter((item) => item.type === 'library_track')));
      for (const item of local) {
        if (external.length >= EXPLORE_MAX_ITEMS) break;
        if (!seen.has(item.id)) {
          seen.add(item.id);
          external.push(item);
        }
      }
      return external;
    }
    return roundRobin(shelves.map((shelf) => shelf.items));
  });

  return { browseSections, trackShelves, exploreItems };
});

export const discoveryBrowseSections = browseSections;
export const discoveryTrackShelves = trackShelves;
export const discoveryExploreItems = exploreItems;

export function retainDiscoveryFeed(): () => void {
  hasRetainedConsumer = true;
  activeConsumers += 1;
  ensureDiscoveryFeed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeConsumers = Math.max(0, activeConsumers - 1);
    if (activeConsumers === 0) {
      clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
      inflight = undefined;
      inflightRefresh = false;
    }
  };
}

export function ensureDiscoveryFeed(): void {
  attachPushListener();
  const cached = hydrateFromCache();
  if (!cached || cached.revalidating || cached.browse_error) {
    void load(false);
  }
}

export function refreshDiscoveryFeed(options?: { resetLoading?: boolean }): void {
  attachPushListener();
  const key = userKey('home');
  if (key !== activeKey) hydrateFromCache();
  attempts = 0;
  setDismissed(new Set<string>());
  setError(false);
  if (options?.resetLoading) setLoading(true);
  void load(true, true);
}

export function dismissDiscoveryItem(id: string): void {
  setDismissed((prev) => {
    const next = new Set(prev);
    next.add(id);
    return next;
  });
  clearSearchCache(CACHE);
}

export function restoreDiscoveryItem(id: string): void {
  setDismissed((prev) => {
    if (!prev.has(id)) return prev;
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
}

export function resetDiscoveryFeed(): void {
  epoch += 1;
  controller?.abort();
  controller = undefined;
  clearTimeout(timer);
  timer = undefined;
  inflight = undefined;
  inflightRefresh = false;
  activeKey = '';
  attempts = 0;
  activeConsumers = 0;
  hasRetainedConsumer = false;
  clearSearchCache(CACHE);
  setDismissed(new Set<string>());
  setError(false);
  setRefreshing(false);
  setFeed({});
  setLoading(true);
}
