/**
 * Discovery Service — Deezer metadata via Station proxy.
 * Browsers cannot call api.deezer.com (no CORS); the engine proxies allowlisted GET paths.
 */

import { store } from './store.js';
import { Haptics } from './haptics.js';
import { getApiBase } from './config.js';
import { searchService } from './search_service.js';
import { playPreview } from './preview_playback.js';
import * as renderers from './renderers.js';

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

/** Map ODST search row → shape expected by playPreview / addPreviewToQueue. */
function odstItemFromSearchRow(row) {
  if (!row || !isYoutubeVideoId(row.id)) return null;
  return {
    id: row.id,
    video_id: row.id,
    title: row.title || 'Unknown',
    artist: row.channel || row.artist || '',
    channel: row.channel || '',
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
  const q = `${trackLike.title || ''} ${artist}`.trim();
  if (!q) return null;
  let results;
  try {
    results = await searchService.query(q, { debounce: 0 });
  } catch {
    return null;
  }
  if (!results || !results.length) return null;
  for (const row of results) {
    const item = odstItemFromSearchRow(row);
    if (item) return item;
  }
  return null;
}

// Curated playlists for discovery (Spotify "Home" style)
const DISCOVERY_PLAYLISTS = [
  { id: '3155776842', title: 'Global Top 50', description: 'The hottest tracks worldwide', type: 'charts' },
  { id: '1963962142', title: 'Chill Hits', description: 'Relax and unwind', type: 'mood' },
  { id: '1479458365', title: 'Hip-Hop Central', description: 'The best in hip-hop', type: 'genre' },
  { id: '1306932615', title: 'Rock Classics', description: 'Legendary rock anthems', type: 'genre' },
  { id: '908622995', title: 'Electronic Rising', description: 'New electronic music', type: 'genre' },
  { id: '599273585', title: 'Workout Beast', description: 'Fuel your workout', type: 'mood' },
  { id: '498538565', title: 'Focus Flow', description: 'Concentration music', type: 'mood' },
  { id: '354949861', title: 'Party Anthems', description: 'Get the party started', type: 'mood' },
  { id: '749497422', title: 'Indie Mix', description: 'Alternative discoveries', type: 'genre' },
  { id: '1109731', title: 'Jazz Vibes', description: 'Smooth jazz collection', type: 'genre' }
];

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
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    try {
      const response = await fetch(deezerProxyUrl(endpoint));
      if (!response.ok) throw new Error('Deezer API error');

      const data = await response.json();

      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });

      return data;
    } catch (error) {
      console.error('Discovery fetch error:', error);
      return null;
    }
  }

  /**
   * Fetch curated playlists (Home section)
   */
  async fetchPlaylists() {
    const playlists = [];

    for (const playlist of DISCOVERY_PLAYLISTS) {
      const data = await this.fetchDeezer(`/playlist/${playlist.id}`);
      if (data) {
        playlists.push({
          id: data.id,
          title: data.title,
          description: playlist.description,
          cover: deezerCoverUrl(data),
          trackCount: data.nb_tracks || 0,
          tracks: data.tracks?.data || []
        });
      }
    }

    return playlists;
  }

  /**
   * Fetch top tracks for quick add
   */
  async fetchTopTracks(limit = 50) {
    const data = await this.fetchDeezer(`/chart?limit=${limit}`);
    if (!data || !data.tracks) return [];

    return data.tracks.data.map(track => this.normalizeTrack(track));
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
   * Pre-warm cache with top tracks and playlists
   */
  async warmCache() {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      await Promise.all([
        this.fetchTopTracks(30),
        this.fetchPlaylists()
      ]);
    } finally {
      this.isLoading = false;
    }
  }
}

export const discoveryService = new DiscoveryService();

async function trackLikeForDeezerId(deezerId) {
  const idStr = String(deezerId);
  const cached = discoveryService.getCachedTracks().find((t) => String(t.deezerId) === idStr);
  if (cached) return cached;
  const data = await discoveryService.fetchDeezer(`/track/${deezerId}`);
  if (!data) return null;
  return {
    title: data.title || 'Unknown',
    artist: typeof data.artist === 'string' ? data.artist : (data.artist?.name || ''),
    deezerId: data.id,
    duration: data.duration || 0,
    cover: deezerCoverUrl(data.album)
  };
}

/** YouTube preview playback for a Deezer numeric id (used from Library-style rows / playTrack). */
export async function playDeezerTrackByNumericId(deezerId) {
  Haptics.tick();
  const trackLike = await trackLikeForDeezerId(deezerId);
  if (!trackLike) {
    window.showToast?.('Could not load track');
    return;
  }
  const item = await resolveDeezerTrackToOdstItem(trackLike);
  if (!item) {
    window.showToast?.('No YouTube match — try search above');
    return;
  }
  playPreview(item);
}

export async function addDeezerTrackToQueueByNumericId(deezerId) {
  Haptics.tick();
  const trackLike = await trackLikeForDeezerId(deezerId);
  if (!trackLike) {
    window.showToast?.('Could not load track');
    return;
  }
  const item = await resolveDeezerTrackToOdstItem(trackLike);
  if (!item) {
    window.showToast?.('No YouTube match — try search above');
    return;
  }
  const ok = await store.addPreviewToQueue(item);
  window.showToast?.(ok ? 'Added to queue' : 'Could not add to queue');
}

/** Open Deezer playlist in the same shell as native playlists (mobile + desktop). */
export async function openDeezerPlaylistById(playlistId) {
  const data = await discoveryService.fetchDeezer(`/playlist/${playlistId}`);
  if (!data) return;
  const tracks = (data.tracks?.data || []).map((t) => discoveryService.normalizeTrack(t));
  window._deezerPlaylistDetail = {
    deezerPlaylistId: data.id,
    title: data.title || 'Playlist',
    subtitle: typeof data.description === 'string' ? data.description.trim() : '',
    coverUrl: deezerCoverUrl(data),
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
    this.bindEvents();
  }

  async renderHome() {
    this.currentView = 'home';
    if (!this.container) return;
    this.container.innerHTML = '<div class="discovery-loading text-center py-10 text-[var(--text-dim)]">Loading discoveries...</div>';

    const playlists = await discoveryService.fetchPlaylists();
    const topTracks = await discoveryService.fetchTopTracks();
    discoveryService.currentTracks = topTracks;

    const list = topTracks.slice(0, 12);
    window._discoverSurfaceTracks = list;
    this.container.innerHTML = `
      <div class="discovery-home space-y-8 pb-8">
        <section>
          <h2 class="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">Today's Top Hits</h2>
          <div id="discovery-home-top-tracks" class="space-y-1"></div>
        </section>
        <section>
          <h2 class="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">Browse by Mood & Genre</h2>
          <div id="discovery-playlist-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 content-start"></div>
        </section>
      </div>`;
    const tracksEl = this.container.querySelector('#discovery-home-top-tracks');
    const grid = this.container.querySelector('#discovery-playlist-grid');
    if (tracksEl) {
      renderers.renderSongList(list, tracksEl, {
        getCoverUrl: (t) => (typeof t.cover === 'string' && t.cover) ? t.cover : '',
        discoverDeezerSurface: true
      });
    }
    if (grid) {
      grid.innerHTML = renderers.buildDeezerPlaylistCardsHtml(
        playlists.map((pl) => ({
          id: pl.id,
          title: pl.title,
          cover: pl.cover,
          trackCount: pl.trackCount
        }))
      );
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
  }
}

export const discoveryUI = new DiscoveryUI();

/**
 * Initialize discovery view
 */
export function initDiscovery(containerId) {
  discoveryUI.init(containerId);

  // Pre-warm cache in background
  discoveryService.warmCache();
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
