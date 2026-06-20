import { apiOrigin, ownerToken } from './config';
import type { Track, PlaylistMap, LibrarySettings, SearchResult } from '../types/music';
import type { PodcastSubscription, PodcastEpisode, PodcastSearchResult } from '../types/podcast';
import type { DownloadQueueItem } from '../types/download';

export interface DownloadItem {
  source_type: string;
  song_str: string;
  video_id: string;
  display_title?: string;
  display_artist?: string;
  thumbnail_url?: string;
  duration_sec?: number;
  metadata_evidence?: null;
}

interface RawResult {
  id?: string;
  videoId?: string;
  video_id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  artist?: string;
  duration?: number;
  thumbnail?: string;
}

function normalizeResult(r: RawResult): SearchResult {
  return {
    id: r.id ?? r.videoId ?? r.video_id ?? '',
    title: r.title ?? '',
    channel: r.channel ?? r.uploader ?? r.artist,
    duration: typeof r.duration === 'number' ? r.duration : undefined,
    thumbnail: r.thumbnail,
  };
}

interface RawPodcastRow {
  title?: string;
  author?: string;
  feed_url?: string;
  feedUrl?: string;
  rss_url?: string;
  image_url?: string;
  artworkUrl600?: string;
  itunes_collection_id?: string;
  collectionId?: number | string;
}

function normalizePodcastRow(r: RawPodcastRow): PodcastSearchResult {
  return {
    title: r.title ?? '',
    author: r.author,
    feed_url: r.feed_url ?? r.feedUrl ?? r.rss_url ?? '',
    image_url: r.image_url ?? r.artworkUrl600,
    itunes_collection_id:
      r.itunes_collection_id ?? (r.collectionId != null ? String(r.collectionId) : undefined),
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface DeviceRegistration {
  device_id: string;
  device_name: string;
  device_type: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Typed fetch wrapper over the engine REST contract. Reuses the timeout/abort
 * pattern from the legacy http.js, adds JSON + owner-token handling. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 8000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = ownerToken();
  if (token) headers['X-Soundsible-Admin-Token'] = token;

  try {
    const res = await fetch(`${apiOrigin()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal ?? controller.signal,
    });
    if (!res.ok) throw new ApiError(res.status, `${method} ${path} → ${res.status}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Endpoint methods over the engine REST contract. */
export const api = {
  health: () => request<{ status?: string }>('/api/health'),
  registerDevice: (d: DeviceRegistration) =>
    request<void>('/api/devices/register', { method: 'POST', body: d }),

  getLibrary: () =>
    request<{
      tracks?: Track[];
      playlists?: PlaylistMap;
      settings?: LibrarySettings;
      podcast_subscriptions?: PodcastSubscription[];
    }>(`/api/library?t=${Date.now()}`),
  /** Returns the list of favourite track ids. */
  getFavourites: () => request<string[]>(`/api/library/favourites?t=${Date.now()}`),
  toggleFavourite: (id: string) =>
    request<{ is_fav?: boolean }>('/api/library/favourites/toggle', {
      method: 'POST',
      body: { track_id: id },
    }),
  /** Trigger a server-side rescan of the library files. */
  rescanLibrary: () =>
    request<{ status?: string }>('/api/library/sync', { method: 'POST', timeoutMs: 60000 }),

  /** Discover: YouTube Music search. Accepts an AbortSignal for cancellation. */
  searchYouTube: async (q: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    const data = await request<{ results?: RawResult[] }>(
      `/api/downloader/youtube/search?q=${encodeURIComponent(q)}&source=ytmusic&limit=20`,
      { signal, timeoutMs: 15000 },
    );
    return (data.results ?? []).map(normalizeResult).filter((r) => r.id);
  },
  /** Discover radio: related/mix tracks for a seed video id. */
  relatedYouTube: async (id: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    const data = await request<{ results?: RawResult[] }>(
      `/api/downloader/youtube/related?id=${encodeURIComponent(id)}&limit=25`,
      { signal, timeoutMs: 15000 },
    );
    return (data.results ?? []).map(normalizeResult).filter((r) => r.id);
  },
  /** Enqueue downloads (add to library). */
  enqueueDownload: (items: DownloadItem[]) =>
    request<{ status?: string; ids?: string[]; rejected?: unknown[] }>('/api/downloader/queue', {
      method: 'POST',
      body: { items },
      timeoutMs: 15000,
    }),

  // ── Podcasts ──
  getPodcastEpisodes: (feedId: string) =>
    request<{ feed_id?: string; subscription?: PodcastSubscription; episodes?: PodcastEpisode[] }>(
      `/api/podcasts/feeds/${encodeURIComponent(feedId)}/episodes`,
      { timeoutMs: 20000 },
    ),
  searchPodcasts: async (q: string, signal?: AbortSignal): Promise<PodcastSearchResult[]> => {
    const data = await request<{ results?: RawPodcastRow[] }>(
      `/api/discovery/podcasts/search?q=${encodeURIComponent(q)}&limit=20`,
      { signal, timeoutMs: 20000 },
    );
    return (data.results ?? []).map(normalizePodcastRow).filter((r) => r.feed_url);
  },
  subscribePodcast: (body: {
    rss_url: string;
    title?: string;
    author?: string;
    image_url?: string;
    itunes_collection_id?: string;
  }) =>
    request<{ status?: string; subscription?: PodcastSubscription }>('/api/podcasts/subscribe', {
      method: 'POST',
      body,
      timeoutMs: 30000,
    }),
  unsubscribePodcast: (id: string) =>
    request<{ status?: string }>(`/api/podcasts/subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** Mint a short-lived stream token for an episode enclosure URL. */
  podcastPeek: (enclosureUrl: string) =>
    request<{ stream_token?: string }>('/api/podcasts/enclosure/peek', {
      method: 'POST',
      body: { enclosure_url: enclosureUrl },
      timeoutMs: 20000,
    }),

  // ── Download queue ──
  /** Current download queue + processing flag (seed for the live store slice). */
  getDownloadQueue: () =>
    request<{ is_processing?: boolean; queue?: DownloadQueueItem[]; logs?: string[] }>(
      '/api/downloader/queue/status',
    ),
  /** Reset a failed item back to pending so the pump re-processes it. */
  retryDownload: (id: string) =>
    request<{ status?: string; item?: DownloadQueueItem }>(
      `/api/downloader/queue/${encodeURIComponent(id)}/retry`,
      { method: 'POST' },
    ),
  /** Remove a single item from the queue. */
  removeDownload: (id: string) =>
    request<{ status?: string }>(`/api/downloader/queue/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** Clear every non-downloading item from the queue. */
  clearDownloads: () =>
    request<{ status?: string }>('/api/downloader/queue', { method: 'DELETE' }),
  /** Clear only failed/interrupted items. */
  clearFailedDownloads: () =>
    request<{ status?: string; removed?: number }>('/api/downloader/queue/failed', {
      method: 'DELETE',
    }),
};
