/**
 * Discovery Service — Deezer metadata via Station proxy.
 * Browsers cannot call api.deezer.com (no CORS); the engine proxies allowlisted GET paths.
 */

import { store } from './store.js';
import { Haptics } from './haptics.js';
import { getApiBase } from './config.js';
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

function ensurePersonalTasteStoreListener() {
  if (_tasteListenerBound) return;
  _tasteListenerBound = true;
  store.subscribe(() => {
    const epochBefore = _personalTasteEpoch;
    syncPersonalTasteEpochFromStore();
    if (
      _personalTasteEpoch !== epochBefore &&
      discoveryUI.container &&
      discoveryUI.currentView === 'home'
    ) {
      void discoveryUI.renderHome();
    }
  });
}

function ensurePersonalRailRefreshTimer() {
  if (_personalRailIntervalId != null || typeof window === 'undefined') return;
  _personalRailIntervalId = window.setInterval(() => {
    _personalRailTimerGen += 1;
    if (discoveryUI.container && discoveryUI.currentView === 'home') {
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

    const queries = [];
    const seenQ = new Set();
    const pushQ = (q) => {
      const s = (q || '').trim();
      if (s.length < 2) return;
      const k = s.toLowerCase();
      if (seenQ.has(k)) return;
      seenQ.add(k);
      queries.push(s);
    };

    if (shH.length && shF.length) {
      for (let i = 0; i < 3 && i < shH.length; i++) {
        pushQ(`${shH[i].title} ${(shH[i].artist || '').trim()}`.trim());
      }
      for (let i = 0; i < 3 && i < shF.length; i++) {
        const t = shF[i];
        pushQ(`${(t.title || '').trim()} ${(t.album_artist || t.artist || '').trim()}`.trim());
      }
    } else if (shH.length) {
      for (let i = 0; i < 6 && i < shH.length; i++) {
        pushQ(`${shH[i].title} ${(shH[i].artist || '').trim()}`.trim());
      }
    } else if (shF.length) {
      for (let i = 0; i < 6 && i < shF.length; i++) {
        const t = shF[i];
        pushQ(`${(t.title || '').trim()} ${(t.album_artist || t.artist || '').trim()}`.trim());
      }
    }

    if (!queries.length) return [];

    const merged = [];
    const seenDeezer = new Set();
    for (const q of queries.slice(0, 8)) {
      const data = await this.fetchDeezer(`/search?q=${encodeURIComponent(q)}&limit=5`);
      if (!data || !Array.isArray(data.data) || !data.data.length) continue;
      const first = data.data[0];
      const aid = first?.artist?.id;
      if (aid == null) continue;
      const top = await this.fetchDeezer(`/artist/${aid}/top?limit=15`);
      if (!top || !Array.isArray(top.data)) continue;
      for (const tr of top.data) {
        const n = this.normalizeTrack(tr);
        if (seenDeezer.has(n.deezerId)) continue;
        seenDeezer.add(n.deezerId);
        merged.push(n);
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
  }

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.renderHome();
  }

  async renderHome() {
    this.currentView = 'home';
    if (!this.container) return;
    this.container.innerHTML = '<div class="discovery-loading text-center py-10 text-[var(--text-dim)]">Loading discoveries...</div>';

    const [personalTracks, { topTracks, gridPlaylists }] = await Promise.all([
      getPersonalizedRailTracks(18),
      discoveryService.fetchDiscoverHome(50, 12)
    ]);
    discoveryService.currentTracks = topTracks;

    const list = topTracks.slice(0, 12);
    const personalShow = personalTracks.slice(0, 12);
    window._discoverSurfaceTracks = [...personalShow, ...list];
    this.container.innerHTML = `
      <div class="discovery-home space-y-8 pb-8">
        <section>
          <h2 class="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">Recommended for you</h2>
          <div id="discovery-personal-tracks" class="space-y-1"></div>
        </section>
        <section>
          <h2 class="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">Today's Top Hits</h2>
          <div id="discovery-home-top-tracks" class="space-y-1"></div>
        </section>
        <section>
          <h2 class="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">Trending playlists</h2>
          <div id="discovery-playlist-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 content-start"></div>
        </section>
      </div>`;
    const personalEl = this.container.querySelector('#discovery-personal-tracks');
    const tracksEl = this.container.querySelector('#discovery-home-top-tracks');
    const grid = this.container.querySelector('#discovery-playlist-grid');
    if (personalEl) {
      if (!personalShow.length) {
        personalEl.innerHTML =
          '<p class="text-sm text-[var(--text-dim)] py-2">Play tracks from your library and add favourites to see picks tailored to you.</p>';
      } else {
        renderers.renderSongList(personalShow, personalEl, {
          getCoverUrl: (t) => (typeof t.cover === 'string' && t.cover) ? t.cover : '',
          discoverDeezerSurface: true
        });
      }
    }
    if (tracksEl) {
      renderers.renderSongList(list, tracksEl, {
        getCoverUrl: (t) => (typeof t.cover === 'string' && t.cover) ? t.cover : '',
        discoverDeezerSurface: true
      });
    }
    if (grid) {
      if (!gridPlaylists.length) {
        grid.innerHTML = '<p class="text-sm text-[var(--text-dim)] col-span-full">No playlists in this chart right now.</p>';
      } else {
        grid.innerHTML = renderers.buildDeezerPlaylistCardsHtml(
          gridPlaylists.map((pl) => ({
            id: pl.id,
            title: pl.title,
            cover: pl.cover,
            trackCount: pl.trackCount
          }))
        );
      }
    }
    this.bindEvents();
  }

  async renderSearchResults(query) {
    this.currentView = 'search';
    if (!this.container) return;
    this.container.innerHTML = '<div class="discovery-loading text-center py-10 text-[var(--text-dim)]">Searching...</div>';

    const tracks = await discoveryService.search(query);
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
    const personalTracksEl = this.container.querySelector('#discovery-personal-tracks');
    if (personalTracksEl) bindDiscoverSurfaceQuickActionButtons(personalTracksEl);
    const topTracks = this.container.querySelector('#discovery-home-top-tracks');
    if (topTracks) bindDiscoverSurfaceQuickActionButtons(topTracks);
    const searchTracks = this.container.querySelector('#discovery-search-track-list');
    if (searchTracks) bindDiscoverSurfaceQuickActionButtons(searchTracks);
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
