import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import type { PodcastSearchResult, PodcastShowInfo, PodcastSubscription } from '../types/podcast';
import { request } from './http';
import { filterLocalCollection, normalizeLibraryQuery, podcastShowSearchFields } from './librarySearch';
import { podcastRecommendations, type RawPodcastRow } from './podcastRecommendations';

export function podcastShowInfo(row: PodcastSearchResult): PodcastShowInfo {
  return { title: row.title, author: row.author, rss_url: row.feed_url, image_url: row.image_url, itunes_collection_id: row.itunes_collection_id };
}

type PodcastMatch = { show: PodcastSearchResult; subscription?: PodcastSubscription };

function subscriptionMatch(subscription: PodcastSubscription) {
  const show: PodcastSearchResult = {
    title: subscription.title, author: subscription.author, feed_url: subscription.rss_url,
    image_url: subscription.image_url ?? undefined, itunes_collection_id: subscription.itunes_collection_id ?? undefined,
  };
  return { show, subscription };
}

function mergePodcastSearch(subscriptions: ReturnType<typeof subscriptionMatch>[], directory: PodcastSearchResult[], query: string) {
  const byFeed = new Map(subscriptions.map(row => [row.show.feed_url, row]));
  const byCollection = new Map(subscriptions.filter(row => row.show.itunes_collection_id).map(row => [row.show.itunes_collection_id, row]));
  const rows: PodcastMatch[] = [];
  const seenFeeds = new Set<string>();
  const seenCollections = new Set<string>();
  const append = (row: PodcastMatch) => {
    const collection = row.show.itunes_collection_id;
    if (seenFeeds.has(row.show.feed_url) || (collection && seenCollections.has(collection))) return;
    seenFeeds.add(row.show.feed_url);
    if (collection) seenCollections.add(collection);
    rows.push(row);
  };
  for (const row of filterLocalCollection(subscriptions, normalizeLibraryQuery(query), row => podcastShowSearchFields(row.show))) {
    append(row);
  }
  for (const show of directory) {
    const subscribed = byFeed.get(show.feed_url) ?? (show.itunes_collection_id ? byCollection.get(show.itunes_collection_id) : undefined);
    append(subscribed ?? { show });
  }
  return rows;
}

/** Local subscriptions are available even while the directory is loading or unavailable. */
export function createPodcastSearch(options: {
  query: Accessor<string>;
  subscriptions: Accessor<PodcastSubscription[]>;
  country: Accessor<string | null | undefined>;
  account: Accessor<string | number | undefined>;
  disconnected?: Accessor<boolean | undefined>;
}) {
  const term = createMemo(() => options.query().trim().slice(0, 500));
  const active = () => Boolean(term());
  const [directory, setDirectory] = createSignal<PodcastSearchResult[]>([]);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  createEffect(on(() => [term(), options.country(), options.account(), options.disconnected?.(), retry()] as const,
    ([query, country, , disconnected]) => {
      setDirectory([]);
      setError(false);
      const canSearch = Boolean(query) && !disconnected;
      setPending(canSearch);
      if (!canSearch) return;
      const controller = new AbortController();
      const params = new URLSearchParams({ q: query, limit: '20' });
      if (country) params.set('country', country);
      const timer = setTimeout(async () => {
        try {
          const response = await request<{ results?: RawPodcastRow[] }>(
            `/api/discovery/podcasts/search?${params}`, { signal: controller.signal, timeoutMs: 20000 },
          );
          if (!controller.signal.aborted) setDirectory(podcastRecommendations(response.results));
        } catch {
          if (!controller.signal.aborted) setError(true);
        } finally {
          if (!controller.signal.aborted) setPending(false);
        }
      }, 300);
      onCleanup(() => { clearTimeout(timer); controller.abort(); });
    }));
  // Keep local row identities stable when the directory finishes.
  const subscriptions = createMemo(() => options.subscriptions().map(subscriptionMatch));
  const results = createMemo(() => active() ? mergePodcastSearch(subscriptions(), directory(), term()) : []);
  return { active, results, pending, error, retry: () => setRetry(value => value + 1) };
}
