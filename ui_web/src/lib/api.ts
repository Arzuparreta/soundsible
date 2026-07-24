import { apiOrigin, ownerToken } from './config';
import type {
  CatalogResolveResponse,
  CatalogSaveResponse,
  CatalogSearchResponse,
  Track,
  PlaylistMap,
  LibrarySettings,
  SearchResult,
  ArtistProfile,
  AlbumProfile,
  LyricsResponse,
} from '../types/music';
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

export interface DiscoveryActionState {
  in_library?: boolean;
  saved?: boolean;
  playable?: boolean;
  downloadable?: boolean;
  needs_resolution?: boolean;
}

export interface DiscoveryFeedItem {
  id: string;
  media_type?: string;
  source?: string;
  track_id?: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  cover?: string;
  deezer_id?: string;
  rank?: number;
  reason?: string;
  reason_code?: string;
  confidence?: number;
  action_state?: DiscoveryActionState;
  external_ids?: Record<string, string | number | boolean | null | undefined>;
}

export interface DiscoveryFeedSection {
  id: string;
  title: string;
  reason?: string;
  item_ids?: string[];
  section_type?: string;
}

export interface DiscoveryMusicFeed {
  generated_at?: number;
  cached?: boolean;
  stale?: boolean;
  needs_seed?: boolean;
  items?: DiscoveryFeedItem[];
  sections?: DiscoveryFeedSection[];
}

export interface DiscoverySaveCandidate {
  id?: string;
  video_id?: string;
  title?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  confidence?: number;
  confidence_level?: string;
}

export interface DiscoverySaveResponse {
  status?: 'queued' | 'needs_review' | 'failed' | string;
  queue_id?: string;
  video_id?: string;
  confidence?: number;
  confidence_level?: string;
  confidence_reason?: string;
  reason?: string;
  best?: DiscoverySaveCandidate;
  candidates?: DiscoverySaveCandidate[];
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

/** A device registered for playback in the current scope. */
export interface Device {
  device_id: string;
  device_name?: string;
  device_type?: string;
  last_seen_ts?: number;
  socket_active?: boolean;
}

export type RemoteCommand = 'play' | 'pause' | 'next' | 'previous' | 'seek';

/** Connect payload the engine attaches to a pairing session (QR + LAN URLs). */
export interface PairingConnect {
  claim_url?: string | null;
  player_url?: string | null;
  suggested_base_url?: string | null;
  presentable?: boolean;
  qr_text?: string;
  lan_enabled?: boolean;
}

/** Playback state shared across devices (`/api/playback/state`). */
export interface RemotePlaybackState {
  device_id?: string;
  device_name?: string;
  track_id?: string;
  track?: Track | null;
  position_sec?: number;
  is_playing?: boolean;
  /** Unix seconds the engine last stored this state. */
  updated_at?: number;
}

/** A pairing session as the owner sees it (`_session_response`). */
export interface PairingSession {
  session_id: string;
  status: 'pending' | 'claimed' | 'completed' | 'cancelled' | 'expired' | string;
  code: string;
  device_name?: string | null;
  device_type?: string | null;
  claimed_at?: string | null;
  completed_at?: string | null;
  expires_at?: string | null;
  connect?: PairingConnect;
}

/** A device that completed pairing and holds a long-lived token. */
export interface PairedDevice {
  token_id: string;
  name?: string | null;
  device_type?: string | null;
  scopes?: string[];
  created_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

/** Shape returned by every playlist mutation (`_playlist_mutation_response`). */
export interface PlaylistMutation {
  status?: string;
  playlists?: PlaylistMap;
  settings?: LibrarySettings;
}

/** One matched (or unmatched) source row from a migration preview. */
export interface MigrationMatch {
  source_index: number;
  source_title: string;
  source_artist: string;
  source_album: string;
  /** 0..1 match score; 0 when unmatched. */
  confidence: number;
  matched_track_id: string | null;
  auto_accept: boolean;
  needs_confirmation: boolean;
}

export interface MigrationStats {
  total: number;
  matched: number;
  auto_accept: number;
  needs_confirmation: number;
  unmatched: number;
  matched_ratio: number;
}

export interface MigrationPreview {
  batch_id: string;
  format: string;
  stats: MigrationStats;
  matches: MigrationMatch[];
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  keepalive?: boolean;
}

/** Notified whenever the engine answers 401 — the app shows the login screen. */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** Typed fetch wrapper over the engine REST contract. Reuses the timeout/abort
 * pattern from the legacy http.js, adds JSON + owner-token handling. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 8000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  // FormData sets its own multipart Content-Type (with boundary); JSON we set explicitly.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const token = ownerToken();
  if (token) headers['X-Soundsible-Admin-Token'] = token;

  try {
    const res = await fetch(`${apiOrigin()}${path}`, {
      method,
      headers,
      // The session lives in an HttpOnly cookie, so every call has to carry it.
      credentials: 'same-origin',
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal: opts.signal ?? controller.signal,
      keepalive: opts.keepalive,
    });
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
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
  /** Devices registered for playback in this scope (for remote control). */
  listDevices: () => request<{ devices?: Device[] }>('/api/devices'),
  /** Send a transport command to another device (it acts via Socket.IO). */
  remoteCommand: (deviceId: string, command: RemoteCommand, extra?: { track_id?: string; position_sec?: number }) =>
    request<{ status?: string }>('/api/playback/remote-command', {
      method: 'POST',
      body: { device_id: deviceId, command, ...extra },
    }),

  /** Warm previews the user is likely to play next: the engine resolves their
   * stream URLs in the background and, with `download`, also caches the audio
   * on disk. Best-effort — errors are the caller's to swallow. */
  prefetchPreviews: (videoIds: string[], download = false) =>
    request<{ status?: string; queued?: string[] }>('/api/preview/prefetch', {
      method: 'POST',
      body: { video_ids: videoIds, download },
      timeoutMs: 5000,
    }),
  /** Local-only playback latency telemetry (see docs/TELEMETRY_PRIVACY.md). */
  sendPlayTiming: (body: {
    track_id?: string;
    device_id?: string;
    phase?: string;
    segments?: Record<string, number | boolean>;
  }) => request<{ status?: string }>('/api/playback/play-timing', { method: 'POST', body, timeoutMs: 5000 }),

  // ── Cross-device playback state (for resume) ──
  /** Most recent playback state from another device (204 → none). */
  getPlaybackState: (excludeDeviceId: string) =>
    request<RemotePlaybackState | undefined>(
      `/api/playback/state?exclude_device=${encodeURIComponent(excludeDeviceId)}`,
    ),
  /** Publish this device's playback state so others can offer to resume it. */
  putPlaybackState: (body: {
    track_id: string | null;
    track: Track | null;
    position_sec: number;
    is_playing: boolean;
    device_id: string;
    device_name?: string;
    device_type?: string;
  }, opts?: { keepalive?: boolean }) =>
    request<{ status?: string }>('/api/playback/state', { method: 'PUT', body, keepalive: opts?.keepalive }),

  // ── Device pairing (owner side; admin-scoped, allowed on the trusted LAN) ──
  /** Open an auto-confirming pairing session; returns the code + QR connect payload. */
  createPairingSession: () =>
    request<PairingSession>('/api/pairing/sessions', {
      method: 'POST',
      body: { auto_confirm: true, display_active: true },
    }),
  /** Poll all sessions to track a session's status (no single-session GET exists). */
  listPairingSessions: () => request<{ sessions?: PairingSession[] }>('/api/pairing/sessions'),
  cancelPairingSession: (id: string) =>
    request<PairingSession>(`/api/pairing/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  /** Keep a session auto-confirmable while its sheet is open; close it otherwise. */
  setPairingDisplay: (id: string, active: boolean) =>
    request<PairingSession>(
      `/api/pairing/sessions/${encodeURIComponent(id)}/${active ? 'display-open' : 'display-close'}`,
      { method: 'POST', body: active ? { auto_confirm: true } : undefined },
    ),
  /** Devices that completed pairing and hold a long-lived token. */
  listPairedDevices: () => request<{ devices?: PairedDevice[] }>('/api/paired-devices'),
  revokePairedDevice: (tokenId: string) =>
    request<PairedDevice>(`/api/paired-devices/${encodeURIComponent(tokenId)}/revoke`, { method: 'POST' }),

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
  /** Delete a track from the library (and its file on disk). */
  deleteTrack: (id: string) =>
    request<{ status?: string }>(`/api/library/tracks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      timeoutMs: 15000,
    }),

  // ── Lyrics (LRCLIB via the engine; library tracks are cached server-side) ──
  getTrackLyrics: (trackId: string) =>
    request<LyricsResponse>(`/api/library/tracks/${encodeURIComponent(trackId)}/lyrics`, {
      timeoutMs: 15000,
    }),
  /** Lyrics for tracks not in the library (previews), looked up by metadata. */
  getLyricsByMetadata: (p: { artist: string; title: string; album?: string; duration?: number }) => {
    const params = new URLSearchParams({ artist: p.artist, title: p.title });
    if (p.album) params.set('album', p.album);
    if (p.duration) params.set('duration', String(Math.round(p.duration)));
    return request<LyricsResponse>(`/api/lyrics?${params.toString()}`, { timeoutMs: 15000 });
  },

  // ── Track metadata + cover (engine rewrites the file's tags) ──
  updateTrackMetadata: (
    id: string,
    meta: { title?: string; artist?: string; album?: string; album_artist?: string | null },
  ) =>
    request<{ status?: string }>(`/api/library/tracks/${encodeURIComponent(id)}/metadata`, {
      method: 'POST',
      body: meta,
      timeoutMs: 20000,
    }),
  /** Upload a cover image (multipart). */
  uploadTrackCover: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ status?: string }>(`/api/library/tracks/${encodeURIComponent(id)}/cover`, {
      method: 'POST',
      body: fd,
      timeoutMs: 30000,
    });
  },
  /** Copy the cover art from another library track. */
  copyTrackCover: (id: string, sourceTrackId: string) =>
    request<{ status?: string }>(`/api/library/tracks/${encodeURIComponent(id)}/cover/from-track`, {
      method: 'POST',
      body: { source_track_id: sourceTrackId },
      timeoutMs: 20000,
    }),
  /** Remove the cover art. */
  clearTrackCover: (id: string) =>
    request<{ status?: string }>(`/api/library/tracks/${encodeURIComponent(id)}/cover/none`, {
      method: 'POST',
      timeoutMs: 20000,
    }),

  // ── Playlists (every mutation echoes back the full playlists + settings) ──
  createPlaylist: (name: string) =>
    request<PlaylistMutation>('/api/library/playlists', { method: 'POST', body: { name } }),
  deletePlaylist: (name: string) =>
    request<PlaylistMutation>(`/api/library/playlists/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  renamePlaylist: (name: string, newName: string) =>
    request<PlaylistMutation>(`/api/library/playlists/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { name: newName },
    }),
  setPlaylistTracks: (name: string, trackIds: string[]) =>
    request<PlaylistMutation>(`/api/library/playlists/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { track_ids: trackIds },
    }),
  setPlaylistCover: (name: string, coverTrackId: string | null) =>
    request<PlaylistMutation>(`/api/library/playlists/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { cover_track_id: coverTrackId },
    }),
  reorderPlaylists: (order: string[]) =>
    request<PlaylistMutation>('/api/library/playlists', { method: 'PATCH', body: { order } }),
  addTrackToPlaylist: (name: string, trackId: string) =>
    request<PlaylistMutation>(`/api/library/playlists/${encodeURIComponent(name)}/tracks`, {
      method: 'POST',
      body: { track_id: trackId },
    }),
  removeTrackFromPlaylist: (name: string, trackId: string) =>
    request<PlaylistMutation>(
      `/api/library/playlists/${encodeURIComponent(name)}/tracks/${encodeURIComponent(trackId)}`,
      { method: 'DELETE' },
    ),

  // ── Migration (import Spotify/Apple Music exports) ──
  /** Match an exported playlist against the local library (no writes). */
  migrationPreview: (body: { format: string; text: string }) =>
    request<MigrationPreview>('/api/migration/preview', { method: 'POST', body, timeoutMs: 30000 }),
  /** Create a playlist from the confirmed (matched) library track ids. */
  migrationImportPlaylist: (body: { playlist_name: string; track_ids: string[]; batch_id?: string }) =>
    request<PlaylistMutation & { playlist_name?: string; track_count?: number }>(
      '/api/migration/import-playlist',
      { method: 'POST', body, timeoutMs: 30000 },
    ),

  /** Internet search. The first path is the fast YouTube extractor; YouTube
   * Music metadata enrichment is intentionally kept out of the blocking path. */
  searchYouTube: async (q: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    const search = async (source: 'ytmusic' | 'youtube', enrich = true) => {
      const data = await request<{ results?: RawResult[] }>(
        `/api/downloader/youtube/search?q=${encodeURIComponent(q)}&source=${source}&limit=20&enrich=${enrich ? '1' : '0'}`,
        { signal, timeoutMs: 15000 },
      );
      return (data.results ?? []).map(normalizeResult).filter((r) => r.id);
    };

    try {
      const youtubeResults = await search('youtube');
      if (youtubeResults.length > 0 || signal?.aborted) return youtubeResults;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return search('ytmusic', false);
  },
  /** Optional metadata-only YouTube Music search for background enrichment. */
  searchYouTubeMusic: async (q: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    const data = await request<{ results?: RawResult[] }>(
      `/api/downloader/youtube/search?q=${encodeURIComponent(q)}&source=ytmusic&limit=20&enrich=0`,
      { signal, timeoutMs: 8000 },
    );
    return (data.results ?? []).map(normalizeResult).filter((r) => r.id);
  },
  /** Search-as-you-type suggestions (Google suggest, ds=yt). Best-effort. */
  suggest: async (q: string, signal?: AbortSignal): Promise<string[]> => {
    const data = await request<{ suggestions?: string[] }>(
      `/api/downloader/youtube/suggest?q=${encodeURIComponent(q)}`,
      { signal, timeoutMs: 5000 },
    );
    return Array.isArray(data.suggestions) ? data.suggestions : [];
  },
  /** Discover radio: related/mix tracks for a seed video id. */
  relatedYouTube: async (id: string, signal?: AbortSignal, enrich = false): Promise<SearchResult[]> => {
    const data = await request<{ results?: RawResult[] }>(
      `/api/downloader/youtube/related?id=${encodeURIComponent(id)}&limit=25&enrich=${enrich ? 1 : 0}`,
      { signal, timeoutMs: 45000 },
    );
    return (data.results ?? []).map(normalizeResult).filter((r) => r.id);
  },
  /** Node feed: resolve seeds server-side, return cache-hit recs immediately,
   * and schedule async expansion for misses (streamed via `discover_seed_ready`
   * socket event). The server owns the persistent related-mix cache and seed
   * resolution — the client just picks seed track ids and interleaves. */
  discoverFeed: async (seeds: string[], limit: number, signal?: AbortSignal): Promise<{
    request_id: string;
    ready: Array<{ seed_track_id: string; recs: SearchResult[] }>;
    pending: string[];
  }> => {
    const data = await request<{
      request_id: string;
      ready: Array<{ seed_track_id: string; recs: RawResult[] }>;
      pending: string[];
    }>(
      `/api/discover/feed?seeds=${encodeURIComponent(seeds.join(','))}&limit=${limit}`,
      { signal, timeoutMs: 8000 },
    );
    return {
      request_id: data.request_id ?? '',
      ready: (data.ready ?? []).map((r) => ({
        seed_track_id: r.seed_track_id,
        recs: (r.recs ?? []).map(normalizeResult).filter((x) => x.id),
      })),
      pending: data.pending ?? [],
    };
  },
  /** Pre-expand seeds into the persistent server cache so future Discover opens
   * are instant. Fire-and-forget; called on library_updated. */
  warmDiscoverSeeds: (seeds: string[]) =>
    request<{ status?: string; warmed?: number }>('/api/discover/warm', {
      method: 'POST',
      body: { seeds },
      timeoutMs: 5000,
    }),
  /** Resolve a pasted YouTube URL/video id to display metadata without downloading. */
  peekYouTube: async (urlOrId: string, signal?: AbortSignal): Promise<SearchResult | null> => {
    const data = await request<{ peek?: RawResult | null }>(
      `/api/downloader/youtube/peek?url=${encodeURIComponent(urlOrId)}`,
      { signal, timeoutMs: 15000 },
    );
    const result = data.peek ? normalizeResult(data.peek) : null;
    return result?.id ? result : null;
  },
  /** Enqueue downloads (add to library). */
  enqueueDownload: (items: DownloadItem[]) =>
    request<{ status?: string; ids?: string[]; rejected?: unknown[] }>('/api/downloader/queue', {
      method: 'POST',
      body: { items },
      timeoutMs: 15000,
    }),
  getDiscoveryMusicFeed: () =>
    request<DiscoveryMusicFeed>('/api/discovery/music/feed?limit=36', { timeoutMs: 12000 }),
  saveDiscoveryTrack: (body: {
    artist: string;
    title: string;
    duration?: number;
    deezer_id?: string;
    cover?: string;
    confirm_video_id?: string;
  }) => request<DiscoverySaveResponse>('/api/discovery/save', { method: 'POST', body, timeoutMs: 30000 }),
  emitDiscoveryEvent: (event: string, payload?: Record<string, unknown>) =>
    request<{ status?: string; recorded?: boolean }>('/api/discovery/events', {
      method: 'POST',
      body: { event, payload: payload ?? {} },
      timeoutMs: 5000,
    }),
  searchCatalog: (q: string, signal?: AbortSignal, type = 'all') =>
    request<CatalogSearchResponse>(
      `/api/catalog/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&limit=36`,
      { signal, timeoutMs: 15000 },
    ),
  suggestCatalog: async (q: string, signal?: AbortSignal): Promise<string[]> => {
    const data = await request<{ suggestions?: string[] }>(
      `/api/catalog/suggest?q=${encodeURIComponent(q)}`,
      { signal, timeoutMs: 5000 },
    );
    return Array.isArray(data.suggestions) ? data.suggestions : [];
  },
  resolveCatalogItem: (body: { artist: string; title: string; duration?: number }, signal?: AbortSignal) =>
    request<CatalogResolveResponse>('/api/catalog/resolve', { method: 'POST', body, signal, timeoutMs: 30000 }),
  saveCatalogItem: (body: {
    catalog_item_id?: string;
    source?: string;
    artist: string;
    title: string;
    duration?: number;
    cover?: string;
    external_ids?: Record<string, unknown>;
    confirm_video_id?: string;
  }) => request<CatalogSaveResponse>('/api/catalog/save', { method: 'POST', body, timeoutMs: 30000 }),

  getArtistProfile: (name: string, deezerId?: string, signal?: AbortSignal) =>
    request<ArtistProfile>(
      `/api/catalog/artist?name=${encodeURIComponent(name)}` +
        (deezerId ? `&deezer_id=${encodeURIComponent(deezerId)}` : ''),
      { signal, timeoutMs: 15000 },
    ),

  getAlbumProfile: (name: string, artist: string, deezerId?: string, signal?: AbortSignal) =>
    request<AlbumProfile>(
      `/api/catalog/album?name=${encodeURIComponent(name)}` +
        `&artist=${encodeURIComponent(artist)}` +
        (deezerId ? `&deezer_id=${encodeURIComponent(deezerId)}` : ''),
      { signal, timeoutMs: 15000 },
    ),

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
  /** Enqueue a podcast episode for download (source_type podcast_enclosure). */
  enqueuePodcastEpisode: (payload: {
    enclosure_url: string;
    guid?: string;
    title?: string;
    show_title?: string;
    thumbnail_url?: string;
    duration_sec?: number;
    podcast_feed_id?: string;
    podcast_rss_url?: string;
  }) =>
    request<{ status?: string; ids?: string[] }>('/api/downloader/queue', {
      method: 'POST',
      body: { items: [{ source_type: 'podcast_enclosure', ...payload }] },
      timeoutMs: 15000,
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

  // ── Settings / system ──
  getDiscoverySettings: () => request<{ learning_enabled?: boolean }>('/api/discovery/settings'),
  setDiscoveryLearning: (enabled: boolean) =>
    request<{ learning_enabled?: boolean }>('/api/discovery/settings', {
      method: 'PATCH',
      body: { learning_enabled: enabled },
    }),
  getDownloaderConfig: () =>
    request<{ output_dir?: string; quality?: string; auto_update_ytdlp?: boolean }>('/api/downloader/config'),
  setDownloaderConfig: (cfg: { quality?: string; auto_update_ytdlp?: boolean; output_dir?: string }) =>
    request<{ status?: string }>('/api/downloader/config', { method: 'POST', body: cfg }),
  optimizeLibrary: () =>
    request<{ status?: string }>('/api/downloader/optimize', { method: 'POST', timeoutMs: 60000 }),
  cloudSync: () => request<{ status?: string }>('/api/downloader/sync', { method: 'POST', timeoutMs: 60000 }),
  wipeLibrary: () =>
    request<{ status?: string }>('/api/library/wipe', {
      method: 'POST',
      body: { confirm: 'CONFIRM' },
      timeoutMs: 30000,
    }),
  purgeMissing: () =>
    request<{ status?: string; removed?: number }>('/api/library/purge-missing', {
      method: 'POST',
      timeoutMs: 60000,
    }),
};
