import { createSignal } from 'solid-js';
import { request } from './api';
import type { DiscoveryFeedItem, DiscoveryFeedSection, DiscoveryMusicFeed } from './api';
import type { PodcastSearchResult } from '../types/podcast';

/**
 * Discover data layer with stale-while-revalidate caching. The legacy Discover
 * blocked ~15s on network every visit; here each rail renders instantly from a
 * localStorage cache, then revalidates in the background. The app also prefetches
 * on boot (see initStore) so the first visit is already warm.
 */

export interface DiscoverMusicItem {
  id: string;
  track_id: string;
  title: string;
  artist: string;
  album?: string;
  cover?: string;
  duration?: number;
}

export interface DiscoverSection {
  id: string;
  title: string;
  reason?: string;
  items: DiscoverMusicItem[];
}

export interface RecentlySavedItem {
  track_id: string;
  title: string;
  artist: string;
  in_library: boolean;
  youtube_id?: string;
  cover?: string;
}

const [musicSections, setMusicSections] = createSignal<DiscoverSection[]>([]);
const [recentSaved, setRecentSaved] = createSignal<RecentlySavedItem[]>([]);
const [topPodcasts, setTopPodcasts] = createSignal<PodcastSearchResult[]>([]);
const [feedItems, setFeedItems] = createSignal<DiscoveryFeedItem[]>([]);
const [feedSections, setFeedSections] = createSignal<DiscoveryFeedSection[]>([]);
const [revalidating, setRevalidating] = createSignal(false);

export { musicSections, recentSaved, topPodcasts, feedItems, feedSections, revalidating };

const TTL_MS = 60_000; // background revalidate when cache is older than this
const KEY = {
  feedItems: 'discover:feed:items',
  feedSections: 'discover:feed:sections',
  music: 'discover:music',
  recent: 'discover:recent',
  podcasts: 'discover:podcasts',
  ts: 'discover:ts',
} as const;

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, data: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* storage full / disabled */
  }
}

let hydrated = false;
/** Populate signals from localStorage (instant, synchronous). */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const m = readCache<DiscoverSection[]>(KEY.music);
  const r = readCache<RecentlySavedItem[]>(KEY.recent);
  const p = readCache<PodcastSearchResult[]>(KEY.podcasts);
  const fi = readCache<DiscoveryFeedItem[]>(KEY.feedItems);
  const fs = readCache<DiscoveryFeedSection[]>(KEY.feedSections);
  if (m) setMusicSections(m);
  if (r) setRecentSaved(r);
  if (p) setTopPodcasts(p);
  if (fi) setFeedItems(fi);
  if (fs) setFeedSections(fs);
}

interface RawRecItem {
  id?: string;
  track_id?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  duration?: number;
}
interface RawRecs {
  items?: RawRecItem[];
  sections?: { id?: string; title?: string; reason?: string; item_ids?: string[] }[];
}

function normalizeRecs(data: RawRecs): DiscoverSection[] {
  const byId = new Map<string, DiscoverMusicItem>();
  for (const it of data.items ?? []) {
    if (!it.id || !it.track_id) continue;
    byId.set(it.id, {
      id: it.id,
      track_id: it.track_id,
      title: it.title ?? '',
      artist: it.artist ?? '',
      album: it.album,
      cover: it.cover,
      duration: it.duration,
    });
  }
  const sections: DiscoverSection[] = [];
  for (const s of data.sections ?? []) {
    const items = (s.item_ids ?? []).map((id) => byId.get(id)).filter((x): x is DiscoverMusicItem => !!x);
    if (items.length === 0) continue;
    sections.push({ id: s.id ?? '', title: s.title ?? '', reason: s.reason, items });
  }
  return sections;
}

interface RawSaved {
  track_id?: string;
  title?: string;
  artist?: string;
  in_library?: boolean;
  youtube_id?: string;
  cover?: string;
}
interface RawPodcastRow {
  title?: string;
  author?: string;
  feed_url?: string;
  rss_url?: string;
  image_url?: string;
  itunes_collection_id?: string;
  collectionId?: number | string;
}

let inFlight: Promise<void> | null = null;
/** Fetch all three rails and update signals + cache. Deduped. */
async function revalidate(): Promise<void> {
  if (inFlight) return inFlight;
  setRevalidating(true);
  inFlight = (async () => {
    const feed = request<DiscoveryMusicFeed>('/api/discovery/music/feed?limit=36', { timeoutMs: 12000 })
      .then((d) => {
        const items = Array.isArray(d.items) ? d.items : [];
        const sections = Array.isArray(d.sections) ? d.sections : [];
        setFeedItems(items);
        setFeedSections(sections);
        writeCache(KEY.feedItems, items);
        writeCache(KEY.feedSections, sections);
      })
      .catch(() => {});
    const music = request<RawRecs>('/api/discovery/music/recommendations?limit=24', { timeoutMs: 15000 })
      .then((d) => {
        const secs = normalizeRecs(d);
        setMusicSections(secs);
        writeCache(KEY.music, secs);
      })
      .catch(() => {});
    const recent = request<{ items?: RawSaved[] }>('/api/discovery/music/recently-saved?limit=12')
      .then((d) => {
        const items: RecentlySavedItem[] = (d.items ?? [])
          .filter((x) => x.track_id)
          .map((x) => ({
            track_id: x.track_id!,
            title: x.title ?? '',
            artist: x.artist ?? '',
            in_library: !!x.in_library,
            youtube_id: x.youtube_id || undefined,
            cover: x.cover || undefined,
          }));
        setRecentSaved(items);
        writeCache(KEY.recent, items);
      })
      .catch(() => {});
    const podcasts = request<{ results?: RawPodcastRow[] }>('/api/discovery/podcasts/top?limit=20', { timeoutMs: 20000 })
      .then((d) => {
        const rows: PodcastSearchResult[] = (d.results ?? [])
          .map((r) => ({
            title: r.title ?? '',
            author: r.author,
            feed_url: r.feed_url ?? r.rss_url ?? '',
            image_url: r.image_url,
            itunes_collection_id:
              r.itunes_collection_id ?? (r.collectionId != null ? String(r.collectionId) : undefined),
          }))
          .filter((r) => r.feed_url);
        setTopPodcasts(rows);
        writeCache(KEY.podcasts, rows);
      })
      .catch(() => {});
    await Promise.all([feed, music, recent, podcasts]);
    writeCache(KEY.ts, Date.now());
  })().finally(() => {
    inFlight = null;
    setRevalidating(false);
  });
  return inFlight;
}

/**
 * Ensure Discover data is available: hydrate from cache instantly, then
 * revalidate in the background if the cache is empty or stale. Safe to call on
 * every mount and once at boot.
 */
export function ensureDiscover(): void {
  hydrate();
  const ts = readCache<number>(KEY.ts) ?? 0;
  const stale = Date.now() - ts > TTL_MS;
  const empty = feedSections().length === 0 && musicSections().length === 0 && recentSaved().length === 0 && topPodcasts().length === 0;
  if (stale || empty) void revalidate();
}

/** Force a refresh (e.g. pull-to-refresh / after saving tracks). */
export function refreshDiscover(): void {
  void revalidate();
}
