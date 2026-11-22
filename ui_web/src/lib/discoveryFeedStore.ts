import { createMemo, createRoot, createSignal } from 'solid-js';
import { api, type DiscoveryBrowseSection, type DiscoveryMusicFeed } from './api';
import { prioritizeDiscoveries } from './catalogCollection';
import { itemArtist } from './catalogItem';
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
const [dismissedArtists, setDismissedArtists] = createSignal<Set<string>>(new Set());

export function foldDiscoveryArtistKey(artist: string | undefined): string {
  return (artist ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

let activeKey = '';
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
let epoch = 0;
let inflight: Promise<void> | undefined;
let inflightRefresh = false;
let listeningPush = false;
let activeConsumers = new Set<symbol>();
let hasRetainedConsumer = false;

function attachPushListener(): void {
  if (listeningPush) return;
  listeningPush = true;
  onDiscoveryFeedReady((data) => {
    clearSearchCache(CACHE);
    if (hasRetainedConsumer && activeConsumers.size === 0) {
      return;
    }
    if (!activeKey) return;
    const current = feed();
    const incomingTs = typeof data.generated_at === 'number' ? data.generated_at : undefined;
    const currentTs = typeof current.generated_at === 'number' ? current.generated_at : undefined;
    const newer = incomingTs !== undefined && (currentTs === undefined || incomingTs > currentTs);
    if (current.revalidating || refreshing() || !Object.keys(current).length || newer) {
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
    setDismissedArtists(new Set<string>());
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
        if (hasRetainedConsumer && activeConsumers.size === 0) {
          setRefreshing(false);
          return;
        }
        if (attempts++ < MAX_REVALIDATE_ATTEMPTS) {
          timer = setTimeout(() => void load(false, true), REVALIDATE_FALLBACK_MS);
        } else {
          setError(true);
          setRefreshing(false);
        }
      } else {
        attempts = 0;
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
  hiddenArtists?: ReadonlySet<string>,
): DiscoveryTrackShelf[] {
  if (!hidden.size && !hiddenArtists?.size) return shelves;
  return shelves
    .map((shelf) => ({
      ...shelf,
      items: shelf.items.filter((item) => {
        if (hidden.has(item.id)) return false;
        if (hiddenArtists?.size) {
          const artistKey = foldDiscoveryArtistKey(itemArtist(item));
          if (artistKey && hiddenArtists.has(artistKey)) return false;
        }
        return true;
      }),
    }))
    .filter((shelf) => shelf.items.length > 0);
}

export function filterDiscoveryBrowseSections(
  sections: DiscoveryBrowseSection[],
  hiddenArtists: ReadonlySet<string>,
): DiscoveryBrowseSection[] {
  if (!hiddenArtists.size) return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const artistKey = foldDiscoveryArtistKey(
          item.type === 'artist' ? (item.artist || item.title) : (item.artist || item.subtitle),
        );
        return !artistKey || !hiddenArtists.has(artistKey);
      }),
    }))
    .filter((section) => section.items.length > 0);
}

export const discoveryFeed = feed;
export const discoveryLoading = loading;
export const discoveryRefreshing = refreshing;
export const discoveryError = error;
export const discoveryDismissed = dismissed;
export const discoveryDismissedArtists = dismissedArtists;

const { browseSections, trackShelves, exploreItems } = createRoot(() => {
  const browseSections = createMemo<DiscoveryBrowseSection[]>(() =>
    filterDiscoveryBrowseSections(
      (feed().browse_sections ?? []).map((section) => ({
        ...section,
        items: prioritizeDiscoveries(section.items),
      })),
      dismissedArtists(),
    ),
  );

  const rawTrackShelves = createMemo<DiscoveryTrackShelf[]>(() =>
    resolveDiscoveryTrackShelves(feed(), prioritizeDiscoveries),
  );

  const trackShelves = createMemo<DiscoveryTrackShelf[]>(() =>
    filterDiscoveryTrackShelves(rawTrackShelves(), dismissed(), dismissedArtists()),
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
  const token = Symbol('discovery-feed-consumer');
  hasRetainedConsumer = true;
  activeConsumers.add(token);
  ensureDiscoveryFeed();
  return () => {
    if (!activeConsumers.delete(token)) return;
    if (activeConsumers.size === 0) {
      clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
      inflight = undefined;
      inflightRefresh = false;
      setRefreshing(false);
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
  clearSearchCache(CACHE);
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
  clearSearchCache(CACHE);
}

export function dismissDiscoveryArtist(artist: string): void {
  const key = foldDiscoveryArtistKey(artist);
  if (!key) return;
  setDismissedArtists((prev) => {
    const next = new Set(prev);
    next.add(key);
    return next;
  });
  clearSearchCache(CACHE);
}

export function restoreDiscoveryArtist(artist: string): void {
  const key = foldDiscoveryArtistKey(artist);
  if (!key) return;
  setDismissedArtists((prev) => {
    if (!prev.has(key)) return prev;
    const next = new Set(prev);
    next.delete(key);
    return next;
  });
  clearSearchCache(CACHE);
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
  activeConsumers.clear();
  hasRetainedConsumer = false;
  clearSearchCache(CACHE);
  setDismissed(new Set<string>());
  setError(false);
  setRefreshing(false);
  setFeed({});
  setLoading(true);
}
