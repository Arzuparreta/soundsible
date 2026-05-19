/**
 * Discovery Service — Deezer metadata via Station proxy.
 * Browsers cannot call api.deezer.com (no CORS); the engine proxies allowlisted GET paths.
 */

import { store } from './store.js';
import { Haptics } from './haptics.js';
import { getApiBase } from './config.js';
import { Resolver } from './resolver.js';
import { searchService } from './search_service.js';
import { audioEngine } from './audio.js';
import { playPreview, paintOptimisticDeezerPreview, odstItemToPreviewTrack } from './preview_playback.js';
import { showLoadingToast } from './shared.js';
import * as renderers from './renderers.js';
import { bindDiscoverSurfaceQuickActionButtons } from './deezer_actions.js';

function deezerProxyUrl(endpoint) {
  const host =
    store?.state?.activeHost ||
    (typeof window !== 'undefined' ? window.location.hostname : '') ||
    'localhost';
  const slug = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${getApiBase(host)}/api/discovery/deezer/${slug}`;
}

/** First string URL from Deezer playlist/album/track-shaped objects (picture_* vs cover_*). */
function deezerCoverUrl(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj.trim();
  if (typeof obj !== 'object') return '';
  const keys = [
    'picture_xl', 'picture_big', 'picture_medium', 'picture_small', 'picture',
    'cover_xl', 'cover_big', 'cover_medium', 'cover_small', 'cover'
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function escapeCssUrlFragment(url) {
  if (typeof url !== 'string' || !url) return '';
  return url.replace(/'/g, "\\'");
}

function isYoutubeVideoId(id) {
  return typeof id === 'string' && id.length === 11 && !id.startsWith('raw-');
}

function isDeezerApiError(data) {
  return Boolean(data && typeof data === 'object' && data.error);
}

function isPlaceholderCreator(str) {
  if (typeof str !== 'string') return true;
  const s = str.trim();
  if (!s) return true;
  return /^unknown channel$/i.test(s) || /^unknown artist$/i.test(s);
}

function shuffleInPlace(arr) {
  const a = arr;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function truncateDisplay(str, max = 44) {
  const s = (str || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Human-readable reason for a personalized rail row (local listening graph → Deezer expansion).
 * @param {{ kind: string, seedTitle: string, seedArtist: string }} seed
 * @returns {{ recoExplanation: string, recoReasonCode: string }}
 */
function recoMetaForSeed(seed) {
  const title = truncateDisplay(seed.seedTitle, 42);
  const artist = truncateDisplay(seed.seedArtist, 32);
  if (seed.kind === 'recent_play') {
    return {
      recoExplanation: artist
        ? `From your recent listening — expanded from “${title}” · ${artist}.`
        : `From your recent listening — expanded from “${title}”.`,
      recoReasonCode: 'listening_graph_recent'
    };
  }
  if (seed.kind === 'favourite') {
    return {
      recoExplanation: artist
        ? `From your library — anchored on favourite “${title}” · ${artist}.`
        : `From your library — anchored on favourite “${title}”.`,
      recoReasonCode: 'listening_graph_favourite'
    };
  }
  return {
    recoExplanation: '',
    recoReasonCode: 'listening_graph_unknown'
  };
}

/** Coherent wall-clock refresh for the personalized rail (independent of taste). */
const PERSONAL_RAIL_REFRESH_MS = 5 * 60 * 1000;

/** Bump when taste inputs change so the personalized rail can rebuild. */
let _personalTasteEpoch = 0;
let _songHistRef = null;
let _favRef = null;
let _libRef = null;
let _personalRailCacheEpoch = -1;
let _personalRailCacheTimerGen = -1;
let _personalRailTimerGen = 0;
let _personalRailCacheTracks = null;
let _tasteListenerBound = false;
let _personalRailIntervalId = null;

function syncPersonalTasteEpochFromStore() {
  const s = store.state;
  if (s.songPlayHistory !== _songHistRef || s.favorites !== _favRef || s.library !== _libRef) {
    _songHistRef = s.songPlayHistory;
    _favRef = s.favorites;
    _libRef = s.library;
    _personalTasteEpoch += 1;
  }
}

function hasActiveDiscoverSearchInput() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const discoverActive =
    window.UI?.currentView === 'discover' ||
    window.DesktopUI?.currentView === 'discover';
  if (!discoverActive) return false;
  const inputIds = ['desktop-global-search-input', 'global-search-input'];
  return inputIds.some((id) => {
    const input = document.getElementById(id);
    return !!(input && (input.value || '').trim());
  });
}

function shouldRefreshDiscoverHome() {
  return (
    discoveryUI.container &&
    discoveryUI.currentView === 'home' &&
    !hasActiveDiscoverSearchInput()
  );
}

function ensurePersonalTasteStoreListener() {
  if (_tasteListenerBound) return;
  _tasteListenerBound = true;
  store.subscribe(() => {
    const epochBefore = _personalTasteEpoch;
    syncPersonalTasteEpochFromStore();
    if (_personalTasteEpoch !== epochBefore && shouldRefreshDiscoverHome()) {
      void discoveryUI.renderHome();
    }
  });
}

function ensurePersonalRailRefreshTimer() {
  if (_personalRailIntervalId != null || typeof window === 'undefined') return;
  _personalRailIntervalId = window.setInterval(() => {
    _personalRailTimerGen += 1;
    if (shouldRefreshDiscoverHome()) {
      void discoveryUI.renderHome();
    }
  }, PERSONAL_RAIL_REFRESH_MS);
}

function isChartEndpoint(endpoint) {
  const path = (endpoint || '').split('?')[0];
  return path === '/chart' || path === 'chart';
}

/** Map ODST search row → shape expected by playPreview / addPreviewToQueue. */
function odstItemFromSearchRow(row) {
  if (!row || !isYoutubeVideoId(row.id)) return null;
  const ch = typeof row.channel === 'string' ? row.channel.trim() : '';
  const art = typeof row.artist === 'string' ? row.artist.trim() : '';
  let artist = '';
  if (!isPlaceholderCreator(art)) artist = art;
  else if (!isPlaceholderCreator(ch)) artist = ch;
  return {
    id: row.id,
    video_id: row.id,
    title: row.title || 'Unknown',
    artist,
    channel: artist,
    duration: row.duration || 0,
    thumbnail: row.thumbnail || ''
  };
}

/**
 * Match a Deezer listing to the first YouTube ODST hit (same audio path as Discover search results).
 */
export async function resolveDeezerTrackToOdstItem(trackLike) {
  const artist =
    typeof trackLike.artist === 'string'
      ? trackLike.artist
      : (trackLike.artist && trackLike.artist.name) || '';
  const displayTitle = (trackLike.title || '').trim();
  const displayArtist = (artist || '').trim();
  const q = `${displayTitle} ${displayArtist}`.trim();
  if (!q) return null;
  let results;
  try {
    results = await searchService.query(q, { debounce: 0, isolated: true });
  } catch {
    return null;
  }
  if (!results || !results.length) return null;
  for (const row of results) {
    const item = odstItemFromSearchRow(row);
    if (!item) continue;
    return {
      ...item,
      title: displayTitle || item.title,
      artist: displayArtist || item.artist,
      channel: displayArtist || item.channel,
      thumbnail:
        (typeof trackLike.cover === 'string' && trackLike.cover.trim()) || item.thumbnail || ''
    };
  }
  return null;
}

class DiscoveryService {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
    this.isLoading = false;
    this.currentTracks = [];
  }

  /**
   * Fetch from Deezer API with caching
   */
  async fetchDeezer(endpoint) {
    const cacheKey = endpoint;
    const chart = isChartEndpoint(endpoint);
    const cached = !chart ? this.cache.get(cacheKey) : null;

    if (!chart && cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    try {
      const response = await fetch(deezerProxyUrl(endpoint));
      if (!response.ok) throw new Error('Deezer API error');

      const data = await response.json();

      if (isDeezerApiError(data)) {
        return null;
      }

      if (!chart) {
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now()
        });
      }

      return data;
    } catch (error) {
      console.error('Discovery fetch error:', error);
      return null;
    }
  }

  /**
   * Single chart request: top tracks + trending playlist cards (no per-playlist round trips).
   */
  async fetchDiscoverHome(chartLimit = 50, maxPlaylistCards = 12) {
    const data = await this.fetchDeezer(`/chart?limit=${chartLimit}`);
    if (!data || !data.tracks || !Array.isArray(data.tracks.data)) {
      return { topTracks: [], gridPlaylists: [] };
    }
    const topTracks = data.tracks.data.map((track) => this.normalizeTrack(track));
    const raw = (data.playlists && Array.isArray(data.playlists.data)) ? data.playlists.data : [];
    const gridPlaylists = raw.slice(0, maxPlaylistCards).map((pl) => ({
      id: pl.id,
      title: (typeof pl.title === 'string' && pl.title.trim()) || 'Playlist',
      cover: deezerCoverUrl(pl),
      trackCount: typeof pl.nb_tracks === 'number' ? pl.nb_tracks : 0
    }));
    return { topTracks, gridPlaylists };
  }

  /**
   * Fetch top tracks for quick add
   */
  async fetchTopTracks(limit = 50) {
    const { topTracks } = await this.fetchDiscoverHome(limit, 0);
    return topTracks;
  }

  /**
   * Search Deezer for tracks
   */
  async search(query, limit = 20) {
    if (!query.trim()) return [];

    const data = await this.fetchDeezer(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!data || !data.data) return [];

    return data.data.map(track => this.normalizeTrack(track));
  }

  /**
   * Personalized picks from local play history + favorites (Deezer search → artist top).
   * Explainable prototype: each row carries `recoExplanation` + `recoReasonCode` from the local
   * listening graph (recent plays + favourites), aligned with premium Phase-3 explainability.
   * @param {number} desired max tracks
   */
  async buildPersonalizedTracks(desired = 18) {
    const hist = (store.state.songPlayHistory || []).filter((h) => h && (h.title || '').trim());
    const favIds = store.state.favorites || [];
    const lib = store.state.library || [];
    const favTracks = favIds
      .map((id) => lib.find((t) => t.id === id))
      .filter((t) => t && t.media_kind !== 'podcast_episode');

    const shH = [...hist];
    const shF = [...favTracks];
    shuffleInPlace(shH);
    shuffleInPlace(shF);

    /** @type {Array<{ kind: 'recent_play' | 'favourite', seedTitle: string, seedArtist: string, q: string }>} */
    const seeds = [];
    const seenQ = new Set();
    /**
     * @param {'recent_play'|'favourite'} kind
     * @param {string} seedTitle
     * @param {string} seedArtist
     * @param {string} q
     */
    const pushSeed = (kind, seedTitle, seedArtist, q) => {
      const s = (q || '').trim();
      if (s.length < 2) return;
      const k = s.toLowerCase();
      if (seenQ.has(k)) return;
      seenQ.add(k);
      seeds.push({
        kind,
        seedTitle: (seedTitle || '').trim() || 'Unknown',
        seedArtist: (seedArtist || '').trim(),
        q: s
      });
    };

    if (shH.length && shF.length) {
      for (let i = 0; i < 3 && i < shH.length; i++) {
        const h = shH[i];
        pushSeed(
          'recent_play',
          h.title,
          (h.artist || '').trim(),
          `${h.title} ${(h.artist || '').trim()}`.trim()
        );
      }
      for (let i = 0; i < 3 && i < shF.length; i++) {
        const t = shF[i];
        pushSeed(
          'favourite',
          (t.title || '').trim(),
          (t.album_artist || t.artist || '').trim(),
          `${(t.title || '').trim()} ${(t.album_artist || t.artist || '').trim()}`.trim()
        );
      }
    } else if (shH.length) {
      for (let i = 0; i < 6 && i < shH.length; i++) {
        const h = shH[i];
        pushSeed(
          'recent_play',
          h.title,
          (h.artist || '').trim(),
          `${h.title} ${(h.artist || '').trim()}`.trim()
        );
      }
    } else if (shF.length) {
      for (let i = 0; i < 6 && i < shF.length; i++) {
        const t = shF[i];
        pushSeed(
          'favourite',
          (t.title || '').trim(),
          (t.album_artist || t.artist || '').trim(),
          `${(t.title || '').trim()} ${(t.album_artist || t.artist || '').trim()}`.trim()
        );
      }
    }

    if (!seeds.length) return [];

    const merged = [];
    const seenDeezer = new Set();
    for (const seed of seeds.slice(0, 8)) {
      const data = await this.fetchDeezer(`/search?q=${encodeURIComponent(seed.q)}&limit=5`);
      if (!data || !Array.isArray(data.data) || !data.data.length) continue;
      const first = data.data[0];
      const aid = first?.artist?.id;
      if (aid == null) continue;
      const top = await this.fetchDeezer(`/artist/${aid}/top?limit=15`);
      if (!top || !Array.isArray(top.data)) continue;

      const { recoExplanation, recoReasonCode } = recoMetaForSeed(seed);

      for (const tr of top.data) {
        const n = this.normalizeTrack(tr);
        if (seenDeezer.has(n.deezerId)) continue;
        seenDeezer.add(n.deezerId);
        merged.push({
          ...n,
          recoExplanation,
          recoReasonCode
        });
        if (merged.length >= desired) break;
      }
      if (merged.length >= desired) break;
    }
    return merged.slice(0, desired);
  }

  /**
   * Fetch similar tracks based on a seed track
   */
  async fetchSimilarTrack(trackId) {
    // Use Deezer's recommendation endpoint
    const data = await this.fetchDeezer(`/track/${trackId}`);
    if (!data) return [];

    // Get similar tracks via artist
    const artistData = await this.fetchDeezer(`/artist/${data.artist.id}/top?limit=10`);
    if (!artistData || !artistData.data) return [];

    return artistData.data
      .filter(t => t.id != trackId)
      .map(track => this.normalizeTrack(track));
  }

  /**
   * Normalize Deezer track to our format
   */
  normalizeTrack(track) {
    return {
      id: `deezer_${track.id}`,
      deezerId: track.id,
      title: track.title || 'Unknown',
      artist: track.artist?.name || 'Unknown Artist',
      album: track.album?.title || '',
      duration: track.duration || 0,
      cover: deezerCoverUrl(track.album) || this.placeholderCover,
      preview: track.preview || ''
    };
  }

  get placeholderCover() {
    return store?.placeholderCoverUrl || '';
  }

  /**
   * Clear cache (useful for testing or when user wants fresh data)
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cached tracks for instant display
   */
  getCachedTracks() {
    return this.currentTracks;
  }

  /**
   * Pre-warm cache with one chart request
   */
  async warmCache() {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      const { topTracks } = await this.fetchDiscoverHome(50, 12);
      this.currentTracks = topTracks.slice(0, 30);
    } finally {
      this.isLoading = false;
    }
  }
}

export const discoveryService = new DiscoveryService();

async function fetchLocalRecommendationTracks(limit = 12) {
  const host =
    store?.state?.activeHost ||
    (typeof window !== 'undefined' ? window.location.hostname : '') ||
    'localhost';
  try {
    const response = await fetch(`${getApiBase(host)}/api/discovery/music/recommendations?limit=${limit}`);
    if (!response.ok) return [];
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const library = store.state.library || [];
    const byId = new Map(library.map((track) => [track.id, track]));
    return items
      .map((item) => {
        const track = byId.get(item.track_id);
        if (!track || track.media_kind === 'podcast_episode') return null;
        return {
          ...track,
          recoExplanation: item.reason || '',
          recoReasonCode: item.reason_code || ''
        };
      })
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Fetch full recommendation response: items + sections + id maps. */
async function fetchLocalRecommendationData(limit = 50) {
  const host =
    store?.state?.activeHost ||
    (typeof window !== 'undefined' ? window.location.hostname : '') ||
    'localhost';
  try {
    const resp = await fetch(`${getApiBase(host)}/api/discovery/music/recommendations?limit=${limit}`);
    if (!resp.ok) return { items: [], sections: [], itemById: new Map(), trackById: new Map() };
    const data = await resp.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const sections = Array.isArray(data.sections) ? data.sections : [];
    const itemById = new Map(items.map((it) => [it.id, it]));
    const library = store.state.library || [];
    const trackById = new Map(library.map((t) => [t.id, t]));
    return { items, sections, itemById, trackById };
  } catch {
    return { items: [], sections: [], itemById: new Map(), trackById: new Map() };
  }
}

/** Map a recommendation section's item_ids to resolved library tracks. */
function _sectionToLibraryTracks(section, itemById, trackById) {
  return (section.item_ids || [])
    .map((itemId) => {
      const item = itemById.get(itemId);
      if (!item) return null;
      const track = trackById.get(item.track_id);
      if (!track || track.media_kind === 'podcast_episode') return null;
      return { ...track, recoExplanation: item.reason || '', recoReasonCode: item.reason_code || '' };
    })
    .filter(Boolean);
}

/** Fetch recently saved tracks from the discovery API. */
async function fetchRecentlySaved(limit = 12) {
  const host = store?.state?.activeHost || window.location.hostname || 'localhost';
  try {
    const resp = await fetch(`${getApiBase(host)}/api/discovery/music/recently-saved?limit=${limit}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

/** Fetch YouTube-related tracks for "Continue This Vibe" from the current playing track. */
async function fetchVibeRelated(limit = 12) {
  const currentTrack = store?.state?.currentTrack;
  if (!currentTrack) return { tracks: [], seedTitle: '' };
  const videoId = currentTrack.youtube_id || currentTrack.id?.replace?.(/^yt_/, '') || '';
  if (!videoId || videoId.length !== 11) return { tracks: [], seedTitle: '' };
  const host = store?.state?.activeHost || window.location.hostname || 'localhost';
  try {
    const resp = await fetch(`${getApiBase(host)}/api/downloader/youtube/related?id=${encodeURIComponent(videoId)}&limit=${limit}`);
    if (!resp.ok) return { tracks: [], seedTitle: '' };
    const data = await resp.json();
    const tracks = Array.isArray(data.results) ? data.results.slice(0, limit) : [];
    return { tracks, seedTitle: currentTrack.title || '' };
  } catch {
    return { tracks: [], seedTitle: '' };
  }
}

async function getPersonalizedRailTracks(desired = 18) {
  syncPersonalTasteEpochFromStore();
  const tasteOk = _personalRailCacheEpoch === _personalTasteEpoch;
  const timerOk = _personalRailCacheTimerGen === _personalRailTimerGen;
  if (tasteOk && timerOk && Array.isArray(_personalRailCacheTracks)) {
    return _personalRailCacheTracks;
  }
  const tracks = await discoveryService.buildPersonalizedTracks(desired);
  _personalRailCacheEpoch = _personalTasteEpoch;
  _personalRailCacheTimerGen = _personalRailTimerGen;
  _personalRailCacheTracks = tracks;
  return tracks;
}

/** Last-wins guard so a stale YouTube resolve cannot toast or play after a newer tap. */
let _deezerPreviewPlayGeneration = 0;

/** Exported for Deezer row download button when list context is missing. */
export async function fetchDeezerTrackLikeByNumericId(deezerId) {
  return trackLikeForDeezerId(deezerId);
}

async function trackLikeForDeezerId(deezerId) {
  const idStr = String(deezerId);
  const cached = discoveryService.getCachedTracks().find((t) => String(t.deezerId) === idStr);
  if (cached) return cached;
  const data = await discoveryService.fetchDeezer(`/track/${deezerId}`);
  if (!data || isDeezerApiError(data)) return null;
  return {
    title: data.title || 'Unknown',
    artist: typeof data.artist === 'string' ? data.artist : (data.artist?.name || ''),
    deezerId: data.id,
    duration: data.duration || 0,
    cover: deezerCoverUrl(data.album)
  };
}

/**
 * YouTube preview playback for a Deezer numeric id (used from Library-style rows / playTrack / audio next).
 * @param {string|number} deezerId
 * @param {{ surfaceList?: unknown[]|null, index?: number }} [opts] - When set, keeps list autoplay: slot `index` is patched to the resolved preview track so `currentTrack.id` matches context.
 */
export async function playDeezerTrackByNumericId(deezerId, opts = {}) {
  Haptics.tick();
  const gen = ++_deezerPreviewPlayGeneration;
  const surfaceList = Array.isArray(opts.surfaceList) ? opts.surfaceList : null;
  const index = typeof opts.index === 'number' && opts.index >= 0 ? opts.index : -1;
  if (surfaceList && surfaceList.length && index >= 0) {
    audioEngine.setContext(surfaceList.slice());
  }
  const trackLike = await trackLikeForDeezerId(deezerId);
  if (!trackLike) {
    if (gen !== _deezerPreviewPlayGeneration) return;
    window.showToast?.('Could not load track');
    return;
  }
  paintOptimisticDeezerPreview(trackLike, deezerId);
  const item = await resolveDeezerTrackToOdstItem(trackLike);
  if (gen !== _deezerPreviewPlayGeneration) return;
  if (!item) {
    window.showToast?.('No YouTube match — try search above');
    const ct = store.state.currentTrack;
    if (ct?.source === 'preview-pending' && String(ct.id) === `deezer_resolving_${deezerId}`) {
      store.update({ currentTrack: null });
    }
    return;
  }
  const synthetic = odstItemToPreviewTrack(item);
  if (!synthetic) {
    window.showToast?.('No YouTube match — try search above');
    return;
  }
  if (surfaceList && surfaceList.length && index >= 0 && index < surfaceList.length) {
    const ctx = surfaceList.slice();
    ctx[index] = synthetic;
    audioEngine.setContext(ctx);
    store.update({ currentTrack: synthetic });
    audioEngine.playTrack(synthetic);
    return;
  }
  playPreview(item);
}

export async function addDeezerTrackToQueueByNumericId(deezerId) {
  Haptics.tick();
  const loading = showLoadingToast('Resolving track...');
  const trackLike = await trackLikeForDeezerId(deezerId);
  if (!trackLike) {
    loading.dismiss();
    window.showToast?.('Could not load track');
    return;
  }
  const item = await resolveDeezerTrackToOdstItem(trackLike);
  if (!item) {
    loading.dismiss();
    window.showToast?.('No YouTube match — try search above');
    return;
  }
  const ok = await store.addPreviewToQueue(item);
  loading.dismiss();
  window.showToast?.(ok ? 'Added to queue' : 'Could not add to queue');
}

// ─── Save to Library ─────────────────────────────────────────────────────────

/**
 * Save a Deezer track-like object to the local library.
 * Calls POST /api/discovery/save; shows a resolution sheet on uncertain matches.
 *
 * @param {object} trackLike  { title, artist, duration?, cover?, deezerId? }
 * @param {HTMLElement} [anchorEl]  optional element to anchor the resolution sheet near
 * @returns {Promise<boolean>}  true if queued immediately
 */
export async function saveTrackToLibrary(trackLike, anchorEl = null) {
  Haptics.tick();
  const title = (trackLike.title || '').trim();
  const artist = (typeof trackLike.artist === 'string'
    ? trackLike.artist
    : (trackLike.artist?.name || '')).trim();
  if (!title || !artist) {
    window.showToast?.('Cannot save — missing track info');
    return false;
  }

  const loading = showLoadingToast('Saving to Library…');
  const host = store?.state?.activeHost || window.location.hostname || 'localhost';
  const base = getApiBase(host);

  let resp, data;
  try {
    resp = await fetch(`${base}/api/discovery/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        artist,
        duration: trackLike.duration || null,
        deezer_id: trackLike.deezerId != null ? String(trackLike.deezerId) : null,
        cover: trackLike.cover || null,
      }),
    });
    data = await resp.json().catch(() => ({}));
  } catch {
    loading.dismiss();
    window.showToast?.('Could not reach server');
    return false;
  }

  loading.dismiss();

  if (data.status === 'queued') {
    window.showToast?.('Saving to Library…');
    return true;
  }

  if (data.status === 'needs_review') {
    _showResolutionSheet(trackLike, data, anchorEl);
    return false;
  }

  window.showToast?.(data.reason === 'not_found'
    ? 'No match found — try searching manually'
    : 'Could not save — try again');
  return false;
}

/** Resolution sheet: shown when match confidence is medium/low. */
function _showResolutionSheet(trackLike, data, _anchorEl) {
  const existing = document.getElementById('resolution-sheet-overlay');
  if (existing) existing.remove();

  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const best = data.best || candidates[0] || null;

  function fmt(secs) {
    if (!secs) return '';
    const m = Math.floor(secs / 60);
    const s = String(Math.floor(secs % 60)).padStart(2, '0');
    return `${m}:${s}`;
  }

  function rowHtml(c, idx) {
    const thumb = c.thumbnail || `https://img.youtube.com/vi/${c.video_id}/mqdefault.jpg`;
    const dur = fmt(c.duration);
    const pct = c.confidence != null ? Math.round(c.confidence * 100) : null;
    const label = pct != null ? `${pct}% match` : '';
    return `
      <button type="button" class="resolution-candidate w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-overlay)] rounded-lg text-left transition-colors" data-idx="${idx}" data-video-id="${c.video_id || ''}">
        <img src="${thumb}" alt="" class="w-10 h-10 rounded object-cover flex-shrink-0" loading="lazy">
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-[var(--text-main)] truncate">${escHtml(c.title || c.video_id)}</div>
          <div class="text-xs text-[var(--text-dim)] truncate">${escHtml(c.channel || '')}${dur ? ' · ' + dur : ''}</div>
        </div>
        ${label ? `<span class="text-xs text-[var(--text-dim)] flex-shrink-0">${label}</span>` : ''}
      </button>`;
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  const trackTitle = (trackLike.title || '').trim();
  const trackArtist = (typeof trackLike.artist === 'string'
    ? trackLike.artist : (trackLike.artist?.name || '')).trim();

  const overlay = document.createElement('div');
  overlay.id = 'resolution-sheet-overlay';
  overlay.className = 'fixed inset-0 z-[9999] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm';
  overlay.innerHTML = `
    <div id="resolution-sheet" class="w-full max-w-md bg-[var(--surface-base)] border border-[var(--border-subtle)] rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
      <div class="px-4 pt-4 pb-2 border-b border-[var(--border-subtle)]">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="text-[var(--text-dim)] text-xs font-medium uppercase tracking-wide mb-0.5">Save to Library</div>
            <div class="font-semibold text-[var(--text-main)] truncate">${escHtml(trackTitle)}</div>
            <div class="text-sm text-[var(--text-dim)] truncate">${escHtml(trackArtist)}</div>
          </div>
          <button type="button" id="resolution-sheet-close" class="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full hover:bg-[var(--surface-overlay)] text-[var(--text-dim)]">
            <i class="fas fa-times text-sm"></i>
          </button>
        </div>
        <p class="text-xs text-[var(--text-dim)] mt-2">Uncertain match — pick the best result or cancel.</p>
      </div>
      <div class="py-2 max-h-72 overflow-y-auto">
        ${candidates.length ? candidates.map(rowHtml).join('') : '<p class="px-4 py-3 text-sm text-[var(--text-dim)]">No results found.</p>'}
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('#resolution-sheet-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.resolution-candidate').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const videoId = btn.getAttribute('data-video-id');
      if (!videoId) return;
      overlay.remove();

      const loading2 = showLoadingToast('Saving to Library…');
      const host2 = store?.state?.activeHost || window.location.hostname || 'localhost';
      try {
        const r = await fetch(`${getApiBase(host2)}/api/discovery/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: trackTitle,
            artist: trackArtist,
            duration: trackLike.duration || null,
            deezer_id: trackLike.deezerId != null ? String(trackLike.deezerId) : null,
            cover: trackLike.cover || null,
            confirm_video_id: videoId,
          }),
        });
        const d2 = await r.json().catch(() => ({}));
        loading2.dismiss();
        window.showToast?.(d2.status === 'queued' ? 'Saving to Library…' : 'Could not save');
      } catch {
        loading2.dismiss();
        window.showToast?.('Could not reach server');
      }
    });
  });
}

/** Open Deezer playlist in the same shell as native playlists (mobile + desktop). */
export async function openDeezerPlaylistById(playlistId) {
  const data = await discoveryService.fetchDeezer(`/playlist/${playlistId}`);
  if (!data || isDeezerApiError(data) || data.id == null) {
    window.showToast?.('Playlist unavailable');
    return;
  }
  const tracks = (data.tracks?.data || []).map((t) => discoveryService.normalizeTrack(t));
  let coverUrl = deezerCoverUrl(data);
  if (!coverUrl && tracks.length) {
    const t0 = data.tracks?.data?.[0];
    coverUrl = deezerCoverUrl(t0?.album) || deezerCoverUrl(t0) || '';
  }
  window._deezerPlaylistDetail = {
    deezerPlaylistId: data.id,
    title: (typeof data.title === 'string' && data.title.trim()) || 'Playlist',
    subtitle: typeof data.description === 'string' ? data.description.trim() : '',
    coverUrl,
    tracks
  };
  window._currentPlaylistTracks = tracks;
  if (typeof window.viewContext !== 'undefined') {
    window.viewContext.currentPlaylistName = null;
  }
  window._currentPlaylistName = null;
  if (window.UI?.showView) window.UI.showView('playlist-detail');
  if (window.DesktopUI?.showView) {
    window.DesktopUI.showView('playlist-detail');
    if (typeof window.renderDesktopPlaylistDetail === 'function') {
      window.renderDesktopPlaylistDetail();
    }
  }
}

/**
 * Discovery UI Management
 */
class DiscoveryUI {
  constructor() {
    this.container = null;
    this.currentView = 'home';
    this._renderGen = 0;
  }

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.renderHome();
  }

  /** Called by unifiedSearch (desktop) when it takes ownership of the discover container. */
  notifySearchActive() {
    this._renderGen++;
    this.currentView = 'search';
  }

  /** Called by unifiedSearch when search is cleared or the discover view is left. */
  notifySearchCleared() {
    this.currentView = 'home';
  }

  async renderHome() {
    const gen = ++this._renderGen;
    this.currentView = 'home';
    if (!this.container) return;
    this.container.innerHTML = '<div class="discovery-loading text-center py-10 text-[var(--text-dim)] text-sm">Loading…</div>';

    const [recoData, personalTracks, chartResult, recentlySaved, vibeResult] = await Promise.all([
      fetchLocalRecommendationData(50),
      getPersonalizedRailTracks(12),
      discoveryService.fetchDiscoverHome(30, 8),
      fetchRecentlySaved(12),
      fetchVibeRelated(12),
    ]);

    if (gen !== this._renderGen) return;

    const { sections, itemById, trackById } = recoData;
    const { topTracks, gridPlaylists } = chartResult;
    const { tracks: vibeTracks, seedTitle: vibeSeedTitle } = vibeResult;
    discoveryService.currentTracks = topTracks;

    // Resolve API sections to library tracks
    const resolved = {};
    const playlistSections = [];
    for (const sec of sections) {
      const tracks = _sectionToLibraryTracks(sec, itemById, trackById);
      if (tracks.length) {
        resolved[sec.id] = { section: sec, tracks };
        if (sec.section_type === 'from_your_playlists') {
          playlistSections.push({ section: sec, tracks });
        }
      }
    }

    // Recently saved → resolve to library tracks where possible
    const library = store.state.library || [];
    const libById = new Map(library.map((t) => [t.id, t]));
    const recentlySavedTracks = recentlySaved
      .map((ev) => {
        const track = libById.get(ev.track_id);
        if (track) return { ...track, recoExplanation: 'Recently saved to your library.', recoReasonCode: 'recently_saved' };
        return null;
      })
      .filter(Boolean);

    // "Trending, But Filtered"
    const libraryArtists = new Set(
      library.map((t) => (t.artist || '').toLowerCase().trim()).filter(Boolean)
    );
    const trendingFiltered = topTracks.filter(
      (t) => libraryArtists.has((t.artist || '').toLowerCase().trim())
    );
    const trendingShow = (trendingFiltered.length >= 3 ? trendingFiltered : topTracks).slice(0, 12);
    const trendingTitle = trendingFiltered.length >= 3 ? 'Trending, But Filtered' : 'Trending';

    window._discoverSurfaceTracks = [...(personalTracks || []), ...trendingShow];

    // Build section definitions in display order
    const sectionDefs = [];

    if (resolved['made_for_your_library']) {
      sectionDefs.push({ id: 'disc-made-for', title: 'Made for Your Library', type: 'library', data: resolved['made_for_your_library'] });
    } else {
      sectionDefs.push({ id: 'disc-made-for', title: 'Made for Your Library', type: 'library-empty' });
    }
    if (resolved['because_you_saved']) {
      sectionDefs.push({ id: 'disc-because-saved', title: resolved['because_you_saved'].section.title, type: 'library', data: resolved['because_you_saved'] });
    }
    if (resolved['rediscover']) {
      sectionDefs.push({ id: 'disc-rediscover', title: 'Rediscover', type: 'library', data: resolved['rediscover'] });
    }
    // From Your Playlists — one section per playlist
    playlistSections.forEach((ps, i) => {
      sectionDefs.push({ id: `disc-playlist-${i}`, title: ps.section.playlist_name || ps.section.title, type: 'library', data: ps });
    });
    if (recentlySavedTracks.length) {
      sectionDefs.push({ id: 'disc-recently-saved', title: 'Recently Saved', type: 'library', data: { tracks: recentlySavedTracks } });
    }
    if (vibeTracks.length) {
      const vibeTitle = vibeSeedTitle ? `Continue This Vibe — ${vibeSeedTitle}` : 'Continue This Vibe';
      sectionDefs.push({ id: 'disc-vibe', title: vibeTitle, type: 'vibe', tracks: vibeTracks });
    }
    if ((personalTracks || []).length) {
      sectionDefs.push({ id: 'disc-new-to-you', title: 'New to You', type: 'deezer', tracks: personalTracks, showReason: true });
    }
    sectionDefs.push({ id: 'disc-trending', title: trendingTitle, type: 'deezer', tracks: trendingShow });
    if (gridPlaylists.length) {
      sectionDefs.push({ id: 'disc-playlists', title: 'Popular Playlists', type: 'grid', playlists: gridPlaylists });
    }

    const _h2 = (t) => `<h2 class="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">${this.esc(t)}</h2>`;
    const _wrap = (s) => `<section class="discover-section">${_h2(s.title)}<div id="${s.id}" class="${s.type === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 content-start' : 'space-y-1'}"></div></section>`;

    this.container.innerHTML = `<div class="discovery-home space-y-8 pb-8">${sectionDefs.map(_wrap).join('')}</div>`;

    for (const s of sectionDefs) {
      const el = this.container.querySelector(`#${s.id}`);
      if (!el) continue;

      if (s.type === 'grid') {
        el.innerHTML = renderers.buildDeezerPlaylistCardsHtml(
          s.playlists.map((pl) => ({ id: pl.id, title: pl.title, cover: pl.cover, trackCount: pl.trackCount }))
        );
      } else if (s.type === 'deezer') {
        if (!s.tracks.length) {
          el.innerHTML = '<p class="text-sm text-[var(--text-dim)] py-2">Nothing here yet.</p>';
        } else {
          renderers.renderSongList(s.tracks, el, {
            getCoverUrl: (t) => (typeof t.cover === 'string' && t.cover) ? t.cover : '',
            discoverDeezerSurface: true,
            showRecoExplanation: !!s.showReason,
          });
        }
      } else if (s.type === 'vibe') {
        this._renderVibeTracks(s.tracks, el);
      } else if (s.type === 'library-empty') {
        el.innerHTML = '<p class="text-sm text-[var(--text-dim)] py-2">Save tracks, build playlists, or play favourites to unlock local picks.</p>';
      } else {
        renderers.renderSongList(s.data.tracks, el, {
          getCoverUrl: (t) => Resolver.getCoverUrl(t),
          showRecoExplanation: true,
        });
      }
    }

    this.bindEvents();
  }

  /** Render YouTube-related tracks for "Continue This Vibe" with play + save actions. */
  _renderVibeTracks(tracks, containerEl) {
    if (!containerEl || !tracks.length) return;
    const esc = (s) => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
    const fmt = (s) => { if (!s) return ''; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
    containerEl.innerHTML = tracks.map((t, i) => {
      const thumb = t.thumbnail || `https://img.youtube.com/vi/${t.id}/mqdefault.jpg`;
      const dur = fmt(t.duration);
      return `<div class="vibe-row group flex items-center gap-3 px-1 py-1.5 rounded-lg hover:bg-[var(--surface-overlay)] transition-colors cursor-pointer" data-vibe-idx="${i}">
        <div class="relative w-10 h-10 flex-shrink-0 rounded overflow-hidden">
          <img src="${esc(thumb)}" alt="" class="w-full h-full object-cover" loading="lazy">
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-[var(--text-main)] truncate">${esc(t.title)}</div>
          <div class="text-xs text-[var(--text-dim)] truncate">${esc(t.channel || '')}${dur ? ' · ' + dur : ''}</div>
        </div>
        <button type="button" class="vibe-save-btn flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full hover:bg-[var(--accent)] hover:text-[var(--text-on-accent)] text-[var(--text-dim)] transition-colors" data-vibe-idx="${i}" aria-label="Save to Library" title="Save to Library">
          <i class="fas fa-plus text-sm"></i>
        </button>
      </div>`;
    }).join('');

    containerEl.querySelectorAll('.vibe-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.vibe-save-btn')) return;
        const idx = Number(row.getAttribute('data-vibe-idx'));
        const t = tracks[idx];
        if (!t?.id) return;
        void import('./store.js').then(({ store: s }) => {
          void s.addPreviewToQueue({ source: 'ytmusic', id: t.id, title: t.title, artist: t.channel || '', thumbnail: t.thumbnail || '', duration: t.duration || 0 });
        });
      });
    });

    containerEl.querySelectorAll('.vibe-save-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-vibe-idx'));
        const t = tracks[idx];
        if (!t) return;
        const { saveTrackToLibrary } = await import('./discovery.js');
        await saveTrackToLibrary({ title: t.title, artist: t.channel || '', duration: t.duration || 0 }, btn);
      });
    });
  }

  async renderSearchResults(query) {
    const gen = ++this._renderGen;
    this.currentView = 'search';
    if (!this.container) return;
    this.container.innerHTML = '<div class="discovery-loading text-center py-10 text-[var(--text-dim)]">Searching...</div>';

    const tracks = await discoveryService.search(query);

    if (gen !== this._renderGen) return;

    discoveryService.currentTracks = tracks;

    if (tracks.length === 0) {
      this.container.innerHTML = `<div class="text-center py-10 text-[var(--text-dim)]">No results found for "${this.esc(query)}"</div>`;
      window._discoverSurfaceTracks = null;
      return;
    }
    const show = tracks.slice(0, 20);
    window._discoverSurfaceTracks = show;
    this.container.innerHTML = `
      <div class="discovery-search-results">
        <section>
          <h2 class="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">Results for "${this.esc(query)}"</h2>
          <div id="discovery-search-track-list" class="space-y-1"></div>
        </section>
      </div>`;
    const tracksEl = this.container.querySelector('#discovery-search-track-list');
    if (tracksEl) {
      renderers.renderSongList(show, tracksEl, {
        getCoverUrl: (t) => (typeof t.cover === 'string' && t.cover) ? t.cover : '',
        discoverDeezerSurface: true
      });
    }
    this.bindEvents();
  }

  esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  bindEvents() {
    if (!this.container) return;
    this.container.querySelectorAll('.deezer-playlist-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-deezer-playlist-id');
        if (id) void openDeezerPlaylistById(id);
      });
    });
    // Bind Save to Library / queue buttons on all Deezer surface sections
    for (const id of [
      'disc-new-to-you', 'disc-trending',
      'discovery-personal-tracks', 'discovery-home-top-tracks', 'discovery-search-track-list',
    ]) {
      const el = this.container.querySelector(`#${id}`);
      if (el) bindDiscoverSurfaceQuickActionButtons(el);
    }
  }
}

export const discoveryUI = new DiscoveryUI();

/**
 * Initialize discovery view
 */
export function initDiscovery(containerId) {
  ensurePersonalTasteStoreListener();
  ensurePersonalRailRefreshTimer();
  syncPersonalTasteEpochFromStore();
  discoveryUI.init(containerId);
}

/**
 * Search discovery tracks (for when user types in search bar)
 */
export async function searchDiscovery(query) {
  if (!query || !query.trim()) {
    // Show home view when search is empty
    discoveryUI.renderHome();
    return [];
  }
  return discoveryService.search(query);
}
