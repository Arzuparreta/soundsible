import { createSignal } from 'solid-js';
import { request } from './api';
import type { PodcastSearchResult } from '../types/podcast';
import { user, userKey } from './session';

/**
 * Lightweight discovery-adjacent data: the user's recently saved tracks and
 * the top-podcasts rail. Music recommendations themselves are produced
 * client-side by the node engine (`nodeDiscover.ts`) — the old server feed of
 * fixed "More like X" rails is intentionally gone.
 */

export interface RecentlySavedItem {
  track_id: string;
  title: string;
  artist: string;
  in_library: boolean;
  youtube_id?: string;
  cover?: string;
}

const [recentSaved, setRecentSaved] = createSignal<RecentlySavedItem[]>([]);
const [topPodcasts, setTopPodcasts] = createSignal<PodcastSearchResult[]>([]);
const [revalidating, setRevalidating] = createSignal(false);

export { recentSaved, topPodcasts, revalidating };

const TTL_MS = 60_000;
const KEY = {
  recent: 'discover:v3:recent',
  podcasts: 'discover:v3:podcasts',
  ts: 'discover:v3:ts',
} as const;

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(userKey(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, data: unknown): void {
  try {
    localStorage.setItem(userKey(key), JSON.stringify(data));
  } catch {
    /* storage full / disabled */
  }
}

let hydratedFor: string | null = null;
function hydrate(): void {
  const account = user()?.id ?? '-';
  if (hydratedFor === account) return;
  hydratedFor = account;
  setRecentSaved([]);
  setTopPodcasts([]);
  const r = readCache<RecentlySavedItem[]>(KEY.recent);
  const p = readCache<PodcastSearchResult[]>(KEY.podcasts);
  if (r) setRecentSaved(r);
  if (p) setTopPodcasts(p);
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
  external_ids?: { rss_url?: string; itunes_collection_id?: string };
  recommendation_identity?: string;
  reason?: string;
  reason_code?: string;
}

let inFlight: Promise<void> | null = null;
async function revalidate(): Promise<void> {
  if (inFlight) return inFlight;
  setRevalidating(true);
  inFlight = (async () => {
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
    const podcasts = request<{ items?: RawPodcastRow[] }>('/api/discovery/podcasts/recommendations?limit=20', { timeoutMs: 20000 })
      .then((d) => {
        const rows: PodcastSearchResult[] = (d.items ?? [])
          .map((r) => ({
            title: r.title ?? '',
            author: r.author,
            feed_url: r.feed_url ?? r.rss_url ?? r.external_ids?.rss_url ?? '',
            image_url: r.image_url,
            itunes_collection_id:
              r.itunes_collection_id ??
              r.external_ids?.itunes_collection_id ??
              (r.collectionId != null ? String(r.collectionId) : undefined),
            recommendation_identity: r.recommendation_identity,
            reason: r.reason,
            reason_code: r.reason_code,
          }))
          .filter((r) => r.feed_url);
        setTopPodcasts(rows);
        writeCache(KEY.podcasts, rows);
      })
      .catch(() => {});
    await Promise.all([recent, podcasts]);
    writeCache(KEY.ts, Date.now());
  })().finally(() => {
    inFlight = null;
    setRevalidating(false);
  });
  return inFlight;
}

export function ensureDiscover(): void {
  hydrate();
  const ts = readCache<number>(KEY.ts) ?? 0;
  const stale = Date.now() - ts > TTL_MS;
  const empty = recentSaved().length === 0 && topPodcasts().length === 0;
  if (stale || empty) void revalidate();
}

export function refreshDiscover(): void {
  void revalidate();
}
