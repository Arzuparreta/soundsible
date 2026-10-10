import { loadPodcastCountry, podcastCountry, resetPodcastCountry } from './podcastCountry';
import { createSignal } from 'solid-js';
import { request } from './api';
import type { PodcastSearchResult, PopularPodcastEpisode } from '../types/podcast';
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
const [topEpisodes, setTopEpisodes] = createSignal<PopularPodcastEpisode[]>([]);
const [chartsCountry, setChartsCountry] = createSignal<string>();
const [chartFailed, setChartFailed] = createSignal(false);
const [episodesFailed, setEpisodesFailed] = createSignal(false);
const [revalidating, setRevalidating] = createSignal(false);

export { recentSaved, topPodcasts, topEpisodes, chartsCountry, chartFailed, episodesFailed, revalidating };

const TTL_MS = 60_000;
const KEY = {
  recent: 'discover:v3:recent',
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
  if (r) setRecentSaved(r);
}

interface RawSaved {
  track_id?: string;
  title?: string;
  artist?: string;
  in_library?: boolean;
  youtube_id?: string;
  cover?: string;
}
let inFlight: Promise<void> | null = null;
let generation = 0;

/** Discovery warming belongs to the authenticated runtime too. */
export function resetDiscover(): void {
  generation++;
  hydratedFor = null;
  inFlight = null;
  setRecentSaved([]);
  setTopPodcasts([]);
  setTopEpisodes([]); setChartsCountry(undefined); setChartFailed(false); setEpisodesFailed(false);
  resetPodcastCountry();
  setRevalidating(false);
}
async function revalidate(): Promise<void> {
  if (inFlight) return inFlight;
  const epoch = ++generation;
  const account = user()?.id ?? '-';
  const current = () => epoch === generation && (user()?.id ?? '-') === account;
  setRevalidating(true);
  inFlight = (async () => {
    const recent = request<{ items?: RawSaved[] }>('/api/discovery/music/recently-saved?limit=12')
      .then((d) => {
        if (!current()) return;
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
    const podcasts = (async () => {
      try {
        await loadPodcastCountry();
        if (!current()) return;
        const country = podcastCountry()!;
        const forCountry = () => current() && podcastCountry() === country;
        setChartsCountry(country); setTopPodcasts([]); setTopEpisodes([]);
        setChartFailed(false); setEpisodesFailed(false);
        await Promise.all([
          request<{ results?: PodcastSearchResult[] }>(`/api/discovery/podcasts/top?country=${country}&limit=20`, { timeoutMs: 30000 })
            .then(d => { if (forCountry()) setTopPodcasts(d.results ?? []); })
            .catch(() => { if (forCountry()) setChartFailed(true); }),
          request<{ results?: PopularPodcastEpisode[] }>(`/api/discovery/podcasts/top-episodes?country=${country}&limit=20`, { timeoutMs: 30000 })
            .then(d => { if (forCountry()) setTopEpisodes(d.results ?? []); })
            .catch(() => { if (forCountry()) setEpisodesFailed(true); }),
        ]);
      } catch { if (current()) { setChartFailed(true); setEpisodesFailed(true); } }
    })();
    await Promise.all([recent, podcasts]);
    if (current()) writeCache(KEY.ts, Date.now());
  })().finally(() => {
    if (!current()) return;
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
  if (stale || empty || chartsCountry() !== podcastCountry()) void revalidate();
}

export function refreshDiscover(): void {
  generation++; inFlight = null;
  void revalidate();
}
